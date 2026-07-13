import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';
import { id, now } from '../src/lib/utils.js';
import { reachesTask, selectStartable, validateDependencies } from '../src/lib/scheduler.js';

async function makeApp(context, storeFile) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-scheduler-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: storeFile || path.join(directory, '.state', 'state.json') });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, base: `http://127.0.0.1:${address.port}`, directory };
}

// Slot-aware stub: started executions occupy processes.running so processes.load
// reflects them, and finish() releases the slot then feeds the finished event back.
function stubRunningProcesses(app) {
  const started = [];
  app.processes.start = (options) => {
    const execution = { id: id('exec'), status: 'running', ...options };
    app.processes.running.set(execution.id, { kill() {} });
    started.push(execution);
    return execution;
  };
  const finish = (execution, status = 'completed', exitCode = 0) => {
    app.processes.running.delete(execution.id);
    return app.onProcessEvent({ type: 'execution.finished', executionId: execution.id, taskId: execution.taskId,
      agentId: null, exitCode, signal: null, status, finishedAt: now() });
  };
  return { started, finish };
}

async function post(base, url, body) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
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

const enable = (base, overrides = {}) => post(base, '/api/policy', {
  enabled: true, autoApproveWrites: 'off', commandAllowlist: [], autoAcceptReviews: false, maxAutoApprovalsPerHour: 20, ...overrides
});

const setLimit = (app, max) => app.store.update((state) => { state.room.limits.maxConcurrentRuns = max; });
const makeTask = (base, overrides = {}) => post(base, '/api/tasks', {
  title: 'Task', objective: 'Do work', agentId: 'claude', accessMode: 'read-only', ...overrides
});
const findTask = (state, taskId) => state.tasks.find((entry) => entry.id === taskId);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function seedTask(app, overrides = {}) {
  const task = {
    id: id('task'), title: 'Seeded', objective: 'x', agentId: 'claude', accessMode: 'read-only', status: 'completed',
    dependencies: [], attempts: 0, blocker: null, executionId: null, createdAt: now(), updatedAt: now(), ...overrides
  };
  return app.store.update((state) => { state.tasks.unshift(task); }).then(() => task);
}

// Deterministically expose a fake `claude` CLI on PATH for detectAgents.
async function withFakeClaudeOnPath(directory, run) {
  const binDir = path.join(directory, 'fakebin');
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, 'claude'), '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  try { return await run(); } finally { process.env.PATH = originalPath; }
}

