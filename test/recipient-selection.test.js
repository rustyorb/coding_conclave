import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRecipientSelection } from '../public/recipient-selection.js';
import { ConclaveApp } from '../src/server.js';

const agent = (id, status = 'installed') => ({ id, status });

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('General Chat defaults to every installed agent and follows newly activated agents', () => {
  const selection = createRecipientSelection();

  assert.deepEqual(selection.sync([
    agent('codex'), agent('claude'), agent('gemini', 'unavailable')
  ]), {
    selectedIds: ['codex', 'claude'],
    everyoneActive: true
  });

  assert.deepEqual(selection.sync([
    agent('codex'), agent('claude'), agent('gemini')
  ]), {
    selectedIds: ['codex', 'claude', 'gemini'],
    everyoneActive: true
  });
});

test('explicit No one and subset choices survive refreshes', () => {
  const agents = [agent('codex'), agent('claude'), agent('grok')];
  const selection = createRecipientSelection();
  selection.sync(agents);

  assert.deepEqual(selection.select('room', agents), {
    selectedIds: [],
    everyoneActive: false
  });
  assert.deepEqual(selection.sync([...agents, agent('gemini')]), {
    selectedIds: [],
    everyoneActive: false
  });

  assert.deepEqual(selection.select('claude', agents), {
    selectedIds: ['claude'],
    everyoneActive: false
  });
  assert.deepEqual(selection.sync([agent('codex'), agent('claude', 'unavailable'), agent('grok')]), {
    selectedIds: [],
    everyoneActive: false
  });
});

test('individual selection can narrow Everyone and the Everyone control toggles fan-out', () => {
  const agents = [agent('codex'), agent('claude')];
  const selection = createRecipientSelection();
  selection.sync(agents);

  assert.deepEqual(selection.select('claude', agents), {
    selectedIds: ['codex'],
    everyoneActive: false
  });
  assert.deepEqual(selection.select('everyone', agents), {
    selectedIds: ['codex', 'claude'],
    everyoneActive: true
  });
  assert.deepEqual(selection.select('everyone', agents), {
    selectedIds: [],
    everyoneActive: false
  });
});

test('the default audience fans one message out as read-only chat and never creates work', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-chat-defaults-'));
  const app = new ConclaveApp({
    sessionToken: 'test-token',
    workspace: directory,
    storeFile: path.join(directory, '.state', 'state.json')
  });
  await app.initialize();
  await app.store.update((state) => {
    state.agents = [
      { ...agent('codex'), name: 'Codex', provider: 'Test', connection: 'verified', activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready' },
      { ...agent('claude'), name: 'Claude', provider: 'Test', connection: 'verified', activity: 'idle', executable: 'claude-fake', version: 'test', currentTaskId: null, lastAction: 'Ready' }
    ];
  });
  const started = [];
  app.processes.start = ({ taskId, agentId, kind, invocation }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind, purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push({ execution, invocation });
    return execution;
  };
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const audience = createRecipientSelection().sync(app.store.state.agents);
  const response = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' },
    body: JSON.stringify({ content: 'Hey room, what do you think?', agentIds: audience.selectedIds })
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    message: app.store.state.messages.at(-1),
    tasksCreated: 0,
    chatTurnsCreated: 2
  });
  assert.equal(app.store.state.tasks.length, 0);
  assert.equal(app.store.state.approvals.length, 0);
  assert.equal(app.store.state.chatTurns.length, 2);
  await waitFor(() => started.length === 2, 'the asynchronous queue drainer should launch both chat turns');
  const codex = started.find((entry) => entry.execution.agentId === 'codex').invocation;
  const claude = started.find((entry) => entry.execution.agentId === 'claude').invocation;
  assert.equal(codex.args[codex.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(claude.args[claude.args.indexOf('--permission-mode') + 1], 'plan');
});
