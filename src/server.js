import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { detectAgents, buildAgentInvocation, summarizeAgentEvent } from './lib/adapters.js';
import { evaluateAutoApproval, validatePolicy } from './lib/policy.js';
import { ProcessManager } from './lib/process-manager.js';
import { failedDependencies, selectDependencyBlocked, unmetDependencies, validateDependencies } from './lib/scheduler.js';
import { JsonStore } from './lib/store.js';
import { inspectWorkspace } from './lib/workspace.js';
import { clampText, id, now, publicError, readJsonBody } from './lib/utils.js';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(sourceDir, '..');
const publicDir = path.join(projectDir, 'public');
const dataFile = path.join(projectDir, '.conclave', 'state.json');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

// Loopback-only. Reject any other Host (e.g. an attacker's DNS-rebinding domain
// that resolves to 127.0.0.1) so the local API cannot be reached cross-host.
function isTrustedHost(host) {
  const hostname = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

// Block cross-site requests: browsers attach Origin to cross-origin writes, so a
// present-but-mismatched Origin is a CSRF attempt.
function isTrustedOrigin(origin, host) {
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

function routeMatch(pathname, expression) {
  return pathname.match(expression);
}

// The API projection strips captured output from executions (each can hold up to
// 120k chars) so /api/state stays small; full output is served per-execution.
const STATE_EXECUTION_LIMIT = 200;
const OUTPUT_TAIL_CHARS = 500;

function projectStateForApi(state) {
  const executionsTotal = state.executions.length;
  const executions = state.executions.slice(0, STATE_EXECUTION_LIMIT).map((execution) => {
    const { output, ...rest } = execution;
    const text = output || '';
    return { ...rest, outputSize: text.length, outputTail: text.slice(-OUTPUT_TAIL_CHARS) };
  });
  return { ...state, executions, executionsTotal };
}

function displayInvocation(invocation) {
  const quote = (value) => /\s/.test(String(value)) ? JSON.stringify(String(value)) : String(value);
  return [invocation.command, ...invocation.args].map(quote).join(' ');
}

export function promptForTask(task, agent, state) {
  const teammates = state.agents
    .filter((entry) => entry.id !== agent.id && entry.status === 'installed')
    .map((entry) => {
      const current = entry.currentTaskId && state.tasks.find((item) => item.id === entry.currentTaskId);
      return `- ${entry.name}: ${entry.activity}${current ? ` on “${clampText(current.title, 120)}”` : ''}`;
    });
  const recent = state.messages.slice(-8)
    .map((message) => `- ${message.sourceName}: ${clampText(message.content, 240)}`);
  return [
    `You are ${agent.name}, working alongside other coding agents in a Conclave room.`,
    `Workspace: ${state.room.workspace}`,
    `Access granted for this run: ${task.accessMode}.`,
    `Task: ${task.title}`,
    ...(task.objective.trim() === task.title.trim() ? [] : [task.objective]),
    ...(task.source ? ['', 'Source message this task was promoted from:', `- ${task.source.sourceName}: ${clampText(task.source.content, 2_000)}`] : []),
    '',
    'Teammates in this room:',
    ...(teammates.length ? teammates : ['- none available']),
    '',
    'Recent room activity (newest last):',
    ...(recent.length ? recent : ['- none']),
    '',
    'Coordinate through the workspace: follow AGENTS.md, and update COORDINATION.md to claim files before editing them and to leave a handoff when done. Your final reply is posted to the room where teammates and the operator read it.',
    'Work only on this task and within the workspace. Report concrete conclusions, changes, commands, and validation evidence.',
    'Do not claim an action or result that did not occur. Do not expose secrets or hidden reasoning.',
    'Finish with a concise handoff that another agent or the human operator can verify.'
  ].join('\n');
}

export function promptForChat(message, agent, state) {
  const recent = state.messages.filter((entry) => entry.id !== message.id).slice(-11)
    .map((entry) => `- ${entry.sourceName}: ${clampText(entry.content, 320)}`);
  return [
    `You are ${agent.name}, participating in the general chat of a Conclave room.`,
    `Workspace: ${state.room.workspace}`,
    'This is one read-only conversational turn, not a coding task.',
    'Do not modify files, claim work, create tasks, or report that implementation was completed.',
    'If the operator is asking for code changes, explain that they should use Assign task or New task.',
    '',
    'Recent room conversation (newest last):',
    ...(recent.length ? recent : ['- none']),
    '',
    'Latest operator message:',
    clampText(message.content, 12_000),
    '',
    `Reply directly to that message as ${agent.name}. Keep the response useful and concise.`,
    'Do not expose secrets or hidden reasoning.'
  ].join('\n');
}

export class ConclaveApp {
  constructor({ workspace = projectDir, storeFile = dataFile } = {}) {
    this.clients = new Set();
    this.store = new JsonStore(storeFile, path.resolve(workspace));
    this.processes = new ProcessManager({ onEvent: (event) => this.onProcessEvent(event) });
    this.server = http.createServer((request, response) => this.handle(request, response));
  }

  async initialize() {
    await this.store.load();
    const verifiedAgents = new Set(this.store.state.executions
      .filter((execution) => ['agent', 'chat'].includes(execution.kind) && execution.status === 'completed')
      .map((execution) => execution.agentId));
    const agents = (await detectAgents()).map((agent) => verifiedAgents.has(agent.id)
      ? { ...agent, connection: 'verified', lastAction: 'Verified by a successful execution' }
      : agent);
    const workspace = await inspectWorkspace(this.store.state.room.workspace);
    await this.store.update((state) => {
      state.agents = agents;
      state.workspace = workspace;
      state.executions.filter((entry) => entry.status === 'running').forEach((entry) => {
        entry.status = 'interrupted';
        entry.finishedAt = now();
      });
      state.tasks.forEach((task) => {
        task.dependencies ??= [];
        task.attempts ??= 0;
        if (task.status !== 'active' && task.status !== 'ready') return;
        task.blocker = task.status === 'active'
          ? 'Conclave restarted while this task was active.'
          : 'Conclave restarted while this task was queued.';
        task.status = 'blocked';
        task.updatedAt = now();
      });
      state.chatTurns.forEach((turn) => {
        if (turn.status !== 'active' && turn.status !== 'queued') return;
        const previousStatus = turn.status;
        turn.status = 'interrupted';
        turn.blocker = previousStatus === 'active'
          ? 'Conclave restarted while this chat turn was active.'
          : 'Conclave restarted while this chat turn was queued.';
        turn.updatedAt = now();
      });
    });
  }

  broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  async onProcessEvent(event) {
    await this.store.update(async (state) => {
      if (event.type === 'execution.started') {
        state.executions.unshift(event.execution);
      }
      if (event.type === 'execution.output') {
        const execution = state.executions.find((entry) => entry.id === event.executionId);
        const chatTurn = state.chatTurns.find((entry) => entry.executionId === event.executionId);
        if (execution) execution.output = clampText(`${execution.output}${event.stream === 'stderr' ? '[stderr] ' : ''}${event.line}\n`, 120_000);
        if (event.agentId) {
          const summary = summarizeAgentEvent(event.agentId, event.line);
          if (summary && !(chatTurn && summary.startsWith('Usage: '))) {
            const agent = state.agents.find((candidate) => candidate.id === event.agentId);
            const content = clampText(summary);
            const previous = state.messages.at(-1);
            if (previous?.source !== event.agentId || previous?.taskId !== event.taskId
              || previous?.chatTurnId !== chatTurn?.id || previous?.content !== content) {
              state.messages.push({
                id: id('msg'), source: event.agentId, sourceName: agent?.name || event.agentId,
                type: chatTurn ? 'message' : 'progress', content, taskId: event.taskId,
                chatTurnId: chatTurn?.id, createdAt: event.createdAt
              });
            }
          }
        }
      }
      if (event.type === 'execution.finished') {
        const execution = state.executions.find((entry) => entry.id === event.executionId);
        const chatTurn = state.chatTurns.find((entry) => entry.executionId === event.executionId);
        if (execution) Object.assign(execution, {
          status: event.status, exitCode: event.exitCode, signal: event.signal, finishedAt: event.finishedAt
        });
        if (event.taskId) {
          const task = state.tasks.find((entry) => entry.id === event.taskId);
          if (task) {
            // Autopilot governs tasks and commands only — never chat turns.
            const live = state.policy?.enabled && !state.room.paused;
            if (event.status === 'completed') {
              const autoResolve = task.origin === 'message' && task.accessMode === 'read-only';
              const autoAccept = !autoResolve && live && state.policy.autoAcceptReviews;
              task.status = autoResolve || autoAccept ? 'completed' : 'review-required';
              if (autoAccept) {
                state.audit.push({
                  id: id('audit'), type: 'task.auto-accepted', taskId: task.id, executionId: event.executionId,
                  decidedBy: 'autopilot', createdAt: now()
                });
                state.messages.push({
                  id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'autopilot',
                  content: clampText(`Autopilot accepted “${task.title}” after a successful run.`),
                  taskId: task.id, createdAt: event.finishedAt
                });
              }
            } else if (event.status === 'failed') {
              // Auto-retry applies to failed runs only, never to cancelled ones.
              const gate = live && state.policy.autoRetry.enabled;
              if (gate && (task.attempts ?? 0) < state.policy.autoRetry.maxAttempts) {
                task.attempts = (task.attempts ?? 0) + 1;
                task.status = 'ready';
                task.blocker = null;
                state.audit.push({
                  id: id('audit'), type: 'task.auto-retried', taskId: task.id, executionId: event.executionId,
                  decidedBy: 'autopilot', detail: `retry ${task.attempts} of ${state.policy.autoRetry.maxAttempts}`, createdAt: now()
                });
                state.messages.push({
                  id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'autopilot',
                  content: clampText(`Autopilot re-queued “${task.title}” after a failed run (retry ${task.attempts} of ${state.policy.autoRetry.maxAttempts}).`),
                  taskId: task.id, createdAt: event.finishedAt
                });
              } else {
                task.status = 'failed';
                if (gate && (task.attempts ?? 0) >= state.policy.autoRetry.maxAttempts) {
                  task.blocker = `Automatic retries exhausted after ${task.attempts} retries.`;
                }
              }
            } else {
              task.status = event.status;
            }
            task.updatedAt = event.finishedAt;
            task.executionId = event.executionId;
          }
        }
        if (chatTurn) Object.assign(chatTurn, {
          status: event.status, blocker: event.status === 'completed' ? null : `Agent run ${event.status}.`,
          updatedAt: event.finishedAt, executionId: event.executionId
        });
        if (event.agentId) {
          const agent = state.agents.find((entry) => entry.id === event.agentId);
          if (agent) Object.assign(agent, {
            activity: 'idle', currentTaskId: null, currentChatTurnId: null,
            connection: event.status === 'completed' ? 'verified' : event.status === 'cancelled' ? agent.connection : 'error',
            lastAction: chatTurn
              ? event.status === 'completed' ? 'Replied in general chat' : `Chat reply ${event.status}`
              : event.status === 'completed' ? 'Run finished; awaiting review' : `Run ${event.status}`
          });
        }
        if (chatTurn) {
          if (event.status !== 'completed') {
            const agent = state.agents.find((entry) => entry.id === event.agentId);
            state.messages.push({
              id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'blocker',
              content: `${agent?.name || event.agentId} could not reply because the chat run ${event.status}.`,
              chatTurnId: chatTurn.id, executionId: event.executionId, createdAt: event.finishedAt
            });
          }
        } else {
          state.messages.push({
            id: id('msg'), source: 'system', sourceName: 'Conclave', type: event.status === 'completed' ? 'review' : 'blocker',
            content: `Execution ${event.status}${event.exitCode === null ? '' : ` with exit code ${event.exitCode}`}.`,
            taskId: event.taskId, executionId: event.executionId, createdAt: event.finishedAt
          });
          try {
            state.workspace = await inspectWorkspace(state.room.workspace);
          } catch (error) {
            state.audit.push({ id: id('audit'), type: 'workspace.refresh-failed', detail: publicError(error), createdAt: now() });
          }
        }
      }
      const chatTurn = state.chatTurns.find((entry) => entry.executionId === event.executionId);
      state.audit.push({
        id: id('audit'), type: event.type, executionId: event.executionId,
        taskId: event.taskId, chatTurnId: chatTurn?.id, createdAt: now()
      });
      if (state.audit.length > 2_000) state.audit.splice(0, state.audit.length - 2_000);
    });
    const chatTurn = this.store.state.chatTurns.find((entry) => entry.executionId === event.executionId);
    this.broadcast({
      type: 'state.changed', reason: event.type,
      executionId: event.executionId || event.execution?.id,
      taskId: event.taskId || event.execution?.taskId,
      chatTurnId: chatTurn?.id,
      createdAt: event.createdAt || event.finishedAt || event.execution?.startedAt || now()
    });
    if (event.type === 'execution.finished') await this.startQueuedTasks();
  }

  // Mutation applied to a task whose dependencies can never complete. Runs
  // inside a store.update mutator. A blocked task can never be started from its
  // approval, so any pending gate expires (a requeue mints a fresh one).
  blockForDependencies(state, task, blocker) {
    Object.assign(task, { status: 'blocked', blocker, updatedAt: now() });
    state.approvals.filter((entry) => entry.taskId === task.id && entry.status === 'pending')
      .forEach((entry) => Object.assign(entry, { status: 'expired', decidedAt: now(), decidedBy: 'system', reason: blocker }));
    state.audit.push({ id: id('audit'), type: 'task.dependency-blocked', taskId: task.id, detail: blocker, createdAt: now() });
    state.messages.push({
      id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'blocker',
      content: clampText(`“${task.title}” is blocked: ${blocker}`), taskId: task.id, createdAt: now()
    });
  }

  // Blocks every ready/waiting task whose dependencies reached a terminal bad
  // status (failed/rejected/cancelled) or vanished. Idempotent.
  async applyDependencyBlocks() {
    if (!selectDependencyBlocked(this.store.state.tasks).length) return;
    const blocked = await this.store.update((state) => {
      const hits = selectDependencyBlocked(state.tasks);
      for (const hit of hits) {
        this.blockForDependencies(state, state.tasks.find((entry) => entry.id === hit.id), hit.blocker);
      }
      return hits.map((entry) => entry.id);
    });
    for (const taskId of blocked) this.broadcast({ type: 'state.changed', reason: 'task.dependency-blocked', taskId });
  }

  async startQueuedTasks() {
    await this.applyDependencyBlocks();
    const attempted = new Set();
    while (true) {
      const state = this.store.state;
      if (state.room.paused) return;
      if (this.processes.running.size >= state.room.limits.maxConcurrentRuns) return;
      const busyAgents = new Set(state.agents.filter((entry) => entry.activity === 'running').map((entry) => entry.id));
      const writerActive = state.tasks.some((entry) => entry.status === 'active' && entry.accessMode === 'workspace-write');
      const tasksById = new Map(state.tasks.map((entry) => [entry.id, entry]));
      const candidates = [
        ...state.tasks.filter((entry) => entry.status === 'ready'
          && !attempted.has(`task:${entry.id}`)
          && !busyAgents.has(entry.agentId)
          && !(entry.accessMode === 'workspace-write' && writerActive)
          && unmetDependencies(tasksById, entry).length === 0)
          .map((entry) => ({ kind: 'task', entry })),
        ...state.chatTurns.filter((entry) => entry.status === 'queued'
          && !attempted.has(`chat:${entry.id}`)
          && !busyAgents.has(entry.agentId))
          .map((entry) => ({ kind: 'chat', entry }))
      ].sort((left, right) => left.entry.createdAt.localeCompare(right.entry.createdAt));
      const queued = candidates[0];
      if (!queued) return;
      attempted.add(`${queued.kind}:${queued.entry.id}`);
      try {
        if (queued.kind === 'task') await this.startTask(queued.entry.id);
        else await this.startChatTurn(queued.entry.id);
      } catch (error) {
        await this.store.update((next) => {
          if (queued.kind === 'task') {
            const liveTask = next.tasks.find((entry) => entry.id === queued.entry.id);
            if (liveTask) Object.assign(liveTask, { status: 'blocked', blocker: publicError(error), updatedAt: now() });
          } else {
            const liveTurn = next.chatTurns.find((entry) => entry.id === queued.entry.id);
            if (liveTurn) Object.assign(liveTurn, { status: 'failed', blocker: publicError(error), updatedAt: now() });
          }
          next.audit.push({
            id: id('audit'), type: `${queued.kind}.queue-start-failed`,
            taskId: queued.kind === 'task' ? queued.entry.id : undefined,
            chatTurnId: queued.kind === 'chat' ? queued.entry.id : undefined,
            detail: publicError(error), createdAt: now()
          });
        });
        this.broadcast({
          type: 'state.changed', reason: `${queued.kind}.blocked`,
          taskId: queued.kind === 'task' ? queued.entry.id : undefined,
          chatTurnId: queued.kind === 'chat' ? queued.entry.id : undefined
        });
      }
    }
  }

  async startTask(taskId) {
    const state = this.store.snapshot();
    const task = state.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error('Task not found');
    const agent = state.agents.find((entry) => entry.id === task.agentId);
    if (!agent || agent.status !== 'installed') throw new Error('Assigned agent is unavailable');
    const activeWriter = task.accessMode === 'workspace-write'
      ? state.tasks.find((entry) =>
        entry.id !== task.id && entry.status === 'active' && entry.accessMode === 'workspace-write')
      : null;
    const agentBusyOn = state.tasks.find((entry) =>
      entry.id !== task.id && entry.status === 'active' && entry.agentId === task.agentId);
    const agentBusyChat = state.chatTurns.find((entry) => entry.status === 'active' && entry.agentId === task.agentId);
    const tasksById = new Map(state.tasks.map((entry) => [entry.id, entry]));
    const unmet = unmetDependencies(tasksById, task);
    const waitReason = state.room.paused ? 'the room resumes'
      : unmet.length ? `it is no longer waiting on “${tasksById.get(unmet[0])?.title ?? unmet[0]}”`
      : activeWriter ? `“${activeWriter.title}” releases the workspace; one agent writes at a time`
      : agentBusyOn ? `${agent.name} finishes “${agentBusyOn.title}”; one run per agent at a time`
      : agentBusyChat || agent.activity === 'running' ? `${agent.name} finishes the current chat reply; one run per agent at a time`
      : this.processes.running.size >= state.room.limits.maxConcurrentRuns ? 'a concurrent run slot frees up'
      : null;
    if (waitReason) {
      await this.store.update((next) => {
        const liveTask = next.tasks.find((entry) => entry.id === taskId);
        liveTask.status = 'ready';
        liveTask.updatedAt = now();
        next.messages.push({
          id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
          content: `Queued “${task.title}” until ${waitReason}.`,
          taskId, createdAt: now()
        });
      });
      this.broadcast({ type: 'state.changed', reason: 'task.queued', taskId });
      return null;
    }
    const invocation = buildAgentInvocation(agent.id, {
      executable: agent.executable,
      prompt: promptForTask(task, agent, state),
      workspace: state.room.workspace,
      accessMode: task.accessMode
    });
    await this.store.update((next) => {
      const liveTask = next.tasks.find((entry) => entry.id === taskId);
      liveTask.status = 'active';
      liveTask.updatedAt = now();
      const liveAgent = next.agents.find((entry) => entry.id === task.agentId);
      liveAgent.activity = 'running';
      liveAgent.currentTaskId = taskId;
      liveAgent.currentChatTurnId = null;
      liveAgent.lastAction = task.title;
      next.messages.push({
        id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'delegation',
        content: `Assigned “${task.title}” to ${liveAgent.name} with ${task.accessMode} access.`, taskId, createdAt: now()
      });
    });
    const execution = this.processes.start({
      taskId, agentId: agent.id, invocation, cwd: state.room.workspace, purpose: task.objective
    });
    await this.store.update((next) => {
      const liveTask = next.tasks.find((entry) => entry.id === taskId);
      liveTask.executionId = execution.id;
    });
    this.broadcast({ type: 'state.changed', reason: 'task.started', taskId });
    return execution;
  }

  async startChatTurn(chatTurnId) {
    const state = this.store.snapshot();
    const turn = state.chatTurns.find((entry) => entry.id === chatTurnId);
    if (!turn) throw new Error('Chat turn not found');
    const agent = state.agents.find((entry) => entry.id === turn.agentId);
    if (!agent || agent.status !== 'installed') throw new Error('Selected agent is unavailable');
    const waitReason = state.room.paused || agent.activity === 'running'
      || this.processes.running.size >= state.room.limits.maxConcurrentRuns;
    if (waitReason) return null;
    const message = state.messages.find((entry) => entry.id === turn.messageId);
    if (!message) throw new Error('Chat message not found');
    const invocation = buildAgentInvocation(agent.id, {
      executable: agent.executable,
      prompt: promptForChat(message, agent, state),
      workspace: state.room.workspace,
      accessMode: 'read-only'
    });
    await this.store.update((next) => {
      const liveTurn = next.chatTurns.find((entry) => entry.id === chatTurnId);
      liveTurn.status = 'active';
      liveTurn.blocker = null;
      liveTurn.updatedAt = now();
      const liveAgent = next.agents.find((entry) => entry.id === turn.agentId);
      liveAgent.activity = 'running';
      liveAgent.currentTaskId = null;
      liveAgent.currentChatTurnId = chatTurnId;
      liveAgent.lastAction = 'Replying in general chat';
    });
    const execution = this.processes.start({
      taskId: null, agentId: agent.id, kind: 'chat', invocation,
      cwd: state.room.workspace, purpose: message.content
    });
    await this.store.update((next) => {
      const liveTurn = next.chatTurns.find((entry) => entry.id === chatTurnId);
      liveTurn.executionId = execution.id;
    });
    this.broadcast({ type: 'state.changed', reason: 'chat.started', chatTurnId });
    return execution;
  }

  async createChatTurn(message, agent, { retryOf = null } = {}) {
    const createdAt = now();
    const turn = {
      id: id('chat'), messageId: message.id, agentId: agent.id, status: 'queued',
      blocker: null, executionId: null, retryOf, createdAt, updatedAt: createdAt
    };
    await this.store.update((state) => {
      state.chatTurns.unshift(turn);
      state.audit.push({ id: id('audit'), type: 'chat.created', chatTurnId: turn.id, agentId: agent.id, createdAt });
    });
    this.broadcast({ type: 'state.changed', reason: 'chat.created', chatTurnId: turn.id });
    await this.startChatTurn(turn.id);
    return turn;
  }

  // Fresh pending workspace-write approval for a task. Runs inside store.update.
  buildWriteApproval(state, task, agent) {
    const preview = buildAgentInvocation(agent.id, {
      executable: agent.executable,
      prompt: promptForTask(task, agent, state),
      workspace: state.room.workspace,
      accessMode: task.accessMode
    });
    return {
      id: id('approval'), type: 'agent-write', status: 'pending', taskId: task.id, agentId: agent.id,
      title: `${agent.name} requests workspace-write access`,
      detail: task.objective, impact: `May create or modify files under ${state.room.workspace}. The agent sandbox remains scoped to the workspace.`,
      command: displayInvocation(preview), cwd: state.room.workspace, createdAt: now(), decidedAt: null, decidedBy: null, reason: null
    };
  }

  // Marks an approval as decided by the operator-authored policy. Runs inside
  // store.update. Agents never approve their own authority — the policy is the
  // operator's standing decision.
  recordAutoApproval(state, approval, { reason, taskId = null, agentId = null, subject }) {
    Object.assign(approval, { status: 'auto-approved', decidedAt: now(), decidedBy: 'autopilot', reason });
    state.audit.push({
      id: id('audit'), type: 'approval.auto-approved', approvalId: approval.id,
      taskId, agentId, decidedBy: 'autopilot', reason, createdAt: approval.decidedAt
    });
    state.messages.push({
      id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'autopilot',
      content: clampText(`Autopilot approved ${subject}: ${reason}.`), taskId, createdAt: approval.decidedAt
    });
  }

  // Rolls a decided approval back to pending after startTask throws, so the
  // request is recoverable from the Approval Center instead of being consumed.
  async revertFailedStart(taskId, approvalId, error, type) {
    const detail = publicError(error);
    await this.store.update((state) => {
      const approval = state.approvals.find((entry) => entry.id === approvalId);
      if (approval && ['approved', 'auto-approved'].includes(approval.status)) {
        Object.assign(approval, { status: 'pending', decidedAt: null, decidedBy: null, reason: null });
      }
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (task?.status === 'active' && !task.executionId) {
        Object.assign(task, { status: 'waiting', updatedAt: now() });
        const agent = state.agents.find((entry) => entry.id === task.agentId);
        if (agent?.currentTaskId === taskId) Object.assign(agent, { activity: 'idle', currentTaskId: null });
      }
      state.audit.push({ id: id('audit'), type, approvalId, taskId, detail, createdAt: now() });
      state.messages.push({
        id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'autopilot',
        content: clampText(`Could not start the run (${detail}); the request was returned to the Approval Center for manual review.`),
        taskId, createdAt: now()
      });
    });
    this.broadcast({ type: 'state.changed', reason: type, taskId });
  }

  async startTaskViaAutopilot(taskId, approvalId) {
    try { await this.startTask(taskId); }
    catch (error) { await this.revertFailedStart(taskId, approvalId, error, 'autopilot.start-failed'); }
  }

  async createTask(input) {
    const title = clampText(input.title || 'Untitled task', 160).trim();
    const objective = clampText(input.objective, 12_000).trim();
    const accessMode = input.accessMode === 'workspace-write' ? 'workspace-write' : 'read-only';
    if (!objective) throw new Error('Task objective is required');
    const agent = this.store.state.agents.find((entry) => entry.id === input.agentId);
    if (!agent) throw new Error('Select a supported agent');
    if (agent.status !== 'installed') throw new Error(`${agent.name} is unavailable`);
    const priority = ['critical', 'high', 'medium', 'low', 'none'].includes(input.priority) ? input.priority : 'none';
    const dependencies = validateDependencies(this.store.state.tasks, input.dependencies, null);
    const createdAt = now();
    const task = {
      id: id('task'), title, objective, agentId: agent.id, accessMode, priority,
      origin: ['message', 'promoted'].includes(input.origin) ? input.origin : 'operator',
      source: input.source || null, archivedAt: null,
      status: accessMode === 'workspace-write' ? 'waiting' : 'ready',
      dependencies, attempts: 0, blocker: null, executionId: null, createdAt, updatedAt: createdAt
    };
    const outcome = await this.store.update((state) => {
      state.tasks.unshift(task);
      state.audit.push({ id: id('audit'), type: 'task.created', taskId: task.id, agentId: agent.id, createdAt });
      const approval = accessMode === 'workspace-write' ? this.buildWriteApproval(state, task, agent) : null;
      if (approval) state.approvals.unshift(approval);
      const failed = failedDependencies(new Map(state.tasks.map((entry) => [entry.id, entry])), task);
      if (failed.length) {
        this.blockForDependencies(state, task, failed.join(' '));
        return { blocked: true, autoApprovedId: null };
      }
      if (approval) {
        const verdict = evaluateAutoApproval(state, approval, { running: this.processes.running.size });
        if (verdict.code === 'rate-capped') {
          state.audit.push({ id: id('audit'), type: 'autopilot.rate-capped', approvalId: approval.id, createdAt: now() });
        }
        if (verdict.allow) {
          this.recordAutoApproval(state, approval, {
            reason: verdict.reason, taskId: task.id, agentId: agent.id,
            subject: `workspace-write for ${agent.name} on “${task.title}”`
          });
          return { blocked: false, autoApprovedId: approval.id };
        }
      }
      return { blocked: false, autoApprovedId: null };
    });
    this.broadcast({ type: 'state.changed', reason: 'task.created', taskId: task.id });
    if (outcome.autoApprovedId) await this.startTaskViaAutopilot(task.id, outcome.autoApprovedId);
    else if (!outcome.blocked && accessMode === 'read-only') await this.startTask(task.id);
    return task;
  }

  async decideApproval(approvalId, decision) {
    if (!['approved', 'denied'].includes(decision)) throw new Error('Decision must be approved or denied');
    let approval;
    await this.store.update((state) => {
      approval = state.approvals.find((entry) => entry.id === approvalId);
      if (!approval) throw new Error('Approval request not found');
      if (approval.status !== 'pending') throw new Error('Approval request was already decided');
      approval.status = decision;
      approval.decidedAt = now();
      approval.decidedBy = 'user';
      state.audit.push({ id: id('audit'), type: `approval.${decision}`, approvalId, createdAt: approval.decidedAt });
      if (approval.taskId && decision === 'denied') {
        const task = state.tasks.find((entry) => entry.id === approval.taskId);
        if (task) Object.assign(task, { status: 'rejected', updatedAt: approval.decidedAt });
      }
    });
    if (decision === 'approved') {
      if (approval.type === 'agent-write') await this.startTask(approval.taskId);
      if (approval.type === 'command') this.startCommand(approval);
    } else if (approval.taskId) {
      // A rejected task is a terminally-bad dependency: re-evaluate dependents.
      await this.startQueuedTasks();
    }
    this.broadcast({ type: 'state.changed', reason: `approval.${decision}`, approvalId });
    return approval;
  }

  startCommand(approval) {
    const invocation = process.platform === 'win32'
      ? { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', approval.command] }
      : { command: '/bin/sh', args: ['-lc', approval.command] };
    return this.processes.start({ kind: 'command', invocation, cwd: approval.cwd, purpose: approval.detail });
  }

  async handleApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/state') {
      return json(response, 200, projectStateForApi(this.store.snapshot()));
    }
    const outputMatch = routeMatch(url.pathname, /^\/api\/executions\/([^/]+)\/output$/);
    if (request.method === 'GET' && outputMatch) {
      const execution = this.store.state.executions.find((entry) => entry.id === outputMatch[1]);
      if (!execution) throw new Error('Execution not found');
      const output = execution.output || '';
      return json(response, 200, { id: execution.id, status: execution.status, outputSize: output.length, output });
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'
      });
      response.write(`data: ${JSON.stringify({ type: 'connected', createdAt: now() })}\n\n`);
      this.clients.add(response);
      request.on('close', () => this.clients.delete(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const task = await this.createTask(await readJsonBody(request));
      return json(response, 201, task);
    }
    if (request.method === 'POST' && url.pathname === '/api/messages') {
      const input = await readJsonBody(request);
      const content = clampText(input.content, 12_000).trim();
      if (!content) throw new Error('Message is required');
      const hasExplicitRecipients = Array.isArray(input.agentIds);
      const requestedIds = hasExplicitRecipients
        ? [...new Set(input.agentIds.filter((agentId) => typeof agentId === 'string'))]
        : this.store.state.agents
          .filter((agent) => new RegExp(`@${agent.id}\\b`, 'i').test(content))
          .map((agent) => agent.id);
      const recipients = requestedIds.map((agentId) => this.store.state.agents.find((agent) => agent.id === agentId));
      if (recipients.some((agent) => !agent)) throw new Error('Select a supported agent');
      if (recipients.some((agent) => agent.status !== 'installed')) throw new Error('A selected agent is unavailable');
      const maxTurns = this.store.state.room.limits.maxTurnsPerAgent;
      const saturated = recipients.find((agent) => this.store.state.chatTurns.filter((turn) =>
        turn.agentId === agent.id && ['active', 'queued'].includes(turn.status)).length >= maxTurns);
      if (saturated) throw new Error(`${saturated.name} already has ${maxTurns} chat replies pending`);
      const message = { id: id('msg'), source: 'user', sourceName: 'You', type: 'message', content, createdAt: now() };
      await this.store.update((state) => state.messages.push(message));
      for (const agent of recipients) {
        await this.createChatTurn(message, agent);
      }
      this.broadcast({ type: 'state.changed', reason: 'message.created', messageId: message.id });
      return json(response, 201, { message, tasksCreated: 0, chatTurnsCreated: recipients.length });
    }
    const promoteMatch = routeMatch(url.pathname, /^\/api\/messages\/([^/]+)\/promote$/);
    if (request.method === 'POST' && promoteMatch) {
      const message = this.store.state.messages.find((entry) => entry.id === promoteMatch[1]);
      if (!message) throw new Error('Message not found');
      const input = await readJsonBody(request);
      const task = await this.createTask({
        ...input,
        origin: 'promoted',
        source: {
          messageId: message.id, sourceName: message.sourceName,
          content: clampText(message.content, 12_000), createdAt: message.createdAt
        }
      });
      return json(response, 201, task);
    }
    const chatCancelMatch = routeMatch(url.pathname, /^\/api\/chat-turns\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && chatCancelMatch) {
      const turn = this.store.state.chatTurns.find((entry) => entry.id === chatCancelMatch[1]);
      if (!turn) throw new Error('Chat turn not found');
      if (turn.status === 'queued') {
        await this.store.update((state) => {
          const live = state.chatTurns.find((entry) => entry.id === turn.id);
          Object.assign(live, { status: 'cancelled', blocker: 'Cancelled by the operator before it started.', updatedAt: now() });
          state.audit.push({ id: id('audit'), type: 'chat.cancelled', chatTurnId: turn.id, createdAt: now() });
        });
        this.broadcast({ type: 'state.changed', reason: 'chat.cancelled', chatTurnId: turn.id });
        return json(response, 200, { status: 'cancelled' });
      }
      if (turn.status === 'active' && turn.executionId && this.processes.cancel(turn.executionId)) {
        return json(response, 202, { status: 'cancelling' });
      }
      throw new Error('Chat turn is not queued or running');
    }
    const chatRetryMatch = routeMatch(url.pathname, /^\/api\/chat-turns\/([^/]+)\/retry$/);
    if (request.method === 'POST' && chatRetryMatch) {
      const turn = this.store.state.chatTurns.find((entry) => entry.id === chatRetryMatch[1]);
      if (!turn) throw new Error('Chat turn not found');
      if (!['failed', 'interrupted', 'cancelled'].includes(turn.status)) {
        throw new Error('Only failed, interrupted, or cancelled chat replies can be retried');
      }
      const message = this.store.state.messages.find((entry) => entry.id === turn.messageId);
      if (!message) throw new Error('The original chat message no longer exists');
      const agent = this.store.state.agents.find((entry) => entry.id === turn.agentId);
      if (!agent || agent.status !== 'installed') throw new Error('The agent for this reply is unavailable');
      const retried = await this.createChatTurn(message, agent, { retryOf: turn.id });
      return json(response, 201, retried);
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks/archive-legacy') {
      const terminal = ['completed', 'failed', 'cancelled', 'rejected'];
      const archivedIds = [];
      await this.store.update((state) => {
        state.tasks.forEach((task) => {
          if (task.origin !== 'message' || !terminal.includes(task.status) || task.archivedAt) return;
          task.archivedAt = now();
          task.updatedAt = now();
          archivedIds.push(task.id);
        });
        if (archivedIds.length) {
          state.audit.push({
            id: id('audit'), type: 'task.legacy-archived',
            detail: { count: archivedIds.length, taskIds: archivedIds }, createdAt: now()
          });
        }
      });
      if (archivedIds.length) this.broadcast({ type: 'state.changed', reason: 'task.legacy-archived' });
      return json(response, 200, { archived: archivedIds.length });
    }
    const transitionMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/transitions$/);
    if (request.method === 'POST' && transitionMatch) {
      const input = await readJsonBody(request);
      const task = this.store.state.tasks.find((entry) => entry.id === transitionMatch[1]);
      if (!task) throw new Error('Task not found');
      if (task.status !== 'proposed' || input.to !== 'ready') {
        throw new Error(`Cannot transition '${task.status}' to '${String(input.to)}'; the only supported transition is proposed → ready`);
      }
      if (!String(task.objective || '').trim()) throw new Error('Task needs a non-empty objective before it can be marked ready');
      const agent = this.store.state.agents.find((entry) => entry.id === task.agentId);
      if (!agent || agent.status !== 'installed') throw new Error('Assigned agent is unavailable');
      await this.store.update((state) => {
        const live = state.tasks.find((entry) => entry.id === task.id);
        Object.assign(live, { status: 'ready', blocker: null, updatedAt: now() });
        state.audit.push({ id: id('audit'), type: 'task.transitioned', taskId: task.id, detail: 'proposed → ready', createdAt: now() });
      });
      this.broadcast({ type: 'state.changed', reason: 'task.transitioned', taskId: task.id });
      await this.startQueuedTasks();
      return json(response, 200, { ok: true });
    }
    const archiveMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/(archive|unarchive)$/);
    if (request.method === 'POST' && archiveMatch) {
      const archiving = archiveMatch[2] === 'archive';
      await this.store.update((state) => {
        const task = state.tasks.find((entry) => entry.id === archiveMatch[1]);
        if (!task) throw new Error('Task not found');
        if (archiving && !['completed', 'failed', 'cancelled', 'rejected'].includes(task.status)) {
          throw new Error('Only completed, failed, cancelled, or rejected tasks can be archived');
        }
        task.archivedAt = archiving ? now() : null;
        task.updatedAt = now();
        state.audit.push({ id: id('audit'), type: `task.${archiveMatch[2]}d`, taskId: task.id, createdAt: now() });
      });
      this.broadcast({ type: 'state.changed', reason: `task.${archiveMatch[2]}d`, taskId: archiveMatch[1] });
      return json(response, 200, { ok: true });
    }
    const executionCancelMatch = routeMatch(url.pathname, /^\/api\/executions\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && executionCancelMatch) {
      if (!this.processes.cancel(executionCancelMatch[1])) throw new Error('Execution is not running');
      return json(response, 202, { status: 'cancelling' });
    }
    const approvalMatch = routeMatch(url.pathname, /^\/api\/approvals\/([^/]+)$/);
    if (request.method === 'POST' && approvalMatch) {
      const input = await readJsonBody(request);
      return json(response, 200, await this.decideApproval(approvalMatch[1], input.decision));
    }
    const cancelMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      const task = this.store.state.tasks.find((entry) => entry.id === cancelMatch[1]);
      if (!task) throw new Error('Task not found');
      if (!task.executionId || !this.processes.cancel(task.executionId)) throw new Error('Task is not running');
      return json(response, 202, { status: 'cancelling' });
    }
    const requeueMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/requeue$/);
    if (request.method === 'POST' && requeueMatch) {
      await this.store.update((state) => {
        const task = state.tasks.find((entry) => entry.id === requeueMatch[1]);
        if (!task) throw new Error('Task not found');
        if (task.status !== 'blocked') throw new Error('Only blocked tasks can be requeued');
        state.audit.push({ id: id('audit'), type: 'task.requeued', taskId: task.id, createdAt: now() });
        // A dep-blocked task re-checks its gate: still-failed dependencies re-block it.
        const failed = failedDependencies(new Map(state.tasks.map((entry) => [entry.id, entry])), task);
        if (failed.length) {
          this.blockForDependencies(state, task, failed.join(' '));
          return;
        }
        // A write task whose approval expired while blocked must not restart on
        // its own authority: it returns to waiting with a fresh pending approval.
        const hasAuthority = task.accessMode !== 'workspace-write'
          || state.approvals.some((entry) => entry.taskId === task.id && ['approved', 'auto-approved'].includes(entry.status));
        if (!hasAuthority) {
          const agent = state.agents.find((entry) => entry.id === task.agentId);
          if (!agent || agent.status !== 'installed') throw new Error('Assigned agent is unavailable');
          Object.assign(task, { status: 'waiting', blocker: null, updatedAt: now() });
          state.approvals.unshift(this.buildWriteApproval(state, task, agent));
          return;
        }
        Object.assign(task, { status: 'ready', blocker: null, updatedAt: now() });
      });
      this.broadcast({ type: 'state.changed', reason: 'task.requeued', taskId: requeueMatch[1] });
      await this.startQueuedTasks();
      return json(response, 200, { ok: true });
    }
    const reviewMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/review$/);
    if (request.method === 'POST' && reviewMatch) {
      const input = await readJsonBody(request);
      await this.store.update((state) => {
        const task = state.tasks.find((entry) => entry.id === reviewMatch[1]);
        if (!task) throw new Error('Task not found');
        task.status = input.accepted ? 'completed' : 'rejected';
        task.updatedAt = now();
      });
      this.broadcast({ type: 'state.changed', reason: 'task.reviewed', taskId: reviewMatch[1] });
      // The verdict changes dependents: completed deps free them, rejected deps block them.
      await this.startQueuedTasks();
      return json(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/policy') {
      const policy = validatePolicy(await readJsonBody(request));
      await this.store.update((state) => {
        state.policy = policy;
        state.audit.push({ id: id('audit'), type: 'policy.updated', createdAt: now() });
        state.messages.push({
          id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
          content: `Autopilot policy updated: ${policy.enabled ? 'enabled' : 'disabled'} · auto-approve writes ${policy.autoApproveWrites}`
            + ` · ${policy.commandAllowlist.length} allowlisted command pattern${policy.commandAllowlist.length === 1 ? '' : 's'}`
            + ` · auto-accept reviews ${policy.autoAcceptReviews ? 'on' : 'off'}`
            + ` · auto-retry ${policy.autoRetry.enabled ? `up to ${policy.autoRetry.maxAttempts} attempt${policy.autoRetry.maxAttempts === 1 ? '' : 's'}` : 'off'}`
            + ` · at most ${policy.maxAutoApprovalsPerHour} auto-approvals per hour.`,
          createdAt: now()
        });
      });
      this.broadcast({ type: 'state.changed', reason: 'policy.updated' });
      return json(response, 200, this.store.state.policy);
    }
    if (request.method === 'POST' && url.pathname === '/api/commands') {
      const input = await readJsonBody(request);
      const command = clampText(input.command, 4_000).trim();
      const purpose = clampText(input.purpose, 1_000).trim();
      if (!command || !purpose) throw new Error('Command and purpose are required');
      const approval = {
        id: id('approval'), type: 'command', status: 'pending', title: 'Local command approval',
        detail: purpose, impact: 'Runs exactly as entered inside the active project workspace.',
        command, cwd: this.store.state.room.workspace, createdAt: now(), decidedAt: null, decidedBy: null, reason: null
      };
      const verdict = await this.store.update((state) => {
        state.approvals.unshift(approval);
        const evaluated = evaluateAutoApproval(state, approval, { running: this.processes.running.size });
        if (evaluated.code === 'rate-capped') {
          state.audit.push({ id: id('audit'), type: 'autopilot.rate-capped', approvalId: approval.id, createdAt: now() });
        }
        if (evaluated.allow) this.recordAutoApproval(state, approval, { reason: evaluated.reason, subject: `command “${approval.command}”` });
        return evaluated;
      });
      if (verdict.allow) this.startCommand(approval);
      this.broadcast({ type: 'state.changed', reason: verdict.allow ? 'approval.auto-approved' : 'approval.created', approvalId: approval.id });
      return json(response, 201, approval);
    }
    if (request.method === 'POST' && url.pathname === '/api/room/pause') {
      await this.store.update((state) => { state.room.paused = true; });
      this.processes.cancelAll('room-paused');
      this.broadcast({ type: 'state.changed', reason: 'room.paused' });
      return json(response, 200, { paused: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/room/resume') {
      await this.store.update((state) => { state.room.paused = false; });
      this.broadcast({ type: 'state.changed', reason: 'room.resumed' });
      await this.startQueuedTasks();
      return json(response, 200, { paused: false });
    }
    if (request.method === 'POST' && url.pathname === '/api/workspace/refresh') {
      const workspace = await inspectWorkspace(this.store.state.room.workspace);
      await this.store.update((state) => { state.workspace = workspace; });
      this.broadcast({ type: 'state.changed', reason: 'workspace.refreshed' });
      return json(response, 200, workspace);
    }
    if (request.method === 'POST' && url.pathname === '/api/agents/scan') {
      const agents = await detectAgents();
      await this.store.update((state) => {
        const active = new Map(state.agents.map((agent) => [agent.id, agent]));
        state.agents = agents.map((agent) => {
          const prior = active.get(agent.id);
          if (prior?.activity === 'running') {
            return { ...agent, activity: prior.activity, connection: prior.connection, currentTaskId: prior.currentTaskId, lastAction: prior.lastAction };
          }
          if (prior?.connection === 'verified' && agent.status === 'installed') {
            return { ...agent, connection: 'verified', lastAction: prior.lastAction };
          }
          return agent;
        });
        state.audit.push({ id: id('audit'), type: 'agents.scanned', createdAt: now() });
      });
      this.broadcast({ type: 'state.changed', reason: 'agents.scanned' });
      return json(response, 200, agents);
    }
    if (request.method === 'POST' && url.pathname === '/api/workspace') {
      const input = await readJsonBody(request);
      const candidate = path.resolve(clampText(input.path, 2_000));
      const details = await stat(candidate);
      if (!details.isDirectory()) throw new Error('Workspace must be a directory');
      const workspace = await inspectWorkspace(candidate);
      await this.store.update((state) => {
        state.room.workspace = candidate;
        state.workspace = workspace;
        state.messages.push({
          id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
          content: `Workspace changed to ${candidate}`, createdAt: now()
        });
      });
      this.broadcast({ type: 'state.changed', reason: 'workspace.changed' });
      return json(response, 200, { path: candidate, workspace });
    }
    json(response, 404, { error: 'API route not found' });
  }

  async serveStatic(response, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(publicDir, relative);
    if (file !== publicDir && !file.startsWith(`${publicDir}${path.sep}`)) return json(response, 403, { error: 'Forbidden' });
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': contentTypes[path.extname(file)] || 'application/octet-stream' });
      response.end(body);
    } catch (error) {
      if (error.code === 'ENOENT') return json(response, 404, { error: 'Not found' });
      throw error;
    }
  }

  async handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!isTrustedHost(request.headers.host)) return json(response, 403, { error: 'Untrusted Host header' });
        if (request.method !== 'GET' && !isTrustedOrigin(request.headers.origin, request.headers.host)) {
          return json(response, 403, { error: 'Cross-origin request blocked' });
        }
        await this.handleApi(request, response, url);
      } else await this.serveStatic(response, url.pathname);
    } catch (error) {
      json(response, 400, { error: publicError(error) });
    }
  }

  listen({ port = 4317, host = '127.0.0.1' } = {}) {
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server.address())));
  }

  close() {
    this.processes.cancelAll('server-shutdown');
    for (const client of this.clients) client.end();
    return new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = new ConclaveApp({
    workspace: process.env.CONCLAVE_WORKSPACE || process.cwd(),
    ...(process.env.CONCLAVE_STATE ? { storeFile: path.resolve(process.env.CONCLAVE_STATE) } : {})
  });
  await app.initialize();
  const address = await app.listen({ port: Number(process.env.PORT || 4317), host: process.env.HOST || '127.0.0.1' });
  console.log(`Conclave is running at http://${address.address}:${address.port}`);
  console.log(`Workspace: ${app.store.state.room.workspace}`);
}
