import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';
import { id as generateId, now } from '../src/lib/utils.js';

const TOKEN = 'test-token';

function post(base, pathname, body, { token = TOKEN } = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-conclave-token': token } : {}) },
    body: JSON.stringify(body)
  });
}

test('curated memory ledger API: create, update, pin, and associate sources', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-memory-api-'));
  const storeFile = path.join(directory, '.state', 'state.json');
  const app = new ConclaveApp({ sessionToken: TOKEN, workspace: directory, storeFile });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const messageA = { id: generateId('msg'), source: 'user', sourceName: 'You', type: 'message', content: 'Decision: the ledger lives in state.json for the JSON bridge.', createdAt: now() };
  const messageB = { id: generateId('msg'), source: 'codex', sourceName: 'Codex', type: 'message', content: 'Agreed — memory.items with provenance edges.', createdAt: now() };
  await app.store.update((state) => state.messages.push(messageA, messageB));

  // Create: proposed item with a required source edge.
  const createResponse = await post(base, '/api/memory/items', {
    kind: 'decision',
    title: 'Ledger lives in state.json',
    statement: 'The Tier 3 curated ledger persists in state.json until the SQLite migration.',
    sources: [{ messageId: messageA.id }]
  });
  assert.equal(createResponse.status, 201);
  const { item, sources } = await createResponse.json();
  assert.equal(item.status, 'proposed');
  assert.equal(item.version, 1);
  assert.equal(sources[0].supportRole, 'required');
  assert.equal(sources[0].messageId, messageA.id);

  // Creation without a source is rejected (spec §6.2 precondition).
  const sourceless = await post(base, '/api/memory/items', {
    kind: 'fact', title: 'No provenance', statement: 'Should fail.'
  });
  assert.equal(sourceless.status, 400);

  // Update: stale expectedVersion conflicts with 409 and changes nothing.
  const conflict = await post(base, `/api/memory/items/${item.id}`, {
    statement: 'Rewritten.', expectedVersion: 7
  });
  assert.equal(conflict.status, 409);
  const update = await post(base, `/api/memory/items/${item.id}`, {
    statement: 'The Tier 3 ledger persists in state.json; SQLite is the migration target.',
    expectedVersion: 1
  });
  assert.equal(update.status, 200);
  const updated = (await update.json()).item;
  assert.equal(updated.version, 2);
  assert.ok(updated.statement.includes('SQLite is the migration target'));

  // Pin: version-checked toggle.
  const pin = await post(base, `/api/memory/items/${item.id}/pin`, { pinned: true, expectedVersion: 2 });
  assert.equal(pin.status, 200);
  assert.equal((await pin.json()).item.pinned, true);

  // Associate a second source message; later edges default to supplemental.
  const addSource = await post(base, `/api/memory/items/${item.id}/sources`, {
    messageId: messageB.id, expectedVersion: 3
  });
  assert.equal(addSource.status, 200);
  const associated = await addSource.json();
  assert.equal(associated.source.supportRole, 'supplemental');
  assert.equal(associated.item.version, 4);
  assert.equal(associated.item.supportState, 'available');
  const duplicate = await post(base, `/api/memory/items/${item.id}/sources`, {
    messageId: messageB.id, expectedVersion: 4
  });
  assert.equal(duplicate.status, 400);

  // /api/state projects items + sources but not the revision history.
  const lockedProjection = await (await fetch(`${base}/api/state`)).json();
  assert.equal(lockedProjection.memory.locked, true);
  assert.equal(lockedProjection.memory.itemsTotal, 1);
  assert.deepEqual(lockedProjection.memory.items, []);
  assert.deepEqual(lockedProjection.memory.sources, []);

  const stateResponse = await fetch(`${base}/api/state`, { headers: { 'x-conclave-token': TOKEN } });
  assert.equal(stateResponse.status, 200);
  const projected = await stateResponse.json();
  assert.equal(projected.memory.itemsTotal, 1);
  assert.equal(projected.memory.items[0].id, item.id);
  assert.equal(projected.memory.items[0].pinned, true);
  assert.equal(projected.memory.sources.length, 2);
  assert.equal(projected.memory.locked, false);
  assert.ok(!('itemRevisions' in projected.memory));

  // The full ledger (including revisions) is persisted in state.json.
  const persisted = JSON.parse(await readFile(storeFile, 'utf8'));
  assert.equal(persisted.memory.items.length, 1);
  assert.equal(persisted.memory.items[0].version, 4);
  assert.equal(persisted.memory.itemRevisions.length, 2);
  assert.equal(persisted.memory.sources.length, 2);

  // Every mutation left an audit event.
  const auditTypes = app.store.snapshot().audit.map((event) => event.type);
  for (const expected of ['memory.proposed', 'memory.revised', 'memory.pinned', 'memory.source-added']) {
    assert.ok(auditTypes.includes(expected), `audit missing ${expected}`);
  }
});

test('memory ledger mutations require the operator session token', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-memory-auth-'));
  const app = new ConclaveApp({
    sessionToken: TOKEN, workspace: directory,
    storeFile: path.join(directory, '.state', 'state.json')
  });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const untokened = await post(base, '/api/memory/items', {
    kind: 'fact', title: 'x', statement: 'x', sources: []
  }, { token: null });
  assert.equal(untokened.status, 403);
  assert.equal(app.store.snapshot().memory.items.length, 0);
});
