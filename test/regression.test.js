import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';
import { ProcessManager } from '../src/lib/process-manager.js';
import { id, now } from '../src/lib/utils.js';

async function makeApp(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-regression-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, base: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function post(base, url, body, headers = {}) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed };
}

const getState = async (base) => (await fetch(`${base}/api/state`)).json();

function seedAgent(app, overrides = {}) {
  return app.store.update((state) => {
    state.agents = [{
      id: 'claude', name: 'Claude', provider: 'Anthropic', status: 'installed', connection: 'verified',
      activity: 'idle', executable: '/usr/bin/claude', version: '1.0.0', capabilities: [], currentTaskId: null, lastAction: '', ...overrides
    }];
  });
}

// Raw request so we can control the Host header (fetch pins it to the URL authority).
function rawRequest(port, { method = 'POST', pathname = '/api/state', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: data }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

test('approving an agent-write while paused keeps the approval pending and the task waiting', async (context) => {
  const { app, base } = await makeApp(context);
  app.processes.start = () => { throw new Error('should not spawn while paused'); };
  await seedAgent(app);
  const created = await post(base, '/api/tasks', { title: 'Write', objective: 'Edit files', agentId: 'claude', accessMode: 'workspace-write' });
  assert.equal(created.status, 201);
  let state = await getState(base);
  const approval = state.approvals[0];
  assert.equal(approval.status, 'pending');
  await post(base, '/api/room/pause', {});
  const decision = await post(base, `/api/approvals/${approval.id}`, { decision: 'approved' });
  assert.equal(decision.status, 400);
  assert.match(decision.body.error, /paused/);
  state = await getState(base);
  assert.equal(state.approvals[0].status, 'pending');
  assert.equal(state.tasks.find((entry) => entry.id === created.body.id).status, 'waiting');
});

test('approving a command while paused refuses and never spawns', async (context) => {
  const { app, base } = await makeApp(context);
  const started = [];
  app.processes.start = (options) => { started.push(options); return { id: id('exec'), ...options }; };
  const command = await post(base, '/api/commands', { command: 'node --version', purpose: 'Verify' });
  assert.equal(command.body.status, 'pending');
  await post(base, '/api/room/pause', {});
  const decision = await post(base, `/api/approvals/${command.body.id}`, { decision: 'approved' });
  assert.equal(decision.status, 400);
  assert.match(decision.body.error, /paused/);
  assert.equal(started.length, 0);
  const state = await getState(base);
  assert.equal(state.approvals[0].status, 'pending');
});

test('a read-only task whose start fails becomes blocked, not a stranded ready task, and still returns 201', async (context) => {
  const { app, base } = await makeApp(context);
  await seedAgent(app);
  app.startTask = async () => { throw new Error('The room is paused'); };
  const created = await post(base, '/api/tasks', { title: 'Look', objective: 'Inspect things', agentId: 'claude', accessMode: 'read-only' });
  assert.equal(created.status, 201);
  const state = await getState(base);
  const task = state.tasks.find((entry) => entry.id === created.body.id);
  assert.equal(task.status, 'blocked');
  assert.match(task.blocker, /paused/);
  assert.ok(state.audit.some((entry) => entry.type === 'task.start-failed'));
});

test('review endpoint refuses non-review-required tasks and audits valid decisions', async (context) => {
  const { app, base } = await makeApp(context);
  const completedId = id('task');
  const reviewableId = id('task');
  await app.store.update((state) => {
    state.tasks.unshift({ id: completedId, title: 'Done', objective: 'x', agentId: 'claude', accessMode: 'read-only', status: 'completed', dependencies: [], blocker: null, executionId: null, createdAt: now(), updatedAt: now() });
    state.tasks.unshift({ id: reviewableId, title: 'Review me', objective: 'x', agentId: 'claude', accessMode: 'read-only', status: 'review-required', dependencies: [], blocker: null, executionId: 'exec_x', createdAt: now(), updatedAt: now() });
  });
  const rejectTerminal = await post(base, `/api/tasks/${completedId}/review`, { accepted: false });
  assert.equal(rejectTerminal.status, 400);
  assert.match(rejectTerminal.body.error, /awaiting review/);
  let state = await getState(base);
  assert.equal(state.tasks.find((entry) => entry.id === completedId).status, 'completed');

  const accept = await post(base, `/api/tasks/${reviewableId}/review`, { accepted: true });
  assert.equal(accept.status, 200);
  state = await getState(base);
  assert.equal(state.tasks.find((entry) => entry.id === reviewableId).status, 'completed');
  assert.ok(state.audit.some((entry) => entry.type === 'task.review-accepted' && entry.taskId === reviewableId));
});

test('request-authenticity: text/plain, cross-origin, and untrusted Host are rejected', async (context) => {
  const { base, port } = await makeApp(context);
  const plain = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ content: 'hi' }) });
  assert.equal(plain.status, 400);
  const crossOrigin = await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ content: 'hi' })
  });
  assert.equal(crossOrigin.status, 403);
  const badHost = await rawRequest(port, { method: 'GET', pathname: '/api/state', headers: { host: 'evil.example' } });
  assert.equal(badHost.status, 403);
  // A legitimate same-origin JSON request still works.
  const ok = await post(base, '/api/messages', { content: 'legitimate' });
  assert.equal(ok.status, 201);
});

