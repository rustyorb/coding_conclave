import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';

test('experimental backup and restore prototypes are not exposed as live APIs', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-backup-api-'));
  const app = new ConclaveApp({
    sessionToken: 'test-token',
    workspace: directory,
    storeFile: path.join(directory, '.state', 'state.json'),
    sqliteMemory: true
  });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  for (const pathname of ['/api/backup', '/api/backup/restore']) {
    const response = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-conclave-token': 'test-token'
      },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'API route not found' });
  }

  assert.equal(app.store.snapshot().audit.some((event) => event.type.startsWith('backup.')), false);
});

test('memory control routes stay token-gated even in open-access mode', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-memory-open-access-'));
  const app = new ConclaveApp({
    sessionToken: 'memory-token',
    openAccess: true,
    workspace: directory,
    storeFile: path.join(directory, '.state', 'state.json')
  });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const denied = await fetch(`${base}/api/memory/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /explicit operator session token/);
});
