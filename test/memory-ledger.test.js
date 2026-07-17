import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_EXCERPT_MAX,
  MEMORY_STATEMENT_MAX,
  MEMORY_TITLE_MAX,
  addMemorySource,
  aggregateSupportState,
  createMemoryItem,
  emptyMemoryState,
  ensureMemoryState,
  projectMemoryForApi,
  reviseMemoryItem,
  setMemoryItemPinned
} from '../src/lib/memory-ledger.js';

function fixtureState() {
  return {
    room: { id: 'room_test' },
    messages: [
      { id: 'msg_1', source: 'user', sourceName: 'You', type: 'message', content: 'We decided to use SQLite with FTS5 as the target store.', createdAt: '2026-07-15T00:00:00.000Z' },
      { id: 'msg_2', source: 'codex', sourceName: 'Codex', type: 'message', content: 'Confirmed: vectors stay behind a disabled-by-default adapter.', createdAt: '2026-07-15T00:01:00.000Z' },
      { id: 'msg_3', source: 'grok', sourceName: 'Grok', type: 'message', content: 'Summary refresh is debounced at 500ms.', createdAt: '2026-07-15T00:02:00.000Z' }
    ],
    audit: []
  };
}

test('createMemoryItem stores a proposed item with provenance edges and a revision', () => {
  const state = fixtureState();
  const { item, sources } = createMemoryItem(state, {
    kind: 'decision',
    title: 'SQLite is the target store',
    statement: 'The room selected embedded SQLite with FTS5; vectors stay behind an adapter.',
    sources: [{ messageId: 'msg_1' }, { messageId: 'msg_2' }]
  });
  assert.equal(item.status, 'proposed');
  assert.equal(item.version, 1);
  assert.equal(item.roomId, 'room_test');
  assert.equal(item.scope, 'room');
  assert.equal(item.pinned, false);
  assert.equal(item.supportState, 'available');
  assert.equal(sources.length, 2);
  // First edge defaults to required, later edges to supplemental (spec §6.3).
  assert.equal(sources[0].supportRole, 'required');
  assert.equal(sources[1].supportRole, 'supplemental');
  assert.equal(sources[0].messageId, 'msg_1');
  assert.match(sources[0].contentHash, /^[0-9a-f]{64}$/);
  assert.ok(sources[0].excerpt.includes('SQLite with FTS5'));
  assert.equal(state.memory.items.length, 1);
  assert.equal(state.memory.sources.length, 2);
  assert.equal(state.memory.itemRevisions.length, 1);
  assert.equal(state.memory.itemRevisions[0].version, 1);
  assert.equal(state.memory.itemRevisions[0].statement, item.statement);
});

test('createMemoryItem validates input and never partially mutates state', () => {
  const state = fixtureState();
  const valid = {
    kind: 'fact', title: 'A fact', statement: 'Something observed.',
    sources: [{ messageId: 'msg_1' }]
  };
  assert.throws(() => createMemoryItem(state, { ...valid, kind: 'opinion' }), /kind must be one of/);
  assert.throws(() => createMemoryItem(state, { ...valid, statement: '   ' }), /needs a statement/);
  assert.throws(() => createMemoryItem(state, { ...valid, title: '' }), /needs a title/);
  assert.throws(() => createMemoryItem(state, { ...valid, sources: [] }), /at least one source message/);
  assert.throws(() => createMemoryItem(state, { ...valid, sources: [{ messageId: 'msg_nope' }] }), /was not found/);
  assert.throws(() => createMemoryItem(state, {
    ...valid, sources: [{ messageId: 'msg_1' }, { messageId: 'msg_nope' }]
  }), /was not found/);
  assert.throws(() => createMemoryItem(state, {
    ...valid, sources: [{ messageId: 'msg_1' }, { messageId: 'msg_1' }]
  }), /listed as a source twice/);
  assert.throws(() => createMemoryItem(state, {
    ...valid, sources: [{ messageId: 'msg_1', supportRole: 'primary' }]
  }), /supportRole must be one of/);
  // A failed create must leave nothing behind — no item, edge, or revision.
  assert.equal(state.memory.items.length, 0);
  assert.equal(state.memory.sources.length, 0);
  assert.equal(state.memory.itemRevisions.length, 0);
});

test('statements, titles, and excerpts are redacted and clamped before persistence', () => {
  const state = fixtureState();
  state.messages.push({
    id: 'msg_secret', source: 'user', sourceName: 'You', type: 'message',
    content: `Use token=abc12345678901234567 for the deploy. ${'x'.repeat(400)}`,
    createdAt: '2026-07-15T00:03:00.000Z'
  });
  const { item, sources } = createMemoryItem(state, {
    kind: 'constraint',
    title: `Deploy needs the shared token ${'t'.repeat(200)}`,
    statement: `Deploys authenticate with token=abc12345678901234567. ${'s'.repeat(MEMORY_STATEMENT_MAX + 100)}`,
    sources: [{ messageId: 'msg_secret' }]
  });
  assert.ok(item.statement.includes('token=[REDACTED]'));
  assert.ok(!item.statement.includes('abc12345678901234567'));
  assert.ok(item.statement.length <= MEMORY_STATEMENT_MAX + '\n…[truncated]'.length);
  assert.equal(item.title.length, MEMORY_TITLE_MAX);
  assert.ok(item.title.endsWith('…'));
  assert.ok(sources[0].excerpt.includes('token=[REDACTED]'));
  assert.ok(!sources[0].excerpt.includes('abc12345678901234567'));
  assert.ok(sources[0].excerpt.length <= MEMORY_EXCERPT_MAX + '\n…[truncated]'.length);
});