test('@mention of an unavailable agent still persists the message and returns 201', async (context) => {
  const { app, base } = await makeApp(context);
  await seedAgent(app, { status: 'unavailable', connection: 'error', executable: null, version: null });
  const result = await post(base, '/api/messages', { content: '@claude fix the tests', accessMode: 'read-only' });
  assert.equal(result.status, 201);
  assert.equal(result.body.tasksCreated, 0);
  const state = await getState(base);
  assert.ok(state.messages.some((entry) => entry.content === '@claude fix the tests'));
  assert.ok(state.messages.some((entry) => entry.type === 'system' && /Could not create a task for Claude/.test(entry.content)));
});

test('a blocked task can be retried back to execution', async (context) => {
  const { app, base } = await makeApp(context);
  await seedAgent(app);
  const startedTasks = [];
  app.startTask = async (taskId) => { startedTasks.push(taskId); };
  const taskId = id('task');
  await app.store.update((state) => {
    state.tasks.unshift({ id: taskId, title: 'Stranded', objective: 'x', agentId: 'claude', accessMode: 'read-only', status: 'blocked', dependencies: [], blocker: 'Conclave restarted while this task was active.', executionId: null, createdAt: now(), updatedAt: now() });
  });
  const retry = await post(base, `/api/tasks/${taskId}/retry`, {});
  assert.equal(retry.status, 200);
  assert.deepEqual(startedTasks, [taskId]);
  const state = await getState(base);
  const task = state.tasks.find((entry) => entry.id === taskId);
  assert.equal(task.blocker, null);
  assert.ok(state.audit.some((entry) => entry.type === 'task.retried' && entry.taskId === taskId));
});

// Slot-aware stub: started executions occupy processes.running so processes.load
// reflects them (mirrors the helper in scheduler.test.js).
function stubRunningProcesses(app) {
  const started = [];
  app.processes.start = (options) => {
    const execution = { id: id('exec'), status: 'running', ...options };
    app.processes.running.set(execution.id, { kill() {} });
    started.push(execution);
    return execution;
  };
  return started;
}

function seedTask(app, overrides = {}) {
  const task = {
    id: id('task'), title: 'Seeded', objective: 'x', agentId: 'claude', accessMode: 'read-only', status: 'completed',
    dependencies: [], attempts: 0, blocker: null, executionId: null, createdAt: now(), updatedAt: now(), ...overrides
  };
  return app.store.update((state) => { state.tasks.unshift(task); }).then(() => task);
}

