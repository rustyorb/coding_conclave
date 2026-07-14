import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';
import { reachesTask, validateDependencies } from '../src/lib/scheduler.js';

async function makeApp(context, prefix, seed) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  if (seed) await app.store.update(seed);
  const started = [];
  app.processes.start = ({ taskId = null, agentId = null, kind = 'agent', purpose = '', cwd }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind, purpose, command: '', cwd,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    app.processes.running.set(execution.id, { kill() {} });
    started.push(execution);
    return execution;
  };
  const finish = (execution, status = 'completed', exitCode = 0) => {
    app.processes.running.delete(execution.id);
    return app.onProcessEvent({
      type: 'execution.finished', executionId: execution.id, taskId: execution.taskId, agentId: execution.agentId,
      exitCode, signal: null, status, finishedAt: new Date().toISOString()
    });
  };
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const address = await app.listen({ port: 0 });
  return { app, started, finish, base: `http://127.0.0.1:${address.port}` };
}

const post = async (base, route, body = {}) => {
  const response = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
};

const agentRow = (id, name, overrides = {}) => ({
  id, name, provider: 'Test', status: 'installed', connection: 'verified',
  activity: 'idle', executable: `${id}-fake`, version: 'test', currentTaskId: null, currentChatTurnId: null,
  lastAction: 'Ready', ...overrides
});

const makeTask = (base, overrides = {}) => post(base, '/api/tasks', {
  title: 'Task', objective: 'Do work', agentId: 'codex', accessMode: 'read-only', ...overrides
});

const findTask = (app, taskId) => app.store.state.tasks.find((entry) => entry.id === taskId);

test('validateDependencies rejects cycles and self-reference and terminates on corrupted graphs', () => {
  const graph = (edges) => Object.entries(edges).map(([taskId, deps]) => ({ id: taskId, dependencies: deps }));
  assert.throws(() => validateDependencies(graph({ a: [], b: ['a'] }), ['b'], 'a'), /cycle/);
  assert.throws(() => validateDependencies(graph({ a: [], b: ['c'], c: ['a'] }), ['b'], 'a'), /cycle/);
  assert.throws(() => validateDependencies(graph({ a: [] }), ['a'], 'a'), /itself/);
  assert.throws(() => validateDependencies(graph({ a: [] }), ['missing'], null), /Unknown dependency/);
  assert.throws(() => validateDependencies(graph({ a: [] }), 'nope', null), /array of task ids/);
  assert.throws(() => validateDependencies(graph({}), Array.from({ length: 21 }, (_, i) => `t${i}`), null), /at most 20/);
  // A pre-corrupted cyclic state.json must terminate instead of hanging.
  assert.deepEqual(validateDependencies(graph({ x: ['y'], y: ['x'] }), ['x'], 'z'), ['x']);
  assert.equal(reachesTask(graph({ x: ['y'], y: ['x'] }), ['x'], 'z'), false);
});