test('unknown dependency id is a 400 and does not poison the store queue', async (context) => {
  const { app, base } = await makeApp(context);
  stubRunningProcesses(app);
  await seedAgent(app);
  const bad = await makeTask(base, { dependencies: ['task_missing'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Unknown dependency/);
  assert.equal((await getState(base)).tasks.length, 0);
  const ok = await makeTask(base);
  assert.equal(ok.status, 201);
});

test('dependency input validation: shape, size cap, and deduplication', async (context) => {
  const { app, base } = await makeApp(context);
  stubRunningProcesses(app);
  await seedAgent(app);
  for (const dependencies of ['nope', [42], [null]]) {
    const bad = await makeTask(base, { dependencies });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /array of task ids/);
  }
  const many = await makeTask(base, { dependencies: Array.from({ length: 21 }, (_, index) => `task_${index}`) });
  assert.equal(many.status, 400);
  assert.match(many.body.error, /at most 20/);
  const first = await makeTask(base);
  const dup = await makeTask(base, { dependencies: [first.body.id, first.body.id] });
  assert.equal(dup.status, 201);
  const state = await getState(base);
  assert.deepEqual(findTask(state, dup.body.id).dependencies, [first.body.id]);
});

test('validateDependencies rejects cycles and self-reference, and terminates on corrupted graphs', () => {
  const graph = (edges) => Object.entries(edges).map(([taskId, deps]) => ({ id: taskId, dependencies: deps }));
  assert.throws(() => validateDependencies(graph({ a: [], b: ['a'] }), ['b'], 'a'), /cycle/);
  assert.throws(() => validateDependencies(graph({ a: [], b: ['c'], c: ['a'] }), ['b'], 'a'), /cycle/);
  assert.throws(() => validateDependencies(graph({ a: [] }), ['a'], 'a'), /itself/);
  // A pre-corrupted cyclic state.json must terminate instead of hanging.
  assert.deepEqual(validateDependencies(graph({ x: ['y'], y: ['x'] }), ['x'], 'z'), ['x']);
  assert.equal(reachesTask(graph({ x: ['y'], y: ['x'] }), ['x'], 'z'), false);
});

test('a hand-corrupted cyclic store still terminates task creation and scheduling', async (context) => {
  const { app, base } = await makeApp(context);
  stubRunningProcesses(app);
  await seedAgent(app);
  const aId = id('task');
  const bId = id('task');
  await seedTask(app, { id: aId, title: 'Cycle A', status: 'queued', dependencies: [bId] });
  await seedTask(app, { id: bId, title: 'Cycle B', status: 'queued', dependencies: [aId] });
  const created = await makeTask(base, { dependencies: [aId] });
  assert.equal(created.status, 201);
  const state = await getState(base);
  assert.equal(findTask(state, created.body.id).status, 'queued');
});

test('depending on a completed task starts immediately; on a failed task blocks on the first pass', async (context) => {
  const { app, base } = await makeApp(context);
  stubRunningProcesses(app);
  await seedAgent(app);
  const done = await seedTask(app, { title: 'Done' });
  const broken = await seedTask(app, { title: 'Broken dep', status: 'failed' });
  const runnable = await makeTask(base, { dependencies: [done.id] });
  assert.equal(runnable.status, 201);
  let state = await getState(base);
  assert.equal(findTask(state, runnable.body.id).status, 'active');
  const doomed = await makeTask(base, { dependencies: [broken.id] });
  assert.equal(doomed.status, 201);
  state = await getState(base);
  const blocked = findTask(state, doomed.body.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blocker, /Broken dep/);
  assert.match(blocked.blocker, /failed/);
});

test('a dependent starts only after its dependency completes and passes review', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  const a = await makeTask(base, { title: 'A' });
  const b = await makeTask(base, { title: 'B', dependencies: [a.body.id] });
  let state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'queued');
  assert.equal(started.length, 1);
  await finish(started[0], 'completed', 0);
  state = await getState(base);
  assert.equal(findTask(state, a.body.id).status, 'review-required');
  assert.equal(findTask(state, b.body.id).status, 'queued');
  assert.equal(started.length, 1);
  const accepted = await post(base, `/api/tasks/${a.body.id}/review`, { accepted: true });
  assert.equal(accepted.status, 200);
  state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'active');
  assert.equal(started.length, 2);
  assert.equal(started[1].taskId, b.body.id);
});

test('with auto-accept reviews on, a dependent starts straight off the finish hook', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  await enable(base, { autoAcceptReviews: true });
  const a = await makeTask(base, { title: 'A' });
  const b = await makeTask(base, { title: 'B', dependencies: [a.body.id] });
  await finish(started[0], 'completed', 0);
  const state = await getState(base);
  assert.equal(findTask(state, a.body.id).status, 'completed');
  assert.equal(findTask(state, b.body.id).status, 'active');
  assert.equal(started[1].taskId, b.body.id);
});

test('approval and dependencies are independent gates', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  const a = await makeTask(base, { title: 'A' });
  const b = await makeTask(base, { title: 'B', accessMode: 'workspace-write', dependencies: [a.body.id] });
  let state = await getState(base);
  assert.equal(state.approvals[0].status, 'pending');
  assert.equal(findTask(state, b.body.id).status, 'waiting');
  const approved = await post(base, `/api/approvals/${state.approvals[0].id}`, { decision: 'approved' });
  assert.equal(approved.status, 200);
  state = await getState(base);
  assert.equal(state.approvals[0].status, 'approved');
  assert.equal(findTask(state, b.body.id).status, 'queued');
  assert.equal(started.length, 1);
  await finish(started[0], 'completed', 0);
  await post(base, `/api/tasks/${a.body.id}/review`, { accepted: true });
  state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'active');
  assert.equal(started.at(-1).taskId, b.body.id);
});