test('a cancelled run that traps SIGTERM and exits with a code is still reported cancelled', async (context) => {
  const events = [];
  const manager = new ProcessManager({ onEvent: (event) => events.push(event) });
  context.after(() => { for (const child of manager.running.values()) child.kill('SIGKILL'); });
  const script = 'process.on("SIGTERM", () => process.exit(1)); console.log("ready"); setInterval(() => {}, 1000);';
  const execution = manager.start({
    invocation: { command: process.execPath, args: ['-e', script] },
    cwd: os.tmpdir(), purpose: 'trap SIGTERM'
  });
  const until = async (predicate) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('timed out waiting for event');
  };
  await until((event) => event.type === 'execution.output' && event.line === 'ready');
  assert.equal(manager.cancel(execution.id, 'user'), true);
  const finished = await until((event) => event.type === 'execution.finished');
  assert.equal(finished.signal, null);
  assert.equal(finished.exitCode, 1);
  assert.equal(finished.status, 'cancelled');
  assert.equal(finished.reason, 'user');
});

test('two concurrent command approvals cannot over-subscribe maxConcurrentRuns', async (context) => {
  const { app, base } = await makeApp(context);
  const started = stubRunningProcesses(app);
  await app.store.update((state) => { state.room.limits.maxConcurrentRuns = 1; });
  const first = await post(base, '/api/commands', { command: 'node --version', purpose: 'One' });
  const second = await post(base, '/api/commands', { command: 'node --version', purpose: 'Two' });
  const decisions = await Promise.all([
    post(base, `/api/approvals/${first.body.id}`, { decision: 'approved' }),
    post(base, `/api/approvals/${second.body.id}`, { decision: 'approved' })
  ]);
  assert.equal(started.length, 1);
  assert.equal(app.processes.running.size, 1);
  assert.deepEqual(decisions.map((entry) => entry.status).sort(), [200, 400]);
  assert.match(decisions.find((entry) => entry.status === 400).body.error, /limit/);
  const state = await getState(base);
  assert.equal(state.approvals.filter((entry) => entry.status === 'pending').length, 1);
});

test('dep-blocking a waiting write task expires its pending approval instead of stranding it', async (context) => {
  const { app, base } = await makeApp(context);
  await seedAgent(app);
  const dep = await seedTask(app, { title: 'Doomed dep', status: 'failed' });
  const created = await post(base, '/api/tasks', {
    title: 'Write', objective: 'Edit files', agentId: 'claude', accessMode: 'workspace-write', dependencies: [dep.id]
  });
  assert.equal(created.status, 201);
  let state = await getState(base);
  assert.equal(state.tasks.find((entry) => entry.id === created.body.id).status, 'blocked');
  const approval = state.approvals.find((entry) => entry.taskId === created.body.id);
  assert.equal(approval.status, 'expired');
  // The expired approval can no longer be decided, and the task is untouched.
  const stale = await post(base, `/api/approvals/${approval.id}`, { decision: 'approved' });
  assert.equal(stale.status, 400);
  // Retry supersedes/expires rather than accumulating pending approvals.
  const retried = await post(base, `/api/tasks/${created.body.id}/retry`, {});
  assert.equal(retried.status, 200);
  state = await getState(base);
  assert.equal(state.approvals.filter((entry) => entry.taskId === created.body.id && entry.status === 'pending').length, 0);
});

