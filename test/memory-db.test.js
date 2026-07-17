import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '../src/lib/memory-db.js';
import { id as generateId, now } from '../src/lib/utils.js';

test('MemoryDb initialization succeeds and tables are created', () => {
  const db = new MemoryDb(':memory:');
  // Initially, tables shouldn't exist or we just call init and verify they exist
  db.init();

  // Test inserting and retrieving a room
  const roomId = generateId('room');
  db.saveRoom({ id: roomId, name: 'Test Room' });

  const room = db.getRoom(roomId);
  assert.ok(room);
  assert.equal(room.id, roomId);
  assert.equal(room.name, 'Test Room');

  db.close();
});

test('Workspace and room storage and retrieval works', () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const wsId = generateId('ws');
  db.saveWorkspace({
    id: wsId,
    name: 'Conclave Workspace',
    path: '/path/to/conclave',
    repositoryIdentity: 'repo-uuid-123'
  });

  const ws = db.getWorkspace(wsId);
  assert.ok(ws);
  assert.equal(ws.id, wsId);
  assert.equal(ws.name, 'Conclave Workspace');
  assert.equal(ws.path, '/path/to/conclave');
  assert.equal(ws.repositoryIdentity, 'repo-uuid-123');

  const roomId = generateId('room');
  db.saveRoom({
    id: roomId,
    name: 'Workspace Room',
    workspaceId: wsId
  });

  const room = db.getRoom(roomId);
  assert.ok(room);
  assert.equal(room.workspaceId, wsId);

  db.close();
});

test('Message (Tier 1) inserts, updates, revisions, deletion, and FTS search works', () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const roomId = generateId('room');
  db.saveRoom({ id: roomId, name: 'Test Room' });

  const msgId = generateId('msg');
  const msg = {
    id: msgId,
    roomId,
    sequence: 1,
    sourceType: 'user',
    sourceId: 'user_1',
    sourceNameSnapshot: 'Mars',
    type: 'message',
    content: 'Hello, this is the first message!',
    contentHash: 'hash1',
    revision: 1,
    timestampStatus: 'valid'
  };

  // 1. Initial Insert
  const firstRev = db.saveMessage(msg);
  assert.equal(firstRev, 1);

  const saved = db.getMessage(msgId);
  assert.ok(saved);
  assert.equal(saved.content, 'Hello, this is the first message!');
  assert.equal(saved.revision, 1);

  // Check revisions table
  let revisions = db.getMessageRevisions(msgId);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].revision, 1);
  assert.equal(revisions[0].content, 'Hello, this is the first message!');

  // 2. Update content (triggers revision increment)
  const updatedMsg = {
    ...msg,
    content: 'Hello, this is the edited message!',
    contentHash: 'hash2',
    editReason: 'typo fix'
  };

  const secondRev = db.saveMessage(updatedMsg);
  assert.equal(secondRev, 2);

  const updatedSaved = db.getMessage(msgId);
  assert.equal(updatedSaved.content, 'Hello, this is the edited message!');
  assert.equal(updatedSaved.revision, 2);

  revisions = db.getMessageRevisions(msgId);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].revision, 2);
  assert.equal(revisions[1].content, 'Hello, this is the edited message!');
  assert.equal(revisions[1].reason, 'typo fix');

  // 3. Update without content change (no revision increment)
  const nonContentUpdate = {
    ...updatedSaved,
    finalizedAt: now()
  };
  const sameRev = db.saveMessage(nonContentUpdate);
  assert.equal(sameRev, 2);
  assert.equal(db.getMessage(msgId).revision, 2);
  assert.equal(db.getMessageRevisions(msgId).length, 2);

  // 4. FTS search
  const searchResults = db.searchMessages('edited', { roomId });
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0].id, msgId);

  // 5. Delete (soft-delete)
  const deletedChanges = db.deleteMessage(msgId);
  assert.equal(deletedChanges, 1);
  assert.ok(db.getMessage(msgId).deletedAt);

  db.close();
});