test('reviseMemoryItem bumps the version, appends a revision, and enforces expectedVersion', () => {
  const state = fixtureState();
  const { item } = createMemoryItem(state, {
    kind: 'decision', title: 'Original title', statement: 'Original statement.',
    sources: [{ messageId: 'msg_1' }]
  });
  assert.throws(() => reviseMemoryItem(state, item.id, { statement: 'New', expectedVersion: 99 }), (error) => {
    assert.equal(error.code, 'memory-version-conflict');
    return true;
  });
  assert.throws(() => reviseMemoryItem(state, item.id, { statement: 'New' }), /expectedVersion is required/);
  assert.throws(() => reviseMemoryItem(state, item.id, { expectedVersion: 1 }), /Provide a title or statement/);
  assert.equal(item.statement, 'Original statement.');
  assert.equal(item.version, 1);
  const revised = reviseMemoryItem(state, item.id, { statement: 'Updated statement.', expectedVersion: 1 });
  assert.equal(revised.version, 2);
  assert.equal(revised.statement, 'Updated statement.');
  assert.equal(revised.title, 'Original title');
  assert.equal(state.memory.itemRevisions.length, 2);
  assert.equal(state.memory.itemRevisions[1].version, 2);
  assert.throws(() => reviseMemoryItem(state, 'mem_missing', { statement: 'x', expectedVersion: 1 }), /not found/);
});

test('setMemoryItemPinned toggles priority without creating a content revision', () => {
  const state = fixtureState();
  const { item } = createMemoryItem(state, {
    kind: 'preference', title: 'Pin me', statement: 'Keep this in context.',
    sources: [{ messageId: 'msg_1' }]
  });
  assert.throws(() => setMemoryItemPinned(state, item.id, { pinned: 'yes', expectedVersion: 1 }), /pinned must be true or false/);
  assert.throws(() => setMemoryItemPinned(state, item.id, { pinned: true, expectedVersion: 5 }), (error) => {
    assert.equal(error.code, 'memory-version-conflict');
    return true;
  });
  const pinned = setMemoryItemPinned(state, item.id, { pinned: true, expectedVersion: 1 });
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.version, 2);
  assert.equal(state.memory.itemRevisions.length, 1);
  const unpinned = setMemoryItemPinned(state, item.id, { pinned: false, expectedVersion: 2 });
  assert.equal(unpinned.pinned, false);
  assert.equal(unpinned.version, 3);
});

test('addMemorySource appends a supplemental edge and rejects duplicates', () => {
  const state = fixtureState();
  const { item } = createMemoryItem(state, {
    kind: 'fact', title: 'Debounce', statement: 'Summary refresh is debounced.',
    sources: [{ messageId: 'msg_3' }]
  });
  const { item: updated, source } = addMemorySource(state, item.id, { messageId: 'msg_2', expectedVersion: 1 });
  assert.equal(source.supportRole, 'supplemental');
  assert.equal(source.messageId, 'msg_2');
  assert.equal(updated.version, 2);
  assert.equal(updated.supportState, 'available');
  assert.equal(state.memory.sources.filter((edge) => edge.itemId === item.id).length, 2);
  assert.throws(() => addMemorySource(state, item.id, { messageId: 'msg_2', expectedVersion: 2 }), /already a source/);
  assert.throws(() => addMemorySource(state, item.id, { messageId: 'msg_nope', expectedVersion: 2 }), /was not found/);
  assert.throws(() => addMemorySource(state, item.id, { messageId: 'msg_1', expectedVersion: 1 }), (error) => {
    assert.equal(error.code, 'memory-version-conflict');
    return true;
  });
});

test('aggregateSupportState follows the deterministic spec matrix', () => {
  const edge = (supportRole, supportState) => ({ supportRole, supportState });
  assert.equal(aggregateSupportState([]), 'unavailable');
  assert.equal(aggregateSupportState([edge('required', 'available')]), 'available');
  assert.equal(aggregateSupportState([edge('required', 'available'), edge('supplemental', 'available')]), 'available');
  assert.equal(aggregateSupportState([edge('required', 'hash-mismatch'), edge('required', 'available')]), 'compromised');
  assert.equal(aggregateSupportState([edge('required', 'available'), edge('supplemental', 'missing')]), 'partial');
  assert.equal(aggregateSupportState([edge('required', 'available'), edge('required', 'retention-pruned')]), 'partial');
  assert.equal(aggregateSupportState([edge('required', 'missing')]), 'unavailable');
  assert.equal(aggregateSupportState([edge('supplemental', 'available')]), 'unavailable');
});

test('ensureMemoryState backfills legacy states and projectMemoryForApi omits revisions', () => {
  const legacy = { room: { id: 'room_legacy' } };
  const memory = ensureMemoryState(legacy);
  assert.deepEqual(memory, { ...emptyMemoryState('room_legacy') });
  const broken = { room: { id: 'room_x' }, memory: { items: 'nope' } };
  ensureMemoryState(broken);
  assert.deepEqual(broken.memory.items, []);
  assert.deepEqual(broken.memory.sources, []);
  const projected = projectMemoryForApi({
    version: 1, roomId: 'room_x',
    items: [{ id: 'mem_1' }], itemRevisions: [{ id: 'memrev_1' }], sources: [{ id: 'memsrc_1' }]
  });
  assert.equal(projected.itemsTotal, 1);
  assert.equal(projected.items.length, 1);
  assert.equal(projected.sources.length, 1);
  assert.ok(!('itemRevisions' in projected));
});
