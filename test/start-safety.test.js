import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';

async function makeApp(prefix, seed) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  if (seed) await app.store.update(seed);
  const started = [];
  app.processes.start = ({ taskId, agentId, kind }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind, purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push(execution);
    // Mirror the real ProcessManager: the child is registered before start() returns.
    app.processes.running.set(execution.id, { pid: 0 });
    return execution;
  };
  const address = await app.listen({ port: 0 });
  return { app, started, directory, base: `http://127.0.0.1:${address.port}` };
}

const post = (base, route, body = {}) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});

const agentRow = (id, name, activity = 'idle') => ({
  id, name, provider: 'Test', status: 'installed', connection: 'verified',
  activity, executable: `${id}-fake`, version: 'test', currentTaskId: null, lastAction: 'Ready'
});

const taskRow = (id, overrides = {}) => ({
  id, title: id, objective: `objective for ${id}`, agentId: 'codex', accessMode: 'read-only',
  origin: 'operator', priority: 'none', source: null, archivedAt: null, status: 'ready',
  dependencies: [], attempts: 0, blocker: null, executionId: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides
});

test('C1: marking a proposed workspace-write task ready routes through a pending approval, never straight to a run', async (context) => {
  const { app, started, directory, base } = await makeApp('conclave-c1-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
    state.tasks.unshift(taskRow('task_write_prop', { status: 'proposed', accessMode: 'workspace-write' }));
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const response = await post(base, '/api/tasks/task_write_prop/transitions', { to: 'ready' });
  assert.equal(response.status, 200);
  const task = app.store.state.tasks.find((entry) => entry.id === 'task_write_prop');
  assert.equal(task.status, 'waiting', 'write task waits for authority');
  const approval = app.store.state.approvals.find((entry) => entry.taskId === 'task_write_prop');
  assert.ok(approval, 'a pending approval was created');
  assert.equal(approval.status, 'pending');
  assert.equal(started.length, 0, 'no run launched without a decision');

  await app.decideApproval(approval.id, 'approved');
  assert.equal(started.length, 1, 'the run starts only after the operator approves');
});

test('M1: a manual approval whose start fails is returned to pending instead of being consumed', async (context) => {
  const { app, started, directory, base } = await makeApp('conclave-m1-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  await post(base, '/api/tasks', {
    title: 'Write something', objective: 'obj', agentId: 'codex', accessMode: 'workspace-write'
  });
  const approval = app.store.state.approvals[0];
  assert.equal(approval.status, 'pending');

  // The agent disappears between request and decision.
  await app.store.update((state) => { state.agents[0].status = 'unavailable'; });
  const decision = await post(base, `/api/approvals/${approval.id}`, { decision: 'approved' });
  assert.equal(decision.status, 400);

  const after = app.store.state.approvals.find((entry) => entry.id === approval.id);
  assert.equal(after.status, 'pending', 'the approval is recoverable, not consumed');
  assert.equal(after.decidedAt, null);
  assert.equal(started.length, 0);
  const task = app.store.state.tasks[0];
  assert.equal(task.status, 'waiting', 'the task still waits on the recovered approval');
});

test('M2: concurrent start attempts on one ready task launch exactly one run', async (context) => {
  const { app, started, directory } = await makeApp('conclave-m2-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
    state.tasks.unshift(taskRow('task_race'));
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const results = await Promise.all([
    app.startTask('task_race'),
    app.startTask('task_race'),
    app.startTask('task_race')
  ]);
  assert.equal(started.length, 1, 'only one process starts');
  assert.equal(results.filter(Boolean).length, 1, 'exactly one caller wins the reservation');
  assert.equal(app.store.state.tasks.find((entry) => entry.id === 'task_race').status, 'active');
});

test('M2: concurrent drains cannot start two tasks for one agent', async (context) => {
  const { app, started, directory } = await makeApp('conclave-m2b-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
    state.tasks.unshift(
      taskRow('task_a', { createdAt: '2026-01-01T00:00:00.000Z' }),
      taskRow('task_b', { createdAt: '2026-01-01T00:00:01.000Z' })
    );
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  await Promise.all([app.startQueuedTasks(), app.startQueuedTasks()]);
  assert.equal(started.length, 1, 'one run per agent survives concurrent drains');
  const statuses = app.store.state.tasks.map((entry) => entry.status).sort();
  assert.deepEqual(statuses, ['active', 'ready']);
});
