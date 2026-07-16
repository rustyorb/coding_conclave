import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';
import { id, now } from '../src/lib/utils.js';

async function makeApp(context, storeFile) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-lifecycle-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: storeFile || path.join(directory, '.state', 'state.json') });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, base: `http://127.0.0.1:${address.port}`, directory };
}

// Slot-aware stub: started executions occupy processes.running so processes.load
// reflects them, and finish() releases the slot then feeds the finished event back.
// Unlike the scheduler copy it also feeds execution.started (so state.executions
// carries a record for the diff/deletion assertions) and echoes the agentId on
// finish (so agent bookkeeping runs, as it does with the real ProcessManager).
function stubRunningProcesses(app) {
  const started = [];
  app.processes.start = (options) => {
    const execution = { id: id('exec'), status: 'running', ...options };
    app.processes.running.set(execution.id, { kill() {} });
    started.push(execution);
    app.processes.onEvent({ type: 'execution.started', execution: { ...execution } });
    return execution;
  };
  const finish = (execution, status = 'completed', exitCode = 0) => {
    app.processes.running.delete(execution.id);
    return app.onProcessEvent({ type: 'execution.finished', executionId: execution.id, taskId: execution.taskId,
      agentId: execution.agentId ?? null, exitCode, signal: null, status, finishedAt: now() });
  };
  return { started, finish };
}

async function post(base, url, body) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

const del = async (base, url) => { const r = await fetch(`${base}${url}`, { method: 'DELETE' }); return { status: r.status, body: await r.json() }; };

const getState = async (base) => (await fetch(`${base}/api/state`)).json();

function seedAgent(app, overrides = {}) {
  return app.store.update((state) => {
    state.agents = [{
      id: 'claude', name: 'Claude', provider: 'Anthropic', status: 'installed', connection: 'verified',
      activity: 'idle', executable: '/usr/bin/claude', version: '1.0.0', capabilities: [], currentTaskId: null, lastAction: '', ...overrides
    }];
  });
}

const setLimit = (app, max) => app.store.update((state) => { state.room.limits.maxConcurrentRuns = max; });
const findTask = (state, taskId) => state.tasks.find((entry) => entry.id === taskId);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function seedTask(app, overrides = {}) {
  const task = {
    id: id('task'), title: 'Seeded', objective: 'x', agentId: 'claude', accessMode: 'read-only', status: 'completed',
    dependencies: [], attempts: 0, blocker: null, executionId: null, createdAt: now(), updatedAt: now(), ...overrides
  };
  return app.store.update((state) => { state.tasks.unshift(task); }).then(() => task);
}

const run = promisify(execFile);
async function initGitRepo(directory) {
  const git = (...args) => run('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', ...args], { cwd: directory });
  await git('init'); await writeFile(path.join(directory, 'file.txt'), 'one\n'); await git('add', '.'); await git('commit', '-m', 'init');
}

test('createTask defaults to workspace-write and keeps the approval gate intact', async (context) => {
  const { app, base } = await makeApp(context);
  const { started } = stubRunningProcesses(app);
  await seedAgent(app);
  // Deliberate iteration-3 behavior change: an omitted accessMode used to default
  // to read-only; doing work is now the default, behind the unchanged approval gate.
  const created = await post(base, '/api/tasks', { title: 'Default', objective: 'Do work', agentId: 'claude' });
  assert.equal(created.status, 201);
  let state = await getState(base);
  const task = findTask(state, created.body.id);
  assert.equal(task.accessMode, 'workspace-write');
  assert.equal(task.status, 'waiting');
  const pending = state.approvals.filter((entry) => entry.status === 'pending' && entry.type === 'agent-write' && entry.taskId === created.body.id);
  assert.equal(pending.length, 1);
  assert.equal(started.length, 0);
  // The explicit read-only opt-in path is unchanged and starts immediately.
  const explicit = await post(base, '/api/tasks', { title: 'Opt-in', objective: 'Inspect', agentId: 'claude', accessMode: 'read-only' });
  assert.equal(explicit.status, 201);
  state = await getState(base);
  assert.equal(findTask(state, explicit.body.id).status, 'active');
});

