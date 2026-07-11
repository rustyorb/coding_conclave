import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';

test('HTTP API persists chat and requires a decision before command execution', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-api-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const messageResponse = await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Human checkpoint' })
  });
  assert.equal(messageResponse.status, 201);
  assert.equal((await messageResponse.json()).tasksCreated, 0);

  const commandResponse = await fetch(`${base}/api/commands`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'node --version', purpose: 'Verify Node' })
  });
  assert.equal(commandResponse.status, 201);
  const approval = await commandResponse.json();
  assert.equal(app.processes.running.size, 0);
  assert.equal(approval.status, 'pending');

  const decisionResponse = await fetch(`${base}/api/approvals/${approval.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'denied' })
  });
  assert.equal(decisionResponse.status, 200);
  assert.equal((await decisionResponse.json()).status, 'denied');
  assert.equal(app.processes.running.size, 0);

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.ok(state.messages.some((message) => message.content === 'Human checkpoint'));
  assert.equal(state.approvals[0].status, 'denied');
});
