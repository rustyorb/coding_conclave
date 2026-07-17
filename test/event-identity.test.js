import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore, ensureEventIdentity, initialState } from '../src/lib/store.js';
import { ConclaveApp } from '../src/server.js';

const TOKEN = 'test-token';

async function tempStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-event-identity-'));
  return { directory, file: path.join(directory, '.state', 'state.json') };
}

function legacyStateFixture(workspace) {
  return {
    version: 2,
    room: {
      id: 'room_legacy', name: 'Legacy room', workspace, mode: 'general-chat',
      paused: false, coordinatorId: null, roles: {}, createdAt: '2026-07-01T00:00:00.000Z',
      limits: { maxTurnsPerAgent: 12, maxConcurrentRuns: 3, timeoutMinutes: 20 }
    },
    agents: [], tasks: [], chatTurns: [], approvals: [], executions: [],
    workspace: { status: [], diff: '', refreshedAt: '2026-07-01T00:00:00.000Z' },
    messages: [
      { id: 'msg_a', source: 'system', sourceName: 'Conclave', type: 'system', content: 'first', createdAt: '2026-07-01T00:00:00.000Z' },
      { id: 'msg_b', source: 'user', sourceName: 'You', type: 'message', content: 'no timestamp' },
      { id: 'msg_c', source: 'user', sourceName: 'You', type: 'message', content: 'bad timestamp', createdAt: 'not-a-date' }
    ],
    audit: [
      { id: 'audit_a', type: 'task.created', createdAt: '2026-07-01T00:00:01.000Z' }
    ]
  };
}

test('initialState mints a stamped seed event and a counter pointing past it', () => {
  const state = initialState('C:\\workspace');
  assert.equal(state.events.nextSequence, 2);
  const seed = state.messages[0];
  assert.equal(seed.seq, 1);
  assert.equal(seed.recordedAt, seed.createdAt);
  assert.ok(!Number.isNaN(Date.parse(seed.recordedAt)));
});

