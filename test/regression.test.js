import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';
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
