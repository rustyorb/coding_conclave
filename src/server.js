import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { detectAgents, buildAgentInvocation, summarizeAgentEvent } from './lib/adapters.js';
import { ProcessManager } from './lib/process-manager.js';
import { JsonStore } from './lib/store.js';
import { defaultPolicy, evaluateAutoApproval, validatePolicy } from './lib/policy.js';
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
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '';
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

function displayInvocation(invocation) {
  const quote = (value) => /\s/.test(String(value)) ? JSON.stringify(String(value)) : String(value);
  return [invocation.command, ...invocation.args].map(quote).join(' ');
}

function promptForTask(task, agent, workspace) {
  return [
    `You are ${agent.name}, participating as an independent coding agent in a Conclave room.`,
    `Workspace: ${workspace}`,
    `Access granted for this run: ${task.accessMode}.`,
    `Task: ${task.title}`,
    task.objective,
    '',
    'Work only on this task and within the workspace. Report concrete conclusions, changes, commands, and validation evidence.',
    'Do not claim an action or result that did not occur. Do not expose secrets or hidden reasoning.',
    'Finish with a concise handoff that another agent or the human operator can verify.'
  ].join('\n');
}

export class ConclaveApp {
  constructor({ workspace = projectDir, storeFile = dataFile } = {}) {
    this.clients = new Set();
    this.store = new JsonStore(storeFile, path.resolve(workspace));
    this.processes = new ProcessManager({ onEvent: (event) => {
      this.onProcessEvent(event).catch((error) => console.error('process event handling failed', publicError(error)));
    } });
    this.server = http.createServer((request, response) => this.handle(request, response));
  }

  async initialize() {
    await this.store.load();
    const verifiedAgents = new Set(this.store.state.executions
      .filter((execution) => execution.kind === 'agent' && execution.status === 'completed')
      .map((execution) => execution.agentId));
    const agents = (await detectAgents()).map((agent) => verifiedAgents.has(agent.id)
      ? { ...agent, connection: 'verified', lastAction: 'Verified by a successful execution' }
      : agent);
    const workspace = await inspectWorkspace(this.store.state.room.workspace);
    await this.store.update((state) => {
      state.agents = agents;
      state.workspace = workspace;
      state.policy = { ...defaultPolicy(), ...state.policy };
      state.executions.filter((entry) => entry.status === 'running').forEach((entry) => {
        entry.status = 'interrupted';
        entry.finishedAt = now();
      });
      state.tasks.filter((task) => task.status === 'active').forEach((task) => {
        task.status = 'blocked';
        task.blocker = 'Conclave restarted while this task was active.';
        task.updatedAt = now();
      });
    });
  }

  broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  async onProcessEvent(event) {
    this.broadcast(event);
    await this.store.update(async (state) => {
      if (event.type === 'execution.started') {
        state.executions.unshift(event.execution);
      }
      if (event.type === 'execution.output') {
        const execution = state.executions.find((entry) => entry.id === event.executionId);
        if (execution) execution.output = clampText(`${execution.output}${event.stream === 'stderr' ? '[stderr] ' : ''}${event.line}\n`, 120_000);
        if (event.agentId) {
          const summary = summarizeAgentEvent(event.agentId, event.line);
          if (summary) {
            const agent = state.agents.find((candidate) => candidate.id === event.agentId);
            const content = clampText(summary);
            const previous = state.messages.at(-1);
            if (previous?.source !== event.agentId || previous?.taskId !== event.taskId || previous?.content !== content) {
              state.messages.push({
                id: id('msg'), source: event.agentId, sourceName: agent?.name || event.agentId,
                type: 'progress', content, taskId: event.taskId, createdAt: event.createdAt
              });
            }
          }
        }
      }
      if (event.type === 'execution.finished') {
        const execution = state.executions.find((entry) => entry.id === event.executionId);
        if (execution) Object.assign(execution, {
          status: event.status, exitCode: event.exitCode, signal: event.signal, finishedAt: event.finishedAt
        });
        let autoAccepted = false;
        if (event.taskId) {
          const task = state.tasks.find((entry) => entry.id === event.taskId);
          if (task && !['completed', 'rejected', 'cancelled'].includes(task.status)) {
            autoAccepted = event.status === 'completed' && state.policy.enabled && state.policy.autoAcceptReviews && !state.room.paused;
            task.status = event.status === 'completed' ? (autoAccepted ? 'completed' : 'review-required') : event.status;
            task.updatedAt = event.finishedAt;
            task.executionId = event.executionId;
            if (autoAccepted) {
              state.audit.push({ id: id('audit'), type: 'task.auto-accepted', taskId: task.id, executionId: event.executionId, decidedBy: 'autopilot', createdAt: now() });
              state.messages.push({ id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'autopilot',
                content: clampText(`Autopilot accepted “${task.title}” — the run completed successfully and auto-accept reviews is enabled.`), taskId: task.id, createdAt: event.finishedAt });
            }
          }
        }
        if (event.agentId) {
          const agent = state.agents.find((entry) => entry.id === event.agentId);
          if (agent) Object.assign(agent, {
            activity: 'idle', currentTaskId: null,
            connection: event.status === 'completed' ? 'verified' : event.status === 'cancelled' ? agent.connection : 'error',
            lastAction: event.status === 'completed' ? (autoAccepted ? 'Run finished; auto-accepted by autopilot' : 'Run finished; awaiting review') : `Run ${event.status}`
          });
        }
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
      state.audit.push({ id: id('audit'), type: event.type, executionId: event.executionId, taskId: event.taskId, createdAt: now() });
      if (state.audit.length > 2_000) state.audit.splice(0, state.audit.length - 2_000);
    });
  }

  async startTask(taskId) {
    const state = this.store.snapshot();
    const task = state.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error('Task not found');
    const agent = state.agents.find((entry) => entry.id === task.agentId);
    if (!agent || agent.status !== 'installed') throw new Error('Assigned agent is unavailable');
    const invocation = buildAgentInvocation(agent.id, {
      executable: agent.executable,
      prompt: promptForTask(task, agent, state.room.workspace),
      workspace: state.room.workspace,
      accessMode: task.accessMode
    });
    // Check-and-reserve atomically inside a single serialized mutator so two
    // concurrent starts (or a start racing /api/room/pause) cannot both pass.
    let reserved = false;
    await this.store.update((next) => {
      if (next.room.paused) throw new Error('The room is paused');
      if (this.processes.load >= next.room.limits.maxConcurrentRuns) throw new Error('Concurrent run limit reached');
      const liveTask = next.tasks.find((entry) => entry.id === taskId);
      if (!liveTask) throw new Error('Task not found');
      const liveAgent = next.agents.find((entry) => entry.id === task.agentId);
      if (!liveAgent || liveAgent.status !== 'installed') throw new Error('Assigned agent is unavailable');
      this.processes.reserve();
      reserved = true;
      liveTask.status = 'active';
      liveTask.updatedAt = now();
      liveAgent.activity = 'running';
      liveAgent.currentTaskId = taskId;
      liveAgent.lastAction = task.title;
      next.messages.push({
        id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'delegation',
        content: `Assigned “${task.title}” to ${liveAgent.name} with ${task.accessMode} access.`, taskId, createdAt: now()
      });
    });
    try {
      // Guard against a pause that landed while the reservation mutator was saving.
      if (this.store.state.room.paused) throw new Error('The room is paused');
      const execution = this.processes.start({
        taskId, agentId: agent.id, invocation, cwd: state.room.workspace, purpose: task.objective
      });
      this.processes.release();
      reserved = false;
      await this.store.update((next) => {
        const liveTask = next.tasks.find((entry) => entry.id === taskId);
        liveTask.executionId = execution.id;
      });
      this.broadcast({ type: 'state.changed', reason: 'task.started', taskId });
      return execution;
    } finally {
      if (reserved) this.processes.release();
    }
  }

  async createTask(input) {
    const title = clampText(input.title || 'Untitled task', 160).trim();
    const objective = clampText(input.objective, 12_000).trim();
    const accessMode = input.accessMode === 'workspace-write' ? 'workspace-write' : 'read-only';
    if (!objective) throw new Error('Task objective is required');
    const agent = this.store.state.agents.find((entry) => entry.id === input.agentId);
    if (!agent) throw new Error('Select a supported agent');
    if (agent.status !== 'installed') throw new Error(`${agent.name} is unavailable`);
    const createdAt = now();
    const task = {
      id: id('task'), title, objective, agentId: agent.id, accessMode,
      status: accessMode === 'workspace-write' ? 'waiting' : 'ready',
      dependencies: [], blocker: null, executionId: null, createdAt, updatedAt: createdAt
    };
    const preview = accessMode === 'workspace-write' ? buildAgentInvocation(agent.id, {
      executable: agent.executable,
      prompt: promptForTask(task, agent, this.store.state.room.workspace),
      workspace: this.store.state.room.workspace,
      accessMode
    }) : null;
    const autoApproved = await this.store.update((state) => {
      state.tasks.unshift(task);
      state.audit.push({ id: id('audit'), type: 'task.created', taskId: task.id, agentId: agent.id, createdAt });
      if (accessMode !== 'workspace-write') return false;
      const approval = {
        id: id('approval'), type: 'agent-write', status: 'pending', taskId: task.id, agentId: agent.id,
        title: `${agent.name} requests workspace-write access`,
        detail: objective, impact: `May create or modify files under ${state.room.workspace}. The agent sandbox remains scoped to the workspace.`,
        command: displayInvocation(preview), cwd: state.room.workspace, createdAt, decidedAt: null
      };
      state.approvals.unshift(approval);
      const verdict = evaluateAutoApproval(state, approval, { running: this.processes.running.size });
      if (verdict.code === 'rate-capped') state.audit.push({ id: id('audit'), type: 'autopilot.rate-capped', approvalId: approval.id, createdAt: now() });
      if (!verdict.allow) return false;
      this.recordAutoApproval(state, approval, { reason: verdict.reason, taskId: task.id, agentId: agent.id,
        subject: `workspace-write access for ${agent.name} on “${task.title}”` });
      return approval.id;
    });
    this.broadcast({ type: 'state.changed', reason: 'task.created', taskId: task.id });
    if (autoApproved) await this.startTaskViaAutopilot(task.id, autoApproved);
    if (accessMode === 'read-only') {
      try {
        await this.startTask(task.id);
      } catch (error) {
        // The task is already persisted; instead of stranding it as an
        // unstartable 'ready' task behind a 400, mark it blocked (with the
        // reason) so it lands in the Resolved lane and the request still succeeds.
        const detail = publicError(error);
        await this.store.update((state) => {
          const live = state.tasks.find((entry) => entry.id === task.id);
          if (live && live.status === 'ready') Object.assign(live, { status: 'blocked', blocker: detail, updatedAt: now() });
          state.audit.push({ id: id('audit'), type: 'task.start-failed', taskId: task.id, detail, createdAt: now() });
        });
        this.broadcast({ type: 'state.changed', reason: 'task.start-failed', taskId: task.id });
      }
    }
    return task;
  }

  // Return a stranded task (restart-blocked, failed, cancelled, or an unstarted
  // ready/waiting task) to execution. Read-only tasks restart directly;
  // workspace-write tasks get a fresh pending approval.
  async retryTask(taskId) {
    const snapshot = this.store.snapshot();
    const task = snapshot.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error('Task not found');
    if (!['blocked', 'failed', 'cancelled', 'interrupted', 'ready', 'waiting'].includes(task.status)) {
      throw new Error('Task cannot be retried from its current status');
    }
    const agent = snapshot.agents.find((entry) => entry.id === task.agentId);
    if (!agent || agent.status !== 'installed') throw new Error('Assigned agent is unavailable');

    if (task.accessMode === 'read-only') {
      await this.store.update((state) => {
        const live = state.tasks.find((entry) => entry.id === taskId);
        if (live) Object.assign(live, { status: 'ready', blocker: null, executionId: null, updatedAt: now() });
        state.audit.push({ id: id('audit'), type: 'task.retried', taskId, createdAt: now() });
      });
      this.broadcast({ type: 'state.changed', reason: 'task.retried', taskId });
      try {
        await this.startTask(taskId);
      } catch (error) {
        const detail = publicError(error);
        await this.store.update((state) => {
          const live = state.tasks.find((entry) => entry.id === taskId);
          if (live && live.status === 'ready') Object.assign(live, { status: 'blocked', blocker: detail, updatedAt: now() });
          state.audit.push({ id: id('audit'), type: 'task.start-failed', taskId, detail, createdAt: now() });
        });
        this.broadcast({ type: 'state.changed', reason: 'task.start-failed', taskId });
      }
      return this.store.state.tasks.find((entry) => entry.id === taskId);
    }

    const createdAt = now();
    const preview = buildAgentInvocation(agent.id, {
      executable: agent.executable,
      prompt: promptForTask(task, agent, snapshot.room.workspace),
      workspace: snapshot.room.workspace,
      accessMode: 'workspace-write'
    });
    const autoApproved = await this.store.update((state) => {
      const live = state.tasks.find((entry) => entry.id === taskId);
      if (live) Object.assign(live, { status: 'waiting', blocker: null, executionId: null, updatedAt: createdAt });
      const approval = {
        id: id('approval'), type: 'agent-write', status: 'pending', taskId, agentId: agent.id,
        title: `${agent.name} requests workspace-write access`,
        detail: task.objective, impact: `May create or modify files under ${state.room.workspace}. The agent sandbox remains scoped to the workspace.`,
        command: displayInvocation(preview), cwd: state.room.workspace, createdAt, decidedAt: null
      };
      state.approvals.unshift(approval);
      state.audit.push({ id: id('audit'), type: 'task.retried', taskId, createdAt });
      const verdict = evaluateAutoApproval(state, approval, { running: this.processes.load });
      if (verdict.code === 'rate-capped') state.audit.push({ id: id('audit'), type: 'autopilot.rate-capped', approvalId: approval.id, createdAt: now() });
      if (!verdict.allow) return false;
      this.recordAutoApproval(state, approval, { reason: verdict.reason, taskId, agentId: agent.id,
        subject: `workspace-write access for ${agent.name} on “${task.title}”` });
      return approval.id;
    });
    this.broadcast({ type: 'state.changed', reason: 'task.retried', taskId });
    if (autoApproved) await this.startTaskViaAutopilot(taskId, autoApproved);
    return this.store.state.tasks.find((entry) => entry.id === taskId);
  }

  async decideApproval(approvalId, decision) {
    if (!['approved', 'denied'].includes(decision)) throw new Error('Decision must be approved or denied');
    if (decision === 'approved') {
      // Refuse before consuming the approval when the run cannot start yet, so a
      // paused room or a full run queue leaves the approval pending for retry
      // instead of stranding the task with an already-decided approval.
      const snapshot = this.store.snapshot();
      const target = snapshot.approvals.find((entry) => entry.id === approvalId);
      if (target && target.status === 'pending' && (target.type === 'agent-write' || target.type === 'command')) {
        if (snapshot.room.paused) throw new Error('The room is paused');
        if (this.processes.load >= snapshot.room.limits.maxConcurrentRuns) throw new Error('Concurrent run limit reached');
      }
    }
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
      if (approval.type === 'agent-write') {
        // Mirror the autopilot rollback: if the start fails after the approval
        // was committed, return the approval to pending for manual retry.
        try {
          await this.startTask(approval.taskId);
        } catch (error) {
          await this.revertFailedStart(approval.taskId, approval.id, error, 'approval.start-failed');
          throw error;
        }
      }
      if (approval.type === 'command') this.startCommand(approval);
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

  recordAutoApproval(state, approval, { reason, taskId, agentId, subject }) {
    Object.assign(approval, { status: 'auto-approved', decidedAt: now(), decidedBy: 'autopilot', reason });
    state.audit.push({ id: id('audit'), type: 'approval.auto-approved', approvalId: approval.id, taskId, agentId, decidedBy: 'autopilot', reason, createdAt: approval.decidedAt });
    state.messages.push({ id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'autopilot',
      content: clampText(`Autopilot approved ${subject}: ${reason}.`), taskId, createdAt: approval.decidedAt });
  }

  // Roll back a decided approval and its task after startTask throws, so the
  // request is recoverable from the Approval Center instead of being consumed.
  async revertFailedStart(taskId, approvalId, error, type) {
    const detail = publicError(error);
    await this.store.update((state) => {
      const approval = state.approvals.find((entry) => entry.id === approvalId);
      if (approval && (approval.status === 'auto-approved' || approval.status === 'approved')) {
        Object.assign(approval, { status: 'pending', decidedAt: null, decidedBy: null, reason: null });
      }
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (task?.status === 'active' && !task.executionId) {
        Object.assign(task, { status: 'waiting', updatedAt: now() });
        const agent = state.agents.find((entry) => entry.id === task.agentId);
        if (agent?.currentTaskId === taskId) Object.assign(agent, { activity: 'idle', currentTaskId: null });
      }
      state.audit.push({ id: id('audit'), type, approvalId, taskId, detail, createdAt: now() });
      state.messages.push({ id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'autopilot',
        content: clampText(`Could not start the run (${detail}); the request was returned to the Approval Center for manual review.`), taskId, createdAt: now() });
    });
    this.broadcast({ type: 'state.changed', reason: type, taskId });
  }

  async startTaskViaAutopilot(taskId, approvalId) {
    try { await this.startTask(taskId); }
    catch (error) { await this.revertFailedStart(taskId, approvalId, error, 'autopilot.start-failed'); }
  }

  async handleApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, this.store.snapshot());
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
      const message = { id: id('msg'), source: 'user', sourceName: 'You', type: 'message', content, createdAt: now() };
      await this.store.update((state) => state.messages.push(message));
      // Announce the persisted message immediately so a later mention failure
      // cannot swallow the broadcast and leave the message invisible.
      this.broadcast({ type: 'state.changed', reason: 'message.created', messageId: message.id });
      const mentioned = this.store.state.agents.filter((agent) => new RegExp(`@${agent.id}\\b`, 'i').test(content));
      let tasksCreated = 0;
      for (const agent of mentioned) {
        try {
          await this.createTask({
            title: clampText(content.replace(/@\w+\b/g, '').trim(), 100) || `Message for ${agent.name}`,
            objective: content, agentId: agent.id, accessMode: input.accessMode
          });
          tasksCreated += 1;
        } catch (error) {
          // One unavailable/failed mention must not turn the committed message
          // into a 400 or abort the remaining mentions.
          const detail = publicError(error);
          await this.store.update((state) => state.messages.push({
            id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
            content: clampText(`Could not create a task for ${agent.name}: ${detail}`), createdAt: now()
          }));
          this.broadcast({ type: 'state.changed', reason: 'message.mention-failed', messageId: message.id });
        }
      }
      return json(response, 201, { message, tasksCreated });
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
    const retryMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/retry$/);
    if (request.method === 'POST' && retryMatch) {
      return json(response, 200, await this.retryTask(retryMatch[1]));
    }
    const reviewMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/review$/);
    if (request.method === 'POST' && reviewMatch) {
      const input = await readJsonBody(request);
      await this.store.update((state) => {
        const task = state.tasks.find((entry) => entry.id === reviewMatch[1]);
        if (!task) throw new Error('Task not found');
        if (task.status !== 'review-required') throw new Error('Task is not awaiting review');
        task.status = input.accepted ? 'completed' : 'rejected';
        task.updatedAt = now();
        state.audit.push({ id: id('audit'), type: input.accepted ? 'task.review-accepted' : 'task.review-rejected',
          taskId: task.id, executionId: task.executionId, decidedBy: 'user', createdAt: now() });
      });
      this.broadcast({ type: 'state.changed', reason: 'task.reviewed', taskId: reviewMatch[1] });
      return json(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/commands') {
      const input = await readJsonBody(request);
      const command = clampText(input.command, 4_000).trim();
      const purpose = clampText(input.purpose, 1_000).trim();
      if (!command || !purpose) throw new Error('Command and purpose are required');
      const approval = {
        id: id('approval'), type: 'command', status: 'pending', title: 'Local command approval',
        detail: purpose, impact: 'Runs exactly as entered inside the active project workspace.',
        command, cwd: this.store.state.room.workspace, createdAt: now(), decidedAt: null
      };
      const autoApproved = await this.store.update((state) => {
        state.approvals.unshift(approval);
        const verdict = evaluateAutoApproval(state, approval, { running: this.processes.running.size });
        if (verdict.code === 'rate-capped') state.audit.push({ id: id('audit'), type: 'autopilot.rate-capped', approvalId: approval.id, createdAt: now() });
        if (!verdict.allow) return false;
        this.recordAutoApproval(state, approval, { reason: verdict.reason, subject: `command “${approval.command}”` });
        return true;
      });
      if (autoApproved) this.startCommand(approval);
      this.broadcast({ type: 'state.changed', reason: autoApproved ? 'approval.auto-approved' : 'approval.created', approvalId: approval.id });
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
      return json(response, 200, { paused: false });
    }
    if (request.method === 'POST' && url.pathname === '/api/policy') {
      const policy = validatePolicy(await readJsonBody(request));
      await this.store.update((state) => {
        state.policy = policy;
        state.audit.push({ id: id('audit'), type: 'policy.updated',
          detail: `enabled=${policy.enabled} writes=${policy.autoApproveWrites} allowlist=${policy.commandAllowlist.length} reviews=${policy.autoAcceptReviews} cap=${policy.maxAutoApprovalsPerHour}`, createdAt: now() });
      });
      this.broadcast({ type: 'state.changed', reason: 'policy.updated' });
      return json(response, 200, this.store.state.policy);
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
  const app = new ConclaveApp({ workspace: process.env.CONCLAVE_WORKSPACE || process.cwd() });
  await app.initialize();
  const address = await app.listen({ port: Number(process.env.PORT || 4317), host: process.env.HOST || '127.0.0.1' });
  console.log(`Conclave is running at http://${address.address}:${address.port}`);
  console.log(`Workspace: ${app.store.state.room.workspace}`);
}