test('a denied dependency rejects the task, dep-blocks dependents, and stays retryable', async (context) => {
  const { app, base } = await makeApp(context);
  stubRunningProcesses(app);
  await seedAgent(app);
  const b = await makeTask(base, { title: 'B', accessMode: 'workspace-write' });
  let state = await getState(base);
  const denied = await post(base, `/api/approvals/${state.approvals[0].id}`, { decision: 'denied' });
  assert.equal(denied.status, 200);
  state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'rejected');
  const c = await makeTask(base, { title: 'C', dependencies: [b.body.id] });
  state = await getState(base);
  const blocked = findTask(state, c.body.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blocker, /rejected/);
  // The rejected dependency can be revived: retry demands a fresh approval.
  const retried = await post(base, `/api/tasks/${b.body.id}/retry`, {});
  assert.equal(retried.status, 200);
  state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'waiting');
  assert.equal(state.approvals.filter((entry) => entry.status === 'pending').length, 1);
});

test('dependency failure blocks dependents and retry re-evaluates the gate', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  const a = await makeTask(base, { title: 'Dep A' });
  const b = await makeTask(base, { title: 'B', dependencies: [a.body.id] });
  await finish(started[0], 'failed', 1);
  let state = await getState(base);
  assert.equal(findTask(state, a.body.id).status, 'failed');
  const blockedB = findTask(state, b.body.id);
  assert.equal(blockedB.status, 'blocked');
  assert.match(blockedB.blocker, /Dep A/);
  assert.match(blockedB.blocker, /failed/);
  assert.ok(state.audit.some((entry) => entry.type === 'task.dependency-blocked' && entry.taskId === b.body.id));
  assert.ok(state.messages.some((entry) => entry.type === 'blocker' && entry.content.includes('is blocked')));

  // Retrying B while A is still failed re-blocks it with a fresh blocker.
  const retryEarly = await post(base, `/api/tasks/${b.body.id}/retry`, {});
  assert.equal(retryEarly.status, 200);
  state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'blocked');
  assert.match(findTask(state, b.body.id).blocker, /Dep A/);

  // Revive A, complete and accept it, then retry B → B starts.
  await post(base, `/api/tasks/${a.body.id}/retry`, {});
  state = await getState(base);
  assert.equal(findTask(state, a.body.id).status, 'active');
  await finish(started.at(-1), 'completed', 0);
  await post(base, `/api/tasks/${a.body.id}/review`, { accepted: true });
  const retryLate = await post(base, `/api/tasks/${b.body.id}/retry`, {});
  assert.equal(retryLate.status, 200);
  state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'active');
  assert.equal(started.at(-1).taskId, b.body.id);
});

test('creating a task at the concurrency limit queues instead of throwing', async (context) => {
  const { app, base } = await makeApp(context);
  const { started } = stubRunningProcesses(app);
  await seedAgent(app);
  await setLimit(app, 1);
  await makeTask(base, { title: 'A' });
  const b = await makeTask(base, { title: 'B' });
  assert.equal(b.status, 201);
  const state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'queued');
  assert.equal(started.length, 1);
  assert.ok(state.audit.some((entry) => entry.type === 'task.queued' && entry.taskId === b.body.id));
});

test('queued tasks drain FIFO as slots free', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  await setLimit(app, 1);
  const t1 = await makeTask(base, { title: 'T1' });
  await sleep(5);
  const t2 = await makeTask(base, { title: 'T2' });
  await sleep(5);
  const t3 = await makeTask(base, { title: 'T3' });
  assert.equal(started.length, 1);
  assert.equal(started[0].taskId, t1.body.id);
  await finish(started[0], 'completed', 0);
  assert.equal(started.length, 2);
  assert.equal(started[1].taskId, t2.body.id);
  await finish(started[1], 'completed', 0);
  assert.equal(started.length, 3);
  assert.equal(started[2].taskId, t3.body.id);
});

test('agent-write approval at capacity queues; command approval still refuses', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  await setLimit(app, 1);
  await makeTask(base, { title: 'A' });
  const b = await makeTask(base, { title: 'B', accessMode: 'workspace-write' });
  let state = await getState(base);
  const approved = await post(base, `/api/approvals/${state.approvals[0].id}`, { decision: 'approved' });
  assert.equal(approved.status, 200);
  state = await getState(base);
  assert.equal(state.approvals[0].status, 'approved');
  assert.equal(findTask(state, b.body.id).status, 'queued');
  const command = await post(base, '/api/commands', { command: 'node --version', purpose: 'Check' });
  const decision = await post(base, `/api/approvals/${command.body.id}`, { decision: 'approved' });
  assert.equal(decision.status, 400);
  assert.match(decision.body.error, /limit/);
  await finish(started[0], 'completed', 0);
  state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'active');
  assert.equal(started.at(-1).taskId, b.body.id);
});