test('retrying a waiting write task supersedes its old approval and a stale deny cannot reject a running task', async (context) => {
  const { app, base } = await makeApp(context);
  const started = stubRunningProcesses(app);
  await seedAgent(app);
  const created = await post(base, '/api/tasks', { title: 'Write', objective: 'Edit files', agentId: 'claude', accessMode: 'workspace-write' });
  let state = await getState(base);
  const original = state.approvals[0];
  const retried = await post(base, `/api/tasks/${created.body.id}/retry`, {});
  assert.equal(retried.status, 200);
  state = await getState(base);
  const pending = state.approvals.filter((entry) => entry.taskId === created.body.id && entry.status === 'pending');
  assert.equal(pending.length, 1);
  assert.equal(state.approvals.find((entry) => entry.id === original.id).status, 'superseded');
  const approved = await post(base, `/api/approvals/${pending[0].id}`, { decision: 'approved' });
  assert.equal(approved.status, 200);
  state = await getState(base);
  assert.equal(state.tasks.find((entry) => entry.id === created.body.id).status, 'active');
  assert.equal(started.length, 1);
  // A stale pending approval (hand-seeded) denied now must not clobber the run.
  const staleId = id('approval');
  await app.store.update((live) => {
    live.approvals.unshift({ id: staleId, type: 'agent-write', status: 'pending', taskId: created.body.id, agentId: 'claude',
      title: 'stale', detail: 'x', impact: 'x', command: 'claude', cwd: live.room.workspace, createdAt: now(), decidedAt: null });
  });
  const denied = await post(base, `/api/approvals/${staleId}`, { decision: 'denied' });
  assert.equal(denied.status, 200);
  state = await getState(base);
  assert.equal(state.tasks.find((entry) => entry.id === created.body.id).status, 'active');
});

test('a failed store save after reserving a slot does not leak the reservation', async (context) => {
  const { app } = await makeApp(context);
  await seedAgent(app);
  const task = await seedTask(app, { title: 'Ready', status: 'ready' });
  const originalSave = app.store.save.bind(app.store);
  let failNext = true;
  app.store.save = () => {
    if (failNext) { failNext = false; return Promise.reject(new Error('ENOSPC: no space left on device')); }
    return originalSave();
  };
  await assert.rejects(() => app.startTask(task.id), /ENOSPC/);
  assert.equal(app.processes.load, 0);
});

test('a retry racing a delete does not mint a pending approval for the vanished task', async (context) => {
  const { app, base } = await makeApp(context);
  await seedAgent(app);
  const task = await seedTask(app, { title: 'Doomed', status: 'failed', accessMode: 'workspace-write' });
  // Invoke delete first so its mutator is queued between retry's snapshot and
  // retry's own mutator — the ghost-approval window.
  const [deletion, retry] = await Promise.allSettled([app.deleteTask(task.id), app.retryTask(task.id)]);
  assert.equal(deletion.status, 'fulfilled');
  assert.equal(retry.status, 'rejected');
  assert.match(retry.reason.message, /Task not found/);
  const state = await getState(base);
  assert.equal(state.tasks.find((entry) => entry.id === task.id), undefined);
  assert.equal(state.approvals.filter((entry) => entry.status === 'pending').length, 0);
});

test('an approve racing a delete expires the approval instead of resurrecting a pending ghost', async (context) => {
  const { app, base } = await makeApp(context);
  await seedAgent(app);
  const created = await post(base, '/api/tasks', { title: 'Write', objective: 'Edit files', agentId: 'claude', accessMode: 'workspace-write' });
  assert.equal(created.status, 201);
  let state = await getState(base);
  const approval = state.approvals.find((entry) => entry.taskId === created.body.id);
  assert.equal(approval.status, 'pending');
  // The delete mutator lands between the approval commit and startTask's
  // reservation mutator, so the start fails with 'Task not found'.
  const [decision, deletion] = await Promise.allSettled([
    app.decideApproval(approval.id, 'approved'),
    app.deleteTask(created.body.id)
  ]);
  assert.equal(deletion.status, 'fulfilled');
  assert.equal(decision.status, 'rejected');
  assert.match(decision.reason.message, /Task not found/);
  state = await getState(base);
  const reverted = state.approvals.find((entry) => entry.id === approval.id);
  assert.equal(reverted.status, 'expired');
  assert.equal(reverted.decidedBy, 'system');
  assert.equal(reverted.reason, 'Task deleted');
  assert.equal(state.approvals.filter((entry) => entry.status === 'pending').length, 0);
  assert.ok(state.audit.some((entry) => entry.type === 'approval.start-failed'));
  // The expired approval can no longer be decided.
  const stale = await post(base, `/api/approvals/${approval.id}`, { decision: 'approved' });
  assert.equal(stale.status, 400);
  assert.match(stale.body.error, /already decided/);
});

