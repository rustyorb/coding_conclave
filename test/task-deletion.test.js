import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';

const token = 'test-token';

const agentRow = (id, overrides = {}) => ({
  id,
  name: id === 'codex' ? 'Codex' : 'Claude',
  provider: 'Test',
  status: 'installed',
  connection: 'verified',
  activity: 'idle',
  executable: `${id}-fake`,
  version: 'test',
  currentTaskId: null,
  lastAction: 'Ready',
  ...overrides
});

const taskRow = (id, overrides = {}) => ({
  id,
  title: `Title of ${id}`,
  objective: 'Test deletion safety',
  agentId: 'codex',
  accessMode: 'read-only',
  origin: 'operator',
  source: null,
  priority: 'none',
  status: 'blocked',
  archivedAt: null,
  dependencies: [],
  attempts: 0,
  blocker: null,
  executionId: null,
  createdAt: '2026-07-16T20:00:00.000Z',
  updatedAt: '2026-07-16T20:00:00.000Z',
  ...overrides
});

async function startApp(directory, seed) {
  const storeFile = path.join(directory, '.state', 'state.json');
  const app = new ConclaveApp({
    sessionToken: token,
    workspace: directory,
    storeFile,
    idleWatchdogIntervalMs: 0
  });
  await app.initialize();
  if (seed) await app.store.update(seed);
  const address = await app.listen({ port: 0 });
  return { app, storeFile, base: `http://127.0.0.1:${address.port}` };
}

const deleteTask = (base, taskId, body = {}) => fetch(`${base}/api/tasks/${taskId}`, {
  method: 'DELETE',
  headers: { 'content-type': 'application/json', 'x-conclave-token': token },
  body: JSON.stringify(body)
});

test('task deletion requires exact confirmation and blocks active tasks until cancellation finishes', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-delete-active-'));
  const { app, base } = await startApp(directory, (state) => {
    state.agents = [agentRow('codex', { activity: 'running', currentTaskId: 'task_active' })];
    state.tasks = [taskRow('task_active', { status: 'active', executionId: 'exec_active' })];
    state.executions = [{
      id: 'exec_active', taskId: 'task_active', agentId: 'codex', kind: 'agent',
      status: 'running', exitCode: null, output: '', startedAt: '2026-07-16T20:00:00.000Z', finishedAt: null
    }];
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const unconfirmed = await deleteTask(base, 'task_active');
  assert.equal(unconfirmed.status, 400);
  assert.match((await unconfirmed.json()).error, /exact task id/);
  assert.equal(app.store.state.tasks.length, 1, 'failed confirmation leaves the task intact');
  assert.equal(app.store.state.taskDeletions.length, 0);

  const active = await deleteTask(base, 'task_active', { confirmTaskId: 'task_active' });
  assert.equal(active.status, 409);
  assert.match((await active.json()).error, /Cancel the active task/);
  assert.equal(app.store.state.tasks[0].status, 'active');

  await app.store.update((state) => {
    Object.assign(state.tasks[0], { status: 'cancelled', blocker: 'Cancelled by the operator.', updatedAt: '2026-07-16T20:01:00.000Z' });
    Object.assign(state.executions[0], { status: 'cancelled', finishedAt: '2026-07-16T20:01:00.000Z' });
    Object.assign(state.agents[0], { activity: 'idle', currentTaskId: null });
  });

  const cancelled = await deleteTask(base, 'task_active', { confirmTaskId: 'task_active' });
  assert.equal(cancelled.status, 200);
  const result = await cancelled.json();
  assert.equal(result.deleted, true);
  assert.equal(result.deletion.taskId, 'task_active');
  assert.equal(result.deletion.statusAtDeletion, 'cancelled');
  assert.equal(app.store.state.tasks.length, 0);
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'task.deleted' && entry.taskId === 'task_active'));
});

test('deleted tasks stay absent after restart, cannot be drained, and retain durable audit tombstones', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-delete-persist-'));
  let current;
  context.after(async () => {
    if (current) await current.app.close();
    await rm(directory, { recursive: true, force: true });
  });

  current = await startApp(directory, (state) => {
    state.agents = [agentRow('codex'), agentRow('claude')];
    state.tasks = [
      taskRow('task_obsolete', { status: 'ready' }),
      taskRow('task_dependent', {
        title: 'Dependent work',
        agentId: 'claude',
        accessMode: 'workspace-write',
        status: 'waiting',
        dependencies: ['task_obsolete']
      })
    ];
    state.approvals = [{
      id: 'approval_dependent', type: 'agent-write', taskId: 'task_dependent', agentId: 'claude',
      status: 'pending', createdAt: '2026-07-16T20:00:00.000Z'
    }];
  });

  const response = await deleteTask(current.base, 'task_obsolete', { confirmTaskId: 'task_obsolete' });
  assert.equal(response.status, 200);
  assert.equal(current.app.store.state.tasks.some((entry) => entry.id === 'task_obsolete'), false);
  const dependent = current.app.store.state.tasks.find((entry) => entry.id === 'task_dependent');
  assert.equal(dependent.status, 'blocked', 'deleting a dependency cannot release downstream work');
  assert.match(dependent.blocker, /was deleted/);
  assert.equal(current.app.store.state.approvals[0].status, 'expired');
  assert.deepEqual(current.app.store.state.taskDeletions[0].dependentTaskIds, ['task_dependent']);

  await current.app.store.update((state) => {
    for (let index = 0; index < 2_005; index += 1) {
      state.audit.push({ id: `audit_noise_${index}`, type: 'execution.output', createdAt: new Date().toISOString() });
    }
    if (state.audit.length > 2_000) state.audit.splice(0, state.audit.length - 2_000);
  });
  assert.equal(current.app.store.state.audit.some((entry) => entry.type === 'task.deleted'), false,
    'the capped recent audit can evict task.deleted');
  assert.equal(current.app.store.state.taskDeletions[0].taskId, 'task_obsolete',
    'the durable deletion ledger survives recent-audit eviction');

  await current.app.close();
  current = await startApp(directory);
  const started = [];
  current.app.processes.start = ({ taskId }) => {
    started.push(taskId);
    throw new Error('No deleted or dependency-blocked task should start');
  };
  await current.app.startQueuedTasks();

  assert.equal(current.app.store.state.tasks.some((entry) => entry.id === 'task_obsolete'), false,
    'the deleted row does not reappear after loading persisted state');
  assert.equal(current.app.store.state.taskDeletions[0].taskId, 'task_obsolete');
  assert.deepEqual(started, [], 'neither the deleted task nor its blocked dependent becomes assignable');

  const projected = await (await fetch(`${current.base}/api/state`)).json();
  assert.equal(projected.tasks.some((entry) => entry.id === 'task_obsolete'), false);
  assert.equal(projected.taskDeletions[0].taskId, 'task_obsolete', 'the durable audit record is visible through the API');
});