test('pause leaves the queue untouched, never retries cancelled runs, and resume drains FIFO', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  await enable(base, { autoRetry: { enabled: true, maxAttempts: 2 } });
  await setLimit(app, 1);
  const a = await makeTask(base, { title: 'A' });
  await sleep(5);
  const b = await makeTask(base, { title: 'B' });
  await sleep(5);
  const dependent = await makeTask(base, { title: 'Needs A', dependencies: [a.body.id] });
  await post(base, '/api/room/pause', {});
  // SIGTERM lands: the running child closes with a signal → 'cancelled'.
  await finish(started[0], 'cancelled', null);
  let state = await getState(base);
  assert.equal(findTask(state, a.body.id).status, 'cancelled');
  assert.equal(findTask(state, a.body.id).attempts, 0);
  assert.ok(!state.audit.some((entry) => entry.type === 'task.auto-retried'));
  assert.equal(findTask(state, b.body.id).status, 'queued');
  assert.equal(started.length, 1);
  await post(base, '/api/room/resume', {});
  state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'active');
  assert.equal(started.at(-1).taskId, b.body.id);
  const blocked = findTask(state, dependent.body.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blocker, /cancelled/);
});

test('auto-retry re-queues failures up to the cap then fails with an exhausted blocker', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  await enable(base, { autoRetry: { enabled: true, maxAttempts: 2 } });
  const a = await makeTask(base, { title: 'Flaky' });
  await finish(started[0], 'failed', 1);
  let state = await getState(base);
  let task = findTask(state, a.body.id);
  assert.equal(task.attempts, 1);
  assert.equal(task.status, 'active'); // re-queued then immediately restarted
  assert.equal(started.length, 2);
  assert.ok(state.audit.some((entry) => entry.type === 'task.auto-retried' && entry.taskId === a.body.id));
  assert.ok(state.messages.some((entry) => entry.type === 'autopilot' && /retry 1 of 2/.test(entry.content)));
  await finish(started[1], 'failed', 1);
  state = await getState(base);
  task = findTask(state, a.body.id);
  assert.equal(task.attempts, 2);
  assert.equal(started.length, 3);
  await finish(started[2], 'failed', 1);
  state = await getState(base);
  task = findTask(state, a.body.id);
  assert.equal(task.status, 'failed');
  assert.match(task.blocker, /retries exhausted/i);
  assert.equal(started.length, 3);
  assert.equal(state.audit.filter((entry) => entry.type === 'task.auto-retried').length, 2);
});

test('auto-retry never fires when disabled, paused, or for cancelled runs', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  const run = async (title) => {
    const created = await makeTask(base, { title });
    return { id: created.body.id, execution: started.at(-1) };
  };
  const assertPlain = async (taskId, status) => {
    const state = await getState(base);
    const task = findTask(state, taskId);
    assert.equal(task.status, status);
    assert.equal(task.attempts, 0);
    assert.equal(task.blocker, null);
    assert.ok(!state.audit.some((entry) => entry.type === 'task.auto-retried'));
  };

  // (a) autopilot disabled entirely (default policy)
  const a = await run('A');
  await finish(a.execution, 'failed', 1);
  await assertPlain(a.id, 'failed');
  // (b) autopilot on but autoRetry off
  await enable(base);
  const b = await run('B');
  await finish(b.execution, 'failed', 1);
  await assertPlain(b.id, 'failed');
  // (c) room paused at finish time
  await enable(base, { autoRetry: { enabled: true, maxAttempts: 2 } });
  const c = await run('C');
  await app.store.update((state) => { state.room.paused = true; });
  await finish(c.execution, 'failed', 1);
  await assertPlain(c.id, 'failed');
  await app.store.update((state) => { state.room.paused = false; });
  // (d) execution cancelled
  const d = await run('D');
  await finish(d.execution, 'cancelled', null);
  await assertPlain(d.id, 'cancelled');
});