test('Summary checkpoints, rollups, and jobs (Tier 2) works', () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const roomId = generateId('room');
  db.saveRoom({ id: roomId, name: 'Test Room' });

  // 1. Checkpoint
  const cpId = generateId('cp');
  db.saveCheckpoint({
    id: cpId,
    roomId,
    revision: 1,
    status: 'current',
    fromSequenceExclusive: 0,
    throughSequenceInclusive: 20,
    sourceDigest: 'digest-123',
    content: 'Checkpoint summary text',
    contentHash: 'hash-cp',
    producerType: 'agent',
    producerId: 'gemini'
  });

  const cp = db.getCheckpoint(cpId);
  assert.ok(cp);
  assert.equal(cp.content, 'Checkpoint summary text');
  assert.equal(cp.fromSequenceExclusive, 0);
  assert.equal(cp.throughSequenceInclusive, 20);

  // 2. Rollup
  const ruId = generateId('ru');
  db.saveRollup({
    id: ruId,
    roomId,
    revision: 1,
    status: 'current',
    throughSequenceInclusive: 20,
    structuredStateDigest: 'state-dig',
    ledgerDigest: 'ledger-dig',
    content: 'Rollup synthesis text',
    contentHash: 'hash-ru',
    producerType: 'system',
    producerId: 'conclave'
  });

  const rollup = db.getRollup(ruId);
  assert.ok(rollup);
  assert.equal(rollup.content, 'Rollup synthesis text');

  const latest = db.getLatestRollup(roomId);
  assert.ok(latest);
  assert.equal(latest.id, ruId);

  // 3. Summary Jobs
  const jobId = 'job-123';
  db.saveSummaryJob({
    id: jobId,
    roomId,
    fromSequenceExclusive: 20,
    throughSequenceInclusive: 40,
    sourceDigest: 'digest-456',
    kind: 'checkpoint',
    status: 'pending'
  });

  let job = db.getSummaryJob(jobId);
  assert.ok(job);
  assert.equal(job.status, 'pending');

  db.saveSummaryJob({
    ...job,
    status: 'running',
    leaseOwner: 'worker-1',
    leaseExpiresAt: now()
  });

  job = db.getSummaryJob(jobId);
  assert.equal(job.status, 'running');
  assert.equal(job.leaseOwner, 'worker-1');

  db.close();
});

test('Memory items (Tier 3 nodes) CRUD, revisions, and FTS search works', () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const roomId = generateId('room');
  db.saveRoom({ id: roomId, name: 'Test Room' });

  const nodeId = generateId('mem');
  const node = {
    id: nodeId,
    roomId,
    kind: 'decision',
    title: 'Database selection',
    statement: 'We choose SQLite for local-first memory store',
    status: 'accepted',
    scope: 'workspace',
    applicability: { paths: ['src/lib/store.js'] },
    authorType: 'agent',
    authorId: 'gemini'
  };

  // 1. Create node
  const rev1 = db.rememberNode(node);
  assert.equal(rev1, 1);

  const saved = db.getNode(nodeId);
  assert.ok(saved);
  assert.equal(saved.title, 'Database selection');
  assert.equal(saved.status, 'accepted');
  assert.deepEqual(saved.applicability, { paths: ['src/lib/store.js'] });

  // Check revisions
  const stmt = db.db.prepare('SELECT * FROM memory_item_revisions WHERE itemId = ?');
  const revisions = stmt.all(nodeId);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].title, 'Database selection');
  assert.equal(revisions[0].version, 1);

  // 2. Update node (triggers revision)
  const updatedNode = {
    ...node,
    statement: 'We choose SQLite in WAL mode for local-first memory store',
    updateReason: 'added WAL clarification'
  };
  const rev2 = db.rememberNode(updatedNode);
  assert.equal(rev2, 2);

  const updatedSaved = db.getNode(nodeId);
  assert.equal(updatedSaved.statement, 'We choose SQLite in WAL mode for local-first memory store');
  assert.equal(updatedSaved.version, 2);

  const updatedRevisions = stmt.all(nodeId);
  assert.equal(updatedRevisions.length, 2);
  assert.equal(updatedRevisions[1].version, 2);
  assert.equal(updatedRevisions[1].statement, 'We choose SQLite in WAL mode for local-first memory store');
  assert.equal(updatedRevisions[1].reason, 'added WAL clarification');

  // 3. FTS Search
  const searchResults = db.searchNodes('WAL', { roomId });
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0].id, nodeId);

  // 4. Delete
  const deleted = db.deleteNode(nodeId);
  assert.equal(deleted, 1);
  assert.equal(db.getNode(nodeId), null);

  db.close();
});

test('Memory connections (graph edges) can be created, fetched, and deleted', () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const roomId = generateId('room');
  db.saveRoom({ id: roomId, name: 'Test Room' });

  const idA = generateId('mem');
  const idB = generateId('mem');

  db.rememberNode({
    id: idA, roomId, kind: 'decision', title: 'Decision A',
    statement: 'Statement A', status: 'accepted'
  });
  db.rememberNode({
    id: idB, roomId, kind: 'decision', title: 'Decision B',
    statement: 'Statement B', status: 'proposed'
  });

  // Connect A -> B
  db.connectNodes(idA, idB, 'derived_from');

  const conns = db.getConnections(idA);
  assert.equal(conns.length, 1);
  assert.equal(conns[0].sourceId, idA);
  assert.equal(conns[0].targetId, idB);
  assert.equal(conns[0].relationship, 'derived_from');

  // Check reciprocal connection fetching
  const connsB = db.getConnections(idB);
  assert.equal(connsB.length, 1);
  assert.equal(connsB[0].sourceId, idA);

  // Disconnect
  const disconnected = db.disconnectNodes(idA, idB, 'derived_from');
  assert.equal(disconnected, 1);
  assert.equal(db.getConnections(idA).length, 0);

  db.close();
});

