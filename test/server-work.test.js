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

test('US-018: promoting a message creates a task with a source snapshot that requires review', async (context) => {
  const { app, started, directory, base } = await makeApp('conclave-promote-', (state) => {
    state.agents = [codexAgent()];
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const messageResponse = await post(base, '/api/messages', {
    content: 'The flaky test is caused by a shared temp directory.'
  });
  const { message } = await messageResponse.json();
  assert.equal(app.store.state.tasks.length, 0);

  const promoteResponse = await post(base, `/api/messages/${message.id}/promote`, {
    title: 'Fix the flaky test',
    objective: 'Isolate the temp directory per test and prove it passes repeatedly.',
    agentId: 'codex', accessMode: 'read-only', priority: 'high'
  });
  assert.equal(promoteResponse.status, 201);
  const task = await promoteResponse.json();
  assert.equal(task.origin, 'promoted');
  assert.equal(task.priority, 'high');
  assert.equal(task.source.messageId, message.id);
  assert.equal(task.source.content, 'The flaky test is caused by a shared temp directory.');
  assert.equal(started.length, 1);

  await app.onProcessEvent({
    type: 'execution.finished', executionId: started[0].id, taskId: task.id, agentId: 'codex',
    exitCode: 0, signal: null, status: 'completed', finishedAt: new Date().toISOString()
  });
  assert.equal(
    app.store.state.tasks.find((entry) => entry.id === task.id).status,
    'review-required',
    'promoted tasks require operator review; only legacy message-origin tasks auto-resolve'
  );
});

test('US-017: queued chat turns cancel cleanly and terminal chat turns can be retried', async (context) => {
  const { app, started, directory, base } = await makeApp('conclave-chat-retry-', (state) => {
    state.agents = [codexAgent('running')];
    state.messages.push({
      id: 'msg_source', source: 'user', sourceName: 'You', type: 'message',
      content: 'What is the riskiest module?', createdAt: new Date().toISOString()
    });
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const message = app.store.state.messages.find((entry) => entry.id === 'msg_source');
  const turn = await app.createChatTurn(message, app.store.state.agents[0]);
  assert.equal(app.store.state.chatTurns.find((entry) => entry.id === turn.id).status, 'queued');
  assert.equal(started.length, 0, 'a busy agent leaves the turn queued');

  const cancelResponse = await post(base, `/api/chat-turns/${turn.id}/cancel`);
  assert.equal(cancelResponse.status, 200);
  assert.equal(app.store.state.chatTurns.find((entry) => entry.id === turn.id).status, 'cancelled');

  await app.store.update((state) => { state.agents[0].activity = 'idle'; });
  const retryResponse = await post(base, `/api/chat-turns/${turn.id}/retry`);
  assert.equal(retryResponse.status, 201);
  const retried = await retryResponse.json();
  assert.equal(retried.retryOf, turn.id);
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, 'chat');
  assert.equal(app.store.state.tasks.length, 0, 'chat retries never create tasks');

  const badRetry = await post(base, `/api/chat-turns/${retried.id}/retry`);
  assert.equal(badRetry.status, 400, 'an active turn cannot be retried');
});

test('FR-TASK-016: only terminal tasks archive, and archiving is reversible', async (context) => {
  const taskRow = (id, status) => ({
    id, title: id, objective: 'obj', agentId: 'codex', accessMode: 'read-only',
    origin: 'operator', priority: 'none', status, archivedAt: null, dependencies: [],
    blocker: null, executionId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  const { app, directory, base } = await makeApp('conclave-archive-', (state) => {
    state.tasks.unshift(taskRow('task_done', 'completed'), taskRow('task_live', 'active'));
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const archived = await post(base, '/api/tasks/task_done/archive');
  assert.equal(archived.status, 200);
  assert.ok(app.store.state.tasks.find((entry) => entry.id === 'task_done').archivedAt);

  const rejected = await post(base, '/api/tasks/task_live/archive');
  assert.equal(rejected.status, 400);
  assert.equal(app.store.state.tasks.find((entry) => entry.id === 'task_live').archivedAt, null);

  const unarchived = await post(base, '/api/tasks/task_done/unarchive');
  assert.equal(unarchived.status, 200);
  assert.equal(app.store.state.tasks.find((entry) => entry.id === 'task_done').archivedAt, null);
});