test('legacy states backfill deterministic sequences in persisted order and flag bad timestamps', async () => {
  const { directory, file } = await tempStore();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(legacyStateFixture(directory), null, 2), 'utf8');

    const store = new JsonStore(file, directory);
    const state = await store.load();

    // Persisted array order, messages first then audit — never re-sorted by timestamp.
    assert.deepEqual(state.messages.map((entry) => entry.seq), [1, 2, 3]);
    assert.equal(state.audit[0].seq, 4);
    assert.equal(state.events.nextSequence, 5);

    // Valid history keeps its timestamp untouched and gains no invented recordedAt.
    assert.equal(state.messages[0].createdAt, '2026-07-01T00:00:00.000Z');
    assert.equal(state.messages[0].timestampStatus, undefined);
    assert.equal(state.messages[0].recordedAt, undefined);
    // Anomalies are flagged, not repaired.
    assert.equal(state.messages[1].timestampStatus, 'legacy-missing');
    assert.equal(state.messages[1].createdAt, undefined);
    assert.equal(state.messages[2].timestampStatus, 'legacy-invalid');
    assert.equal(state.messages[2].createdAt, 'not-a-date');

    // Backfill is deterministic: a second load of the same untouched file
    // assigns the identical sequences, so restarts cannot reshuffle identity.
    const again = await new JsonStore(file, directory).load();
    assert.deepEqual(again.messages.map((entry) => entry.seq), [1, 2, 3]);
    assert.equal(again.audit[0].seq, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a persisted counter is never lowered, so pruned records keep their numbers retired', async () => {
  const { directory, file } = await tempStore();
  try {
    const fixture = legacyStateFixture(directory);
    fixture.events = { nextSequence: 40 };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(fixture, null, 2), 'utf8');

    const store = new JsonStore(file, directory);
    const state = await store.load();
    assert.deepEqual(state.messages.map((entry) => entry.seq), [40, 41, 42]);
    assert.equal(state.audit[0].seq, 43);
    assert.equal(state.events.nextSequence, 44);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('update() stamps appended records: monotonic seq, server UTC recordedAt, same-millisecond order', async () => {
  const { directory, file } = await tempStore();
  try {
    const store = new JsonStore(file, directory);
    await store.load();

    const sharedInstant = '2026-07-15T12:00:00.000Z';
    await store.update((state) => {
      state.messages.push(
        { id: 'msg_one', source: 'user', sourceName: 'You', type: 'message', content: 'first', createdAt: sharedInstant },
        { id: 'msg_two', source: 'user', sourceName: 'You', type: 'message', content: 'second, same millisecond', createdAt: sharedInstant },
        { id: 'msg_three', source: 'user', sourceName: 'You', type: 'message', content: 'push site forgot createdAt' }
      );
      state.audit.push({ id: 'audit_one', type: 'task.created', createdAt: sharedInstant });
    });

    const state = store.state;
    // Seed message keeps seq 1; new records continue 2, 3, 4, then audit 5.
    assert.deepEqual(state.messages.map((entry) => entry.seq), [1, 2, 3, 4]);
    assert.equal(state.audit[0].seq, 5);
    assert.equal(state.events.nextSequence, 6);

    // Identical wall-clock timestamps no longer tie: seq preserves append order.
    const [, one, two] = state.messages;
    assert.equal(one.createdAt, two.createdAt);
    assert.ok(one.seq < two.seq);

    // recordedAt is server-authored UTC at commit, on every new record.
    for (const record of [...state.messages.slice(1), state.audit[0]]) {
      assert.ok(record.recordedAt.endsWith('Z'));
      assert.ok(!Number.isNaN(Date.parse(record.recordedAt)));
    }

    // A missing source timestamp is filled with the commit time and disclosed.
    const three = state.messages[3];
    assert.equal(three.createdAt, three.recordedAt);
    assert.equal(three.timestampStatus, 'source-missing');
    assert.equal(one.timestampStatus, undefined);

    // The stamps are persisted, not in-memory only.
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(persisted.messages.map((entry) => entry.seq), [1, 2, 3, 4]);
    assert.equal(persisted.events.nextSequence, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sequences survive restart with no reuse and no duplicates across streams', async () => {
  const { directory, file } = await tempStore();
  try {
    const first = new JsonStore(file, directory);
    await first.load();
    await first.update((state) => {
      state.messages.push({ id: 'msg_pre', source: 'user', sourceName: 'You', type: 'message', content: 'before restart', createdAt: '2026-07-15T12:00:00.000Z' });
      state.audit.push({ id: 'audit_pre', type: 'chat.created', createdAt: '2026-07-15T12:00:00.000Z' });
    });
    const highWater = first.state.events.nextSequence;

    const second = new JsonStore(file, directory);
    const state = await second.load();
    assert.equal(state.events.nextSequence, highWater);
    await second.update((next) => {
      next.messages.push({ id: 'msg_post', source: 'user', sourceName: 'You', type: 'message', content: 'after restart', createdAt: '2026-07-15T12:01:00.000Z' });
    });
    assert.equal(state.messages.at(-1).seq, highWater);

    const all = [...state.messages, ...state.audit].map((entry) => entry.seq);
    assert.equal(new Set(all).size, all.length);
    assert.ok(all.every((seq) => Number.isSafeInteger(seq) && seq >= 1));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('event identity flows through the message API and the /api/state projection', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-event-identity-api-'));
  const storeFile = path.join(directory, '.state', 'state.json');
  const app = new ConclaveApp({ sessionToken: TOKEN, workspace: directory, storeFile });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const send = (content) => fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-conclave-token': TOKEN },
    body: JSON.stringify({ content, agentIds: [] })
  });

  const firstResponse = await send('Event identity: first message.');
  assert.equal(firstResponse.status, 201);
  const firstMessage = (await firstResponse.json()).message;
  const secondResponse = await send('Event identity: second message.');
  assert.equal(secondResponse.status, 201);
  const secondMessage = (await secondResponse.json()).message;

  // The API response carries the committed identity, already stamped.
  assert.ok(Number.isSafeInteger(firstMessage.seq));
  assert.ok(secondMessage.seq > firstMessage.seq);
  assert.ok(firstMessage.recordedAt.endsWith('Z'));

  const state = await (await fetch(`${base}/api/state`)).json();
  const projected = state.messages.filter((entry) => [firstMessage.id, secondMessage.id].includes(entry.id));
  assert.deepEqual(projected.map((entry) => entry.seq), [firstMessage.seq, secondMessage.seq]);
  assert.ok(Number.isSafeInteger(state.events.nextSequence));
  assert.ok(state.events.nextSequence > secondMessage.seq);
  assert.ok(state.messages.every((entry) => Number.isSafeInteger(entry.seq)));
  assert.ok(state.audit.every((entry) => Number.isSafeInteger(entry.seq)));
});