test('@mention without accessMode routes through the write approval gate', async (context) => {
  const { app, base } = await makeApp(context);
  const { started } = stubRunningProcesses(app);
  await seedAgent(app);
  const result = await post(base, '/api/messages', { content: '@claude do the thing' });
  assert.equal(result.status, 201);
  assert.equal(result.body.tasksCreated, 1);
  const state = await getState(base);
  const task = state.tasks[0];
  assert.equal(task.accessMode, 'workspace-write');
  assert.equal(task.status, 'waiting');
  assert.equal(state.approvals.filter((entry) => entry.status === 'pending' && entry.taskId === task.id).length, 1);
  assert.equal(started.length, 0);
});

test('deleting a running task cancels its execution and survives the late finish', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  const created = await post(base, '/api/tasks', { title: 'Runs', objective: 'Do work', agentId: 'claude', accessMode: 'read-only' });
  let state = await getState(base);
  assert.equal(findTask(state, created.body.id).status, 'active');
  const execution = started[0];
  const deleted = await del(base, `/api/tasks/${created.body.id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { deleted: true, taskId: created.body.id });
  state = await getState(base);
  assert.equal(findTask(state, created.body.id), undefined);
  // The real cancel() ran against the stub's fake child and recorded the reason.
  assert.equal(app.processes.cancelled.get(execution.id), 'task-deleted');
  assert.ok(state.executions.some((entry) => entry.id === execution.id));
  assert.ok(state.audit.some((entry) => entry.type === 'task.deleted' && entry.taskId === created.body.id));
  // The SIGTERM lands after the delete: the late finish must not throw and the
  // task must stay gone while the execution record and agent are settled.
  await finish(execution, 'cancelled', null);
  state = await getState(base);
  assert.equal(state.executions.find((entry) => entry.id === execution.id).status, 'cancelled');
  assert.equal(state.agents[0].activity, 'idle');
  assert.equal(findTask(state, created.body.id), undefined);
});

test('deleting a waiting write task expires its pending approval', async (context) => {
  const { app, base } = await makeApp(context);
  stubRunningProcesses(app);
  await seedAgent(app);
  const created = await post(base, '/api/tasks', { title: 'Write', objective: 'Edit files', agentId: 'claude', accessMode: 'workspace-write' });
  let state = await getState(base);
  const approval = state.approvals.find((entry) => entry.taskId === created.body.id);
  assert.equal(approval.status, 'pending');
  const deleted = await del(base, `/api/tasks/${created.body.id}`);
  assert.equal(deleted.status, 200);
  state = await getState(base);
  assert.equal(findTask(state, created.body.id), undefined);
  const expired = state.approvals.find((entry) => entry.id === approval.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.decidedBy, 'system');
  assert.equal(expired.reason, 'Task deleted');
  // The Approval Center cannot approve a ghost.
  const decision = await post(base, `/api/approvals/${approval.id}`, { decision: 'approved' });
  assert.equal(decision.status, 400);
  assert.match(decision.body.error, /already decided/);
});

test('deleting a dependency unblocks queued dependents', async (context) => {
  const { app, base } = await makeApp(context);
  const { started } = stubRunningProcesses(app);
  await seedAgent(app);
  const a = await post(base, '/api/tasks', { title: 'A', objective: 'Do work', agentId: 'claude', accessMode: 'read-only' });
  await sleep(5);
  const b = await post(base, '/api/tasks', { title: 'B', objective: 'Do work', agentId: 'claude', accessMode: 'read-only', dependencies: [a.body.id] });
  let state = await getState(base);
  assert.equal(findTask(state, a.body.id).status, 'active');
  assert.equal(findTask(state, b.body.id).status, 'queued');
  const deleted = await del(base, `/api/tasks/${a.body.id}`);
  assert.equal(deleted.status, 200);
  state = await getState(base);
  const dependent = findTask(state, b.body.id);
  assert.deepEqual(dependent.dependencies, []);
  assert.equal(dependent.status, 'active');
  assert.equal(started.filter((entry) => entry.taskId === b.body.id).length, 1);
});

test('clear-resolved deletes exactly the terminal tasks and audits the count', async (context) => {
  const { app, base } = await makeApp(context);
  const { started } = stubRunningProcesses(app);
  await seedAgent(app);
  await setLimit(app, 1);
  const filler = await post(base, '/api/tasks', { title: 'Filler', objective: 'Do work', agentId: 'claude', accessMode: 'read-only' });
  const queued = await post(base, '/api/tasks', { title: 'Queued', objective: 'Do work', agentId: 'claude', accessMode: 'read-only' });
  assert.equal(started.length, 1);
  for (const status of ['completed', 'failed', 'cancelled', 'rejected', 'blocked']) {
    await seedTask(app, { title: `Terminal ${status}`, status });
  }
  const executionsBefore = (await getState(base)).executions.length;
  const first = await post(base, '/api/tasks/clear-resolved', {});
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { deleted: 5 });
  let state = await getState(base);
  assert.equal(state.tasks.length, 2);
  assert.equal(findTask(state, filler.body.id).status, 'active');
  assert.equal(findTask(state, queued.body.id).status, 'queued');
  const cleared = state.audit.filter((entry) => entry.type === 'tasks.cleared');
  assert.equal(cleared.length, 1);
  assert.match(cleared[0].detail, /5/);
  assert.equal(state.executions.length, executionsBefore);
  const second = await post(base, '/api/tasks/clear-resolved', {});
  assert.deepEqual(second.body, { deleted: 0 });
  state = await getState(base);
  assert.equal(state.audit.filter((entry) => entry.type === 'tasks.cleared').length, 1);
});

test('clear-resolved strips cleared ids from surviving dependencies', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  await setLimit(app, 1);
  const filler = await post(base, '/api/tasks', { title: 'Filler', objective: 'Do work', agentId: 'claude', accessMode: 'read-only' });
  const dep = await seedTask(app, { title: 'Completed dep' });
  const dependent = await post(base, '/api/tasks', { title: 'D', objective: 'Do work', agentId: 'claude', accessMode: 'read-only', dependencies: [dep.id] });
  let state = await getState(base);
  assert.equal(findTask(state, dependent.body.id).status, 'queued'); // capacity-gated, dep already met
  const result = await post(base, '/api/tasks/clear-resolved', {});
  assert.equal(result.body.deleted, 1);
  state = await getState(base);
  assert.equal(findTask(state, dep.id), undefined);
  const survivor = findTask(state, dependent.body.id);
  assert.deepEqual(survivor.dependencies, []);
  assert.equal(survivor.status, 'queued'); // never blocked behind the cleared id
  await finish(started[0], 'completed', 0);
  state = await getState(base);
  assert.equal(findTask(state, filler.body.id).status, 'review-required');
  assert.equal(findTask(state, dependent.body.id).status, 'active');
  assert.equal(started.at(-1).taskId, dependent.body.id);
});

test('a finished write run stores the workspace diff, clamped', async (context) => {
  const { app, base, directory } = await makeApp(context);
  await initGitRepo(directory);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  const created = await post(base, '/api/tasks', { title: 'Write', objective: 'Edit files', agentId: 'claude' });
  assert.equal(created.status, 201);
  let state = await getState(base);
  const approval = state.approvals.find((entry) => entry.status === 'pending' && entry.taskId === created.body.id);
  const approved = await post(base, `/api/approvals/${approval.id}`, { decision: 'approved' });
  assert.equal(approved.status, 200);
  assert.equal(started.length, 1);
  await appendFile(path.join(directory, 'file.txt'), `two\n${'x'.repeat(35_000)}\n`);
  await finish(started[0], 'completed', 0);
  state = await getState(base);
  assert.equal(findTask(state, created.body.id).status, 'review-required');
  const execution = state.executions.find((entry) => entry.id === started[0].id);
  assert.ok(execution.diff.includes('file.txt'));
  assert.ok(execution.diff.includes('+two'));
  assert.ok(execution.diff.length <= 30_020);
  assert.ok(execution.diff.includes('…[truncated]'));
});

test('non-git workspace stores diff null; read-only runs skip capture', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  const write = await post(base, '/api/tasks', { title: 'Write', objective: 'Edit files', agentId: 'claude' });
  let state = await getState(base);
  const approval = state.approvals.find((entry) => entry.status === 'pending' && entry.taskId === write.body.id);
  await post(base, `/api/approvals/${approval.id}`, { decision: 'approved' });
  await finish(started[0], 'completed', 0);
  state = await getState(base);
  assert.equal(state.executions.find((entry) => entry.id === started[0].id).diff, null);
  await post(base, '/api/tasks', { title: 'Read', objective: 'Inspect', agentId: 'claude', accessMode: 'read-only' });
  assert.equal(started.length, 2);
  await finish(started[1], 'completed', 0);
  state = await getState(base);
  assert.equal('diff' in state.executions.find((entry) => entry.id === started[1].id), false);
});