test('search and graph APIs fail closed without room scope', () => {
  const db = new MemoryDb(':memory:');
  db.init();
  db.saveRoom({ id: 'room-a', name: 'Room A' });
  db.saveRoom({ id: 'room-b', name: 'Room B' });
  db.rememberNode({ id: 'mem-a', roomId: 'room-a', kind: 'fact', title: 'A', statement: 'alpha', status: 'accepted' });
  db.rememberNode({ id: 'mem-b', roomId: 'room-b', kind: 'fact', title: 'B', statement: 'beta', status: 'accepted' });

  assert.throws(() => db.searchMessages('anything'), /roomId is required/);
  assert.throws(() => db.searchNodes('alpha'), /roomId is required/);
  assert.throws(() => db.connectNodes('mem-a', 'mem-b', 'relates_to'), /cannot cross room boundaries/);
  db.close();
});

test('pinned priority and authoritative versions persist in SQLite', () => {
  const db = new MemoryDb(':memory:');
  db.init();
  db.saveRoom({ id: 'room-pin', name: 'Pin Room' });
  db.rememberNode({
    id: 'mem-pin', roomId: 'room-pin', kind: 'decision', title: 'Pinned',
    statement: 'priority survives projection', status: 'proposed', pinned: true, version: 4
  });
  assert.equal(db.getNode('mem-pin').pinned, true);
  assert.equal(db.getNode('mem-pin').version, 4);

  db.rememberNode({
    id: 'mem-pin', roomId: 'room-pin', kind: 'decision', title: 'Pinned',
    statement: 'priority survives projection', status: 'proposed', pinned: false, version: 5
  });
  assert.equal(db.getNode('mem-pin').pinned, false);
  assert.equal(db.getNode('mem-pin').version, 5);
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, 1);
  db.close();
});

test('Memory sources (provenance edges) can be created and fetched', () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const roomId = generateId('room');
  db.saveRoom({ id: roomId, name: 'Test Room' });

  const itemId = generateId('mem');
  db.rememberNode({
    id: itemId, roomId, kind: 'decision', title: 'Decision',
    statement: 'Statement', status: 'accepted'
  });

  const msgId = generateId('msg');
  db.addNodeSource({
    itemId,
    sourceType: 'message',
    sourceId: msgId,
    sourceRevision: 1,
    sourceHash: 'source-hash-xyz',
    excerpt: 'excerpt of message',
    supportRole: 'required',
    supportState: 'available'
  });

  const sources = db.getNodeSources(itemId);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].itemId, itemId);
  assert.equal(sources[0].sourceType, 'message');
  assert.equal(sources[0].sourceId, msgId);
  assert.equal(sources[0].sourceHash, 'source-hash-xyz');
  assert.equal(sources[0].supportRole, 'required');
  assert.equal(sources[0].supportState, 'available');

  db.close();
});

test('Context receipts and entries can be saved and loaded', () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const roomId = generateId('room');
  db.saveRoom({ id: roomId, name: 'Test Room' });

  const receiptId = generateId('rcpt');
  const receipt = {
    id: receiptId,
    roomId,
    executionId: 'exec-123',
    assemblerVersion: '1.0.0',
    estimatorVersion: '1.0.0',
    assemblerConfigHash: 'config-hash',
    roomVersion: 5,
    workspaceSnapshotId: 'snap-abc',
    memoryVersion: 2,
    promptTemplateHash: 'template-hash',
    contextPackageHash: 'package-hash',
    totalCharacters: 12000,
    summaryCoverageThroughSequence: 45
  };

  const entries = [
    { tier: 1, objectId: 'msg-1', revision: 2, hash: 'h1', reason: 'recent message', characters: 500, status: 'selected' },
    { tier: 2, objectId: 'rollup-1', revision: 1, hash: 'h2', reason: 'current summary', characters: 2000, status: 'selected' },
    { tier: 3, objectId: 'mem-1', revision: 3, hash: 'h3', reason: 'accepted decision', characters: 300, status: 'selected' }
  ];

  db.saveContextReceipt(receipt, entries);

  const loaded = db.getContextReceipt(receiptId);
  assert.ok(loaded);
  assert.equal(loaded.id, receiptId);
  assert.equal(loaded.totalCharacters, 12000);
  assert.equal(loaded.summaryCoverageThroughSequence, 45);

  assert.equal(loaded.entries.length, 3);
  assert.equal(loaded.entries[0].receiptId, receiptId);
  assert.equal(loaded.entries[0].tier, 1);
  assert.equal(loaded.entries[0].objectId, 'msg-1');
  assert.equal(loaded.entries[0].revision, 2);
  assert.equal(loaded.entries[2].tier, 3);
  assert.equal(loaded.entries[2].reason, 'accepted decision');

  db.close();
});

test('Transaction rollbacks work on error', () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const roomId = generateId('room');
  db.saveRoom({ id: roomId, name: 'Test Room' });

  const msgId = generateId('msg');

  assert.throws(() => {
    db.transaction(() => {
      db.saveMessage({
        id: msgId,
        roomId,
        sequence: 1,
        sourceType: 'user',
        type: 'message',
        content: 'I will be rolled back',
        contentHash: 'hash-rb'
      });
      // Force an error
      throw new Error('Transaction aborted');
    });
  }, /Transaction aborted/);

  // Message should not be saved
  assert.equal(db.getMessage(msgId), null);

  db.close();
});