test('manual retry resets the auto-retry budget', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  await enable(base, { autoRetry: { enabled: true, maxAttempts: 1 } });
  const a = await makeTask(base, { title: 'Flaky' });
  await finish(started[0], 'failed', 1);
  await finish(started[1], 'failed', 1);
  let state = await getState(base);
  assert.equal(findTask(state, a.body.id).status, 'failed');
  assert.match(findTask(state, a.body.id).blocker, /retries exhausted/i);
  const retried = await post(base, `/api/tasks/${a.body.id}/retry`, {});
  assert.equal(retried.status, 200);
  state = await getState(base);
  assert.equal(findTask(state, a.body.id).status, 'active');
  assert.equal(findTask(state, a.body.id).attempts, 0);
  assert.equal(findTask(state, a.body.id).blocker, null);
  // A later failure re-enters the fresh auto-retry budget.
  await finish(started[2], 'failed', 1);
  state = await getState(base);
  assert.equal(findTask(state, a.body.id).attempts, 1);
  assert.equal(started.length, 4);
});

test('concurrent finishes with one slot start the queued task exactly once', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  await setLimit(app, 2);
  await makeTask(base, { title: 'A' });
  await makeTask(base, { title: 'B' });
  await setLimit(app, 1);
  const c = await makeTask(base, { title: 'C' });
  assert.equal(started.length, 2);
  await Promise.all([finish(started[0], 'completed', 0), finish(started[1], 'completed', 0)]);
  const state = await getState(base);
  assert.equal(findTask(state, c.body.id).status, 'active');
  assert.equal(started.filter((entry) => entry.taskId === c.body.id).length, 1);
  assert.equal(started.length, 3);
});

test('concurrent finishes with ample capacity start each queued task exactly once', async (context) => {
  const { app, base } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  await setLimit(app, 2);
  await makeTask(base, { title: 'A' });
  await makeTask(base, { title: 'B' });
  const c = await makeTask(base, { title: 'C' });
  const d = await makeTask(base, { title: 'D' });
  assert.equal(started.length, 2);
  await Promise.all([finish(started[0], 'completed', 0), finish(started[1], 'completed', 0)]);
  const state = await getState(base);
  for (const created of [c, d]) {
    assert.equal(findTask(state, created.body.id).status, 'active');
    assert.equal(started.filter((entry) => entry.taskId === created.body.id).length, 1);
  }
  assert.equal(started.length, 4);
});

test('restart migrates state, blocks active tasks, and boot-starts eligible queued tasks', async (context) => {
  const { app, directory } = await makeApp(context);
  stubRunningProcesses(app);
  const queuedId = id('task');
  const activeId = id('task');
  await app.store.update((state) => {
    // Simulate a pre-feature store: no attempts field, no autoRetry policy key.
    state.tasks.unshift({ id: queuedId, title: 'Queued survivor', objective: 'x', agentId: 'claude', accessMode: 'read-only',
      status: 'queued', dependencies: [], blocker: null, executionId: null, createdAt: now(), updatedAt: now() });
    state.tasks.unshift({ id: activeId, title: 'Was running', objective: 'x', agentId: 'claude', accessMode: 'read-only',
      status: 'active', dependencies: [], blocker: null, executionId: 'exec_x', createdAt: now(), updatedAt: now() });
    delete state.policy.autoRetry;
  });
  await withFakeClaudeOnPath(directory, async () => {
    const revived = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
    const { started } = stubRunningProcesses(revived);
    await revived.initialize();
    const state = revived.store.state;
    assert.deepEqual(state.policy.autoRetry, { enabled: false, maxAttempts: 2 });
    const survivor = state.tasks.find((entry) => entry.id === queuedId);
    assert.equal(survivor.attempts, 0);
    assert.equal(survivor.status, 'active');
    assert.equal(started.length, 1);
    assert.equal(started[0].taskId, queuedId);
    const wasActive = state.tasks.find((entry) => entry.id === activeId);
    assert.equal(wasActive.status, 'blocked');
    assert.match(wasActive.blocker, /restarted/);
  });
});