test('deleting a failed dependency revives blocked dependents through the normal gates', async (context) => {
  const { app, base } = await makeApp(context);
  const started = stubRunningProcesses(app);
  await seedAgent(app);
  const dep = await seedTask(app, { title: 'Doomed dep', status: 'failed' });
  const readOnly = await post(base, '/api/tasks', {
    title: 'Read', objective: 'Inspect', agentId: 'claude', accessMode: 'read-only', dependencies: [dep.id]
  });
  const write = await post(base, '/api/tasks', {
    title: 'Write', objective: 'Edit files', agentId: 'claude', accessMode: 'workspace-write', dependencies: [dep.id]
  });
  let state = await getState(base);
  assert.equal(state.tasks.find((entry) => entry.id === readOnly.body.id).status, 'blocked');
  assert.equal(state.tasks.find((entry) => entry.id === write.body.id).status, 'blocked');
  await app.deleteTask(dep.id);
  state = await getState(base);
  // The read-only dependent restarts directly; the write dependent returns to
  // the approval gate with a fresh pending approval — never a silent bypass.
  const revivedRead = state.tasks.find((entry) => entry.id === readOnly.body.id);
  assert.equal(revivedRead.status, 'active');
  assert.equal(revivedRead.blocker, null);
  assert.equal(started.filter((entry) => entry.taskId === readOnly.body.id).length, 1);
  const revivedWrite = state.tasks.find((entry) => entry.id === write.body.id);
  assert.equal(revivedWrite.status, 'waiting');
  assert.equal(state.approvals.filter((entry) => entry.taskId === write.body.id && entry.status === 'pending').length, 1);
  // Clear-resolved no longer silently deletes the revived dependents.
  const cleared = await post(base, '/api/tasks/clear-resolved', {});
  assert.equal(cleared.body.deleted, 0);
  state = await getState(base);
  assert.ok(state.tasks.find((entry) => entry.id === readOnly.body.id));
  assert.ok(state.tasks.find((entry) => entry.id === write.body.id));
});

test('finishing one of two concurrent runs on the same agent keeps the agent running', async (context) => {
  const { app, base } = await makeApp(context);
  await seedAgent(app, { activity: 'running', currentTaskId: 'task_2' });
  await app.store.update((state) => {
    state.executions.unshift({ id: 'exec_1', taskId: 'task_1', agentId: 'claude', kind: 'agent', status: 'running', output: '', startedAt: now(), finishedAt: null });
    state.executions.unshift({ id: 'exec_2', taskId: 'task_2', agentId: 'claude', kind: 'agent', status: 'running', output: '', startedAt: now(), finishedAt: null });
  });
  await app.onProcessEvent({ type: 'execution.finished', executionId: 'exec_1', taskId: 'task_1', agentId: 'claude',
    exitCode: 1, signal: null, status: 'failed', finishedAt: now() });
  let state = await getState(base);
  let agent = state.agents[0];
  assert.equal(agent.activity, 'running');
  assert.equal(agent.currentTaskId, 'task_2');
  assert.equal(agent.connection, 'verified');
  await app.onProcessEvent({ type: 'execution.finished', executionId: 'exec_2', taskId: 'task_2', agentId: 'claude',
    exitCode: 0, signal: null, status: 'completed', finishedAt: now() });
  state = await getState(base);
  agent = state.agents[0];
  assert.equal(agent.activity, 'idle');
  assert.equal(agent.currentTaskId, null);
});
