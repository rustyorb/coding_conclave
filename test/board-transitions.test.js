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
    return execution;
  };
  const address = await app.listen({ port: 0 });
  return { app, started, directory, base: `http://127.0.0.1:${address.port}` };
}

const post = (base, route, body = {}) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});

const codexAgent = (activity = 'idle') => ({
  id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified',
  activity, executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready'
});

const taskRow = (id, { status = 'completed', origin = 'operator', archivedAt = null, agentId = 'codex', objective = 'obj' } = {}) => ({
  id, title: `Title of ${id}`, objective, agentId, accessMode: 'read-only',
  origin, priority: 'none', status, archivedAt, source: null, dependencies: [],
  blocker: null, executionId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
});

test('archive-legacy archives only terminal, unarchived message-origin tasks and audits once', async (context) => {
  const { app, directory, base } = await makeApp('conclave-legacy-', (state) => {
    state.agents = [codexAgent()];
    state.tasks.unshift(
      taskRow('legacy_done', { origin: 'message', status: 'completed' }),
      taskRow('legacy_failed', { origin: 'message', status: 'failed' }),
      taskRow('legacy_active', { origin: 'message', status: 'active' }),
      taskRow('legacy_archived', { origin: 'message', status: 'cancelled', archivedAt: '2026-01-01T00:00:00.000Z' }),
      taskRow('operator_done', { origin: 'operator', status: 'completed' }),
      taskRow('promoted_rejected', { origin: 'promoted', status: 'rejected' })
    );
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const response = await post(base, '/api/tasks/archive-legacy');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { archived: 2 });

  const byId = (id) => app.store.state.tasks.find((entry) => entry.id === id);
  assert.ok(byId('legacy_done').archivedAt, 'terminal legacy task is archived');
  assert.ok(byId('legacy_failed').archivedAt, 'failed legacy task is archived');
  assert.equal(byId('legacy_active').archivedAt, null, 'active legacy task is untouched');
  assert.equal(byId('legacy_archived').archivedAt, '2026-01-01T00:00:00.000Z', 'already-archived task keeps its timestamp');
  assert.equal(byId('operator_done').archivedAt, null, 'operator task is untouched');
  assert.equal(byId('promoted_rejected').archivedAt, null, 'promoted task is untouched');

  const auditEntries = app.store.state.audit.filter((entry) => entry.type === 'task.legacy-archived');
  assert.equal(auditEntries.length, 1, 'one audit event covers the whole sweep');
  assert.equal(auditEntries[0].detail.count, 2);
  assert.deepEqual([...auditEntries[0].detail.taskIds].sort(), ['legacy_done', 'legacy_failed']);

  const second = await post(base, '/api/tasks/archive-legacy');
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { archived: 0 });
  assert.equal(app.store.state.audit.filter((entry) => entry.type === 'task.legacy-archived').length, 1,
    'a no-op sweep writes no audit event');
});

test('transitions endpoint allows only proposed → ready and hands the task to the drainer', async (context) => {
  const { app, started, directory, base } = await makeApp('conclave-transition-', (state) => {
    state.agents = [codexAgent(), { ...codexAgent(), id: 'ghost', name: 'Ghost', status: 'unavailable' }];
    state.tasks.unshift(
      taskRow('task_proposed', { status: 'proposed' }),
      taskRow('task_ready', { status: 'ready' }),
      taskRow('task_ghost', { status: 'proposed', agentId: 'ghost' })
    );
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const fromReady = await post(base, '/api/tasks/task_ready/transitions', { to: 'ready' });
  assert.equal(fromReady.status, 400, 'a ready task cannot transition again');
  assert.match((await fromReady.json()).error, /proposed → ready/);

  const toCompleted = await post(base, '/api/tasks/task_proposed/transitions', { to: 'completed' });
  assert.equal(toCompleted.status, 400, 'only ready is a valid destination');
  assert.match((await toCompleted.json()).error, /proposed → ready/);

  const unknown = await post(base, '/api/tasks/task_missing/transitions', { to: 'ready' });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, 'Task not found');

  const ghost = await post(base, '/api/tasks/task_ghost/transitions', { to: 'ready' });
  assert.equal(ghost.status, 400, 'a proposed task with an unavailable agent is rejected');
  assert.equal(app.store.state.tasks.find((entry) => entry.id === 'task_ghost').status, 'proposed');

  assert.equal(started.length, 0, 'rejected transitions never start a run');

  // Park the seeded ready task so the drainer's only candidate is the transitioned one.
  await app.store.update((state) => { state.tasks.find((entry) => entry.id === 'task_ready').status = 'completed'; });

  const accepted = await post(base, '/api/tasks/task_proposed/transitions', { to: 'ready' });
  assert.equal(accepted.status, 200);
  assert.equal(started.length, 1, 'the drainer starts the task once the agent is free');
  assert.equal(started[0].taskId, 'task_proposed');
  assert.equal(app.store.state.tasks.find((entry) => entry.id === 'task_proposed').status, 'active');
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'task.transitioned' && entry.taskId === 'task_proposed'));
});