test('an unknown dependency id is a 400 and the task is not persisted', async (context) => {
  const { app, base } = await makeApp(context, 'conclave-dep-unknown-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
  });
  const bad = await makeTask(base, { dependencies: ['task_missing'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Unknown dependency/);
  assert.equal(app.store.state.tasks.length, 0);
  const ok = await makeTask(base);
  assert.equal(ok.status, 201, 'the store queue survives the rejected input');
});

test('a ready task with an unmet dep waits with a reason and starts via the drainer when the dep completes', async (context) => {
  const { app, started, finish, base } = await makeApp(context, 'conclave-dep-drain-', (state) => {
    state.agents = [agentRow('codex', 'Codex'), agentRow('gemini', 'Gemini')];
  });
  const a = await makeTask(base, { title: 'Dep A' });
  const b = await makeTask(base, { title: 'Task B', agentId: 'gemini', dependencies: [a.body.id] });
  assert.equal(b.status, 201);
  assert.equal(findTask(app, b.body.id).status, 'ready');
  assert.equal(started.length, 1, 'only the dependency starts');
  assert.ok(app.store.state.messages.some((entry) => entry.type === 'system'
    && entry.content.includes('Queued “Task B”') && entry.content.includes('waiting on “Dep A”')));

  await finish(started[0], 'completed', 0);
  assert.equal(findTask(app, a.body.id).status, 'review-required');
  assert.equal(findTask(app, b.body.id).status, 'ready', 'a run pending review does not satisfy the dependency');
  assert.equal(started.length, 1);

  const accepted = await post(base, `/api/tasks/${a.body.id}/review`, { accepted: true });
  assert.equal(accepted.status, 200);
  assert.equal(findTask(app, b.body.id).status, 'active');
  assert.equal(started.length, 2);
  assert.equal(started[1].taskId, b.body.id);
});

test('a failed dependency blocks the dependent and expires its pending write approval', async (context) => {
  const { app, started, finish, base } = await makeApp(context, 'conclave-dep-fail-', (state) => {
    state.agents = [agentRow('codex', 'Codex'), agentRow('gemini', 'Gemini')];
  });
  const a = await makeTask(base, { title: 'Dep A' });
  const b = await makeTask(base, { title: 'Task B', agentId: 'gemini', accessMode: 'workspace-write', dependencies: [a.body.id] });
  assert.equal(findTask(app, b.body.id).status, 'waiting');
  const approval = app.store.state.approvals.find((entry) => entry.taskId === b.body.id);
  assert.equal(approval.status, 'pending');

  await finish(started[0], 'failed', 1);
  assert.equal(findTask(app, a.body.id).status, 'failed');
  const blocked = findTask(app, b.body.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blocker, /Dep A/);
  assert.match(blocked.blocker, /failed/);
  assert.equal(approval.status, 'expired');
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'task.dependency-blocked' && entry.taskId === b.body.id));
  assert.ok(app.store.state.messages.some((entry) => entry.type === 'blocker' && entry.content.includes('is blocked')));

  const stale = await post(base, `/api/approvals/${approval.id}`, { decision: 'approved' });
  assert.equal(stale.status, 400, 'an expired approval can no longer grant authority');
  assert.equal(started.length, 1);
});

test('creating on a failed dep blocks on the first pass, and requeue re-blocks while the dep is still failed', async (context) => {
  const { app, base } = await makeApp(context, 'conclave-dep-requeue-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
    state.tasks.unshift({
      id: 'task_broken', title: 'Broken dep', objective: 'x', agentId: 'codex', accessMode: 'read-only',
      priority: 'none', origin: 'operator', source: null, archivedAt: null, status: 'failed',
      dependencies: [], attempts: 0, blocker: null, executionId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
  });
  const doomed = await makeTask(base, { dependencies: ['task_broken'] });
  assert.equal(doomed.status, 201);
  let task = findTask(app, doomed.body.id);
  assert.equal(task.status, 'blocked');
  assert.match(task.blocker, /Broken dep/);
  assert.match(task.blocker, /failed/);

  const requeued = await post(base, `/api/tasks/${doomed.body.id}/requeue`);
  assert.equal(requeued.status, 200);
  task = findTask(app, doomed.body.id);
  assert.equal(task.status, 'blocked', 'requeue re-checks failed deps and re-blocks');
  assert.match(task.blocker, /Broken dep/);
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'task.requeued' && entry.taskId === doomed.body.id));
});

test('a denied dependency approval rejects the task and dep-blocks its dependents', async (context) => {
  const { app, base } = await makeApp(context, 'conclave-dep-denied-', (state) => {
    state.agents = [agentRow('codex', 'Codex'), agentRow('gemini', 'Gemini')];
  });
  const a = await makeTask(base, { title: 'Gated dep', accessMode: 'workspace-write' });
  const b = await makeTask(base, { title: 'Dependent', agentId: 'gemini', dependencies: [a.body.id] });
  assert.equal(findTask(app, b.body.id).status, 'ready');
  const approval = app.store.state.approvals.find((entry) => entry.taskId === a.body.id);
  const denied = await post(base, `/api/approvals/${approval.id}`, { decision: 'denied' });
  assert.equal(denied.status, 200);
  assert.equal(findTask(app, a.body.id).status, 'rejected');
  const blocked = findTask(app, b.body.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blocker, /rejected/);
});
