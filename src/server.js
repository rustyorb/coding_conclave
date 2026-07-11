import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { detectAgents, buildAgentInvocation, summarizeAgentEvent } from './lib/adapters.js';
import { ProcessManager } from './lib/process-manager.js';
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
    this.processes = new ProcessManager({ onEvent: (event) => this.onProcessEvent(event) });
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
        if (event.taskId) {
          const task = state.tasks.find((entry) => entry.id === event.taskId);
          if (task) {
            task.status = event.status === 'completed' ? 'review-required' : event.status;
            task.updatedAt = event.finishedAt;
            task.executionId = event.executionId;
          }
        }
        if (event.agentId) {
          const agent = state.agents.find((entry) => entry.id === event.agentId);
          if (agent) Object.assign(agent, {
            activity: 'idle', currentTaskId: null,
            connection: event.status === 'completed' ? 'verified' : event.status === 'cancelled' ? agent.connection : 'error',
            lastAction: event.status === 'completed' ? 'Run finished; awaiting review' : `Run ${event.status}`
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
    if (state.room.paused) throw new Error('The room is paused');
    if (this.processes.running.size >= state.room.limits.maxConcurrentRuns) throw new Error('Concurrent run limit reached');
    const agent = state.agents.find((entry) => entry.id === task.agentId);
    if (!agent || agent.status !== 'installed') throw new Error('Assigned agent is unavailable');
    const invocation = buildAgentInvocation(agent.id, {
      executable: agent.executable,
      prompt: promptForTask(task, agent, state.room.workspace),
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
    await this.store.update((state) => {
      state.tasks.unshift(task);
      state.audit.push({ id: id('audit'), type: 'task.created', taskId: task.id, agentId: agent.id, createdAt });
      if (accessMode === 'workspace-write') {
        state.approvals.unshift({
          id: id('approval'), type: 'agent-write', status: 'pending', taskId: task.id, agentId: agent.id,
          title: `${agent.name} requests workspace-write access`,
          detail: objective, impact: `May create or modify files under ${state.room.workspace}. The agent sandbox remains scoped to the workspace.`,
          command: displayInvocation(preview), cwd: state.room.workspace, createdAt, decidedAt: null
        });
      }
    });
    this.broadcast({ type: 'state.changed', reason: 'task.created', taskId: task.id });
    if (accessMode === 'read-only') await this.startTask(task.id);
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
      state.audit.push({ id: id('audit'), type: `approval.${decision}`, approvalId, createdAt: approval.decidedAt });
      if (approval.taskId && decision === 'denied') {
        const task = state.tasks.find((entry) => entry.id === approval.taskId);
        if (task) Object.assign(task, { status: 'rejected', updatedAt: approval.decidedAt });
      }
    });
    if (decision === 'approved') {
      if (approval.type === 'agent-write') await this.startTask(approval.taskId);
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
      const mentioned = this.store.state.agents.filter((agent) => new RegExp(`@${agent.id}\\b`, 'i').test(content));
      for (const agent of mentioned) {
        await this.createTask({
          title: clampText(content.replace(/@\w+\b/g, '').trim(), 100) || `Message for ${agent.name}`,
          objective: content, agentId: agent.id, accessMode: input.accessMode
        });
      }
      this.broadcast({ type: 'state.changed', reason: 'message.created', messageId: message.id });
      return json(response, 201, { message, tasksCreated: mentioned.length });
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
      await this.store.update((state) => state.approvals.unshift(approval));
      this.broadcast({ type: 'state.changed', reason: 'approval.created', approvalId: approval.id });
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
      if (url.pathname.startsWith('/api/')) await this.handleApi(request, response, url);
      else await this.serveStatic(response, url.pathname);
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