test('a queued task waits for its agent and is picked up by a rescan', async (context) => {
  const { app, base, directory } = await makeApp(context);
  const { started, finish } = stubRunningProcesses(app);
  await seedAgent(app);
  await setLimit(app, 1);
  await makeTask(base, { title: 'A' });
  const b = await makeTask(base, { title: 'B' });
  await seedAgent(app, { status: 'unavailable', connection: 'error', executable: null, version: null });
  await finish(started[0], 'completed', 0);
  let state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'queued'); // skipped, never falsely blocked
  assert.equal(started.length, 1);
  // Retrying a queued task is a no-op refusal; a blocked task still 400s on availability.
  const retryQueued = await post(base, `/api/tasks/${b.body.id}/retry`, {});
  assert.equal(retryQueued.status, 400);
  const blocked = await seedTask(app, { title: 'Blocked', status: 'blocked', blocker: 'x' });
  const retryBlocked = await post(base, `/api/tasks/${blocked.id}/retry`, {});
  assert.equal(retryBlocked.status, 400);
  assert.match(retryBlocked.body.error, /unavailable/);
  // The agent returns and a rescan picks the queued task up.
  await withFakeClaudeOnPath(directory, async () => {
    const scanned = await post(base, '/api/agents/scan', {});
    assert.equal(scanned.status, 200);
  });
  state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'active');
  assert.equal(started.at(-1).taskId, b.body.id);
});

test('a queued task can be cancelled, dep-blocking dependents, and later retried', async (context) => {
  const { app, base } = await makeApp(context);
  stubRunningProcesses(app);
  await seedAgent(app);
  await setLimit(app, 1);
  await makeTask(base, { title: 'A' });
  const b = await makeTask(base, { title: 'B' });
  const c = await makeTask(base, { title: 'C', dependencies: [b.body.id] });
  const cancelled = await post(base, `/api/tasks/${b.body.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  let state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'cancelled');
  assert.ok(state.audit.some((entry) => entry.type === 'task.cancelled' && entry.taskId === b.body.id));
  const blocked = findTask(state, c.body.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blocker, /cancelled/);
  const retried = await post(base, `/api/tasks/${b.body.id}/retry`, {});
  assert.equal(retried.status, 200);
  state = await getState(base);
  assert.equal(findTask(state, b.body.id).status, 'queued'); // the slot is still busy
});

test('selectStartable: pause, FIFO, capacity, bad deps, missing deps, agent skip', () => {
  const agents = [{ id: 'claude', status: 'installed' }];
  const t = (taskId, status, over = {}) => ({
    id: taskId, title: taskId, status, agentId: 'claude', dependencies: [], createdAt: '2026-01-01T00:00:00.000Z', ...over
  });
  const state = (tasks, over = {}) => ({ room: { paused: false, limits: { maxConcurrentRuns: 2 } }, agents, tasks, ...over });

  // Paused → nothing starts, nothing blocks.
  assert.deepEqual(selectStartable(state([t('a', 'queued')], { room: { paused: true, limits: { maxConcurrentRuns: 2 } } }), 0),
    { start: [], block: [] });

  // FIFO by createdAt, tie broken by id; start list capped by free slots while
  // bad-dep blocking continues past capacity.
  const crowded = state([
    t('z-first', 'queued', { createdAt: '2026-01-01T00:00:00.000Z' }),
    t('a-tie', 'queued', { createdAt: '2026-01-01T00:00:01.000Z' }),
    t('b-tie', 'queued', { createdAt: '2026-01-01T00:00:01.000Z' }),
    t('doomed', 'queued', { createdAt: '2026-01-01T00:00:02.000Z', dependencies: ['gone'] }),
    t('sad-wait', 'waiting', { dependencies: ['dead'] }),
    t('ok-wait', 'waiting'),
    t('dead', 'failed')
  ]);
  const picked = selectStartable(crowded, 0);
  assert.deepEqual(picked.start, ['z-first', 'a-tie']);
  assert.deepEqual(picked.block.map((entry) => entry.id).sort(), ['doomed', 'sad-wait']);
  assert.match(picked.block.find((entry) => entry.id === 'doomed').blocker, /no longer exists/);
  assert.match(picked.block.find((entry) => entry.id === 'sad-wait').blocker, /failed/);

  // Merely-unmet deps are skipped without consuming a slot.
  const gated = state([
    t('waiting-on-run', 'queued', { createdAt: '2026-01-01T00:00:00.000Z', dependencies: ['runner'] }),
    t('free', 'queued', { createdAt: '2026-01-01T00:00:01.000Z' }),
    t('runner', 'active')
  ]);
  assert.deepEqual(selectStartable(gated, 1), { start: ['free'], block: [] });

  // A task whose agent is not installed is skipped, never blocked.
  const orphaned = selectStartable({ ...state([t('a', 'queued', { agentId: 'ghost' })]) }, 0);
  assert.deepEqual(orphaned, { start: [], block: [] });
});
