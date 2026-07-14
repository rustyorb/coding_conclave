import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp, promptForTask } from '../src/server.js';

test('HTTP API persists chat and requires a decision before command execution', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-api-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const messageResponse = await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Human checkpoint' })
  });
  assert.equal(messageResponse.status, 201);
  assert.equal((await messageResponse.json()).tasksCreated, 0);

  const commandResponse = await fetch(`${base}/api/commands`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'node --version', purpose: 'Verify Node' })
  });
  assert.equal(commandResponse.status, 201);
  const approval = await commandResponse.json();
  assert.equal(app.processes.running.size, 0);
  assert.equal(approval.status, 'pending');

  const decisionResponse = await fetch(`${base}/api/approvals/${approval.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'denied' })
  });
  assert.equal(decisionResponse.status, 200);
  assert.equal((await decisionResponse.json()).status, 'denied');
  assert.equal(app.processes.running.size, 0);

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.ok(state.messages.some((message) => message.content === 'Human checkpoint'));
  assert.equal(state.approvals[0].status, 'denied');
});

test('FR-CHAT-004/FR-POL-009: recipient messages create chat turns, never tasks, and write access requests are ignored', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-recipients-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  await app.store.update((state) => {
    state.agents = [{
      id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified',
      activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready'
    }];
  });
  const started = [];
  app.processes.start = ({ taskId, agentId, kind, invocation }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind, purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push({ execution, accessMode: invocation.accessMode });
    return execution;
  };
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const response = await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'Review the composer flow', agentIds: ['codex'], accessMode: 'workspace-write' })
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.tasksCreated, 0);
  assert.equal(body.chatTurnsCreated, 1);
  assert.equal(app.store.state.tasks.length, 0);
  assert.equal(app.store.state.approvals.length, 0);
  const turn = app.store.state.chatTurns[0];
  assert.equal(turn.agentId, 'codex');
  assert.equal(turn.status, 'active');
  assert.equal(started.length, 1);
});

test('process output broadcasts a lightweight change signal after persistence', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-events-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const payloads = [];
  app.clients.add({ write: (payload) => payloads.push(payload), end: () => {} });
  app.store.state.executions.push({ id: 'exec_test', output: '' });

  await app.onProcessEvent({
    type: 'execution.output', executionId: 'exec_test', taskId: 'task_test', agentId: 'codex',
    stream: 'stdout', line: 'large private output that clients do not need', createdAt: new Date().toISOString()
  });

  assert.equal(app.store.state.executions[0].output.includes('large private output'), true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].includes('large private output'), false);
  assert.equal(JSON.parse(payloads[0].slice(6)).type, 'state.changed');
});

test('agent prompts share teammate status, room activity, and the coordination protocol', () => {
  const state = {
    room: { workspace: 'C:\\workspace' },
    agents: [
      { id: 'claude', name: 'Claude', status: 'installed', activity: 'idle', currentTaskId: null },
      { id: 'codex', name: 'Codex', status: 'installed', activity: 'running', currentTaskId: 'task_1' },
      { id: 'gemini', name: 'Gemini', status: 'unavailable', activity: 'idle', currentTaskId: null }
    ],
    tasks: [{ id: 'task_1', title: 'Refactor adapters' }],
    messages: [{ sourceName: 'Codex', content: 'Handoff: adapters refactored, npm test passes.' }]
  };
  const prompt = promptForTask({ title: 'T', objective: 'O', accessMode: 'workspace-write' }, state.agents[0], state);
  assert.match(prompt, /Codex: running on “Refactor adapters”/);
  assert.match(prompt, /Handoff: adapters refactored, npm test passes\./);
  assert.match(prompt, /COORDINATION\.md/);
  assert.doesNotMatch(prompt, /Gemini/);
  assert.ok(prompt.split('\n').includes('O'), 'a distinct objective is included');

  const duplicated = promptForTask({ title: 'SAME', objective: 'SAME', accessMode: 'read-only' }, state.agents[0], state);
  assert.ok(!duplicated.split('\n').includes('SAME'), 'objective identical to the title is not repeated');
  assert.match(duplicated, /Task: SAME/);
});

test('chat turns run read-only, resolve on completion, and never touch the task board', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-chat-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  await app.store.update((state) => {
    state.agents = [{
      id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified',
      activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready'
    }];
  });
  const started = [];
  app.processes.start = ({ taskId, agentId, kind }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind, purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push(execution);
    return execution;
  };
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const response = await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'are you alive? just checking in on the room today.', agentIds: ['codex'] })
  });
  assert.equal(response.status, 201);
  assert.equal(app.store.state.tasks.length, 0);
  const turn = app.store.state.chatTurns[0];
  assert.equal(turn.status, 'active');
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, 'chat');
  assert.equal(started[0].taskId, null);

  await app.onProcessEvent({
    type: 'execution.finished', executionId: started[0].id, taskId: null, agentId: 'codex',
    exitCode: 0, signal: null, status: 'completed', finishedAt: new Date().toISOString()
  });
  const finished = app.store.state.chatTurns.find((entry) => entry.id === turn.id);
  assert.equal(finished.status, 'completed');
  assert.equal(app.store.state.tasks.length, 0);
  assert.equal(app.store.state.agents[0].activity, 'idle');
});

test('one run per agent: a second task for a busy agent queues and starts after the first finishes', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-agent-lock-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await app.store.update((state) => {
    state.agents = [{
      id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified',
      activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready'
    }];
  });
  const started = [];
  app.processes.start = ({ taskId, agentId }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind: 'agent', purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push(execution);
    return execution;
  };

  const first = await app.createTask({ title: 'Inspect A', objective: 'obj A', agentId: 'codex', accessMode: 'read-only' });
  const second = await app.createTask({ title: 'Inspect B', objective: 'obj B', agentId: 'codex', accessMode: 'read-only' });

  assert.equal(started.length, 1);
  assert.equal(app.store.state.tasks.find((entry) => entry.id === first.id).status, 'active');
  assert.equal(app.store.state.tasks.find((entry) => entry.id === second.id).status, 'ready');
  assert.ok(app.store.state.messages.some((message) => message.content.includes('Queued “Inspect B” until Codex finishes “Inspect A”')));

  await app.onProcessEvent({
    type: 'execution.finished', executionId: started[0].id, taskId: first.id, agentId: 'codex',
    exitCode: 0, signal: null, status: 'completed', finishedAt: new Date().toISOString()
  });

  assert.equal(started.length, 2);
  assert.equal(started[1].taskId, second.id);
  assert.equal(app.store.state.tasks.find((entry) => entry.id === second.id).status, 'active');
});

test('blocked tasks can be requeued through the API and start again', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-requeue-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  await app.store.update((state) => {
    state.agents = [{
      id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified',
      activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready'
    }];
    state.tasks.unshift({
      id: 'task_blocked', title: 'Revive me', objective: 'obj', agentId: 'codex', accessMode: 'read-only',
      origin: 'operator', status: 'blocked', blocker: 'Conclave restarted while this task was queued.',
      dependencies: [], executionId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
  });
  const started = [];
  app.processes.start = ({ taskId, agentId }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind: 'agent', purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push(execution);
    return execution;
  };
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const response = await fetch(`${base}/api/tasks/task_blocked/requeue`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(response.status, 200);
  const task = app.store.state.tasks.find((entry) => entry.id === 'task_blocked');
  assert.equal(task.status, 'active');
  assert.equal(task.blocker, null);
  assert.equal(started.length, 1);
  assert.equal(started[0].taskId, 'task_blocked');

  const rejected = await fetch(`${base}/api/tasks/task_blocked/requeue`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(rejected.status, 400);
});

test('workspace-write runs are serialized: second writer queues and starts after the first finishes', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-lock-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await app.store.update((state) => {
    state.agents = [
      { id: 'claude', name: 'Claude', status: 'installed', connection: 'verified', activity: 'idle', executable: 'claude-fake', currentTaskId: null },
      { id: 'codex', name: 'Codex', status: 'installed', connection: 'verified', activity: 'idle', executable: 'codex-fake', currentTaskId: null }
    ];
  });
  const started = [];
  app.processes.start = ({ taskId, agentId }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind: 'agent', purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push(execution);
    return execution;
  };

  const first = await app.createTask({ title: 'Write A', objective: 'obj A', agentId: 'claude', accessMode: 'workspace-write' });
  const second = await app.createTask({ title: 'Write B', objective: 'obj B', agentId: 'codex', accessMode: 'workspace-write' });
  await app.decideApproval(app.store.state.approvals.find((entry) => entry.taskId === first.id).id, 'approved');
  await app.decideApproval(app.store.state.approvals.find((entry) => entry.taskId === second.id).id, 'approved');

  assert.equal(started.length, 1);
  assert.equal(app.store.state.tasks.find((entry) => entry.id === first.id).status, 'active');
  assert.equal(app.store.state.tasks.find((entry) => entry.id === second.id).status, 'ready');
  assert.ok(app.store.state.messages.some((message) => message.content.includes('Queued “Write B”')));

  await app.onProcessEvent({
    type: 'execution.finished', executionId: started[0].id, taskId: first.id, agentId: 'claude',
    exitCode: 0, signal: null, status: 'completed', finishedAt: new Date().toISOString()
  });

  assert.equal(started.length, 2);
  assert.equal(started[1].taskId, second.id);
  assert.equal(app.store.state.tasks.find((entry) => entry.id === second.id).status, 'active');
});
