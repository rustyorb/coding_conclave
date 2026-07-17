import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryDb } from '../src/lib/memory-db.js';
import { BackupAdapter } from '../src/lib/backup-adapter.js';
import { id as generateId, now } from '../src/lib/utils.js';

test('BackupAdapter serialization works correctly', () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const roomId1 = generateId('room');
  const roomId2 = generateId('room');
  db.saveRoom({ id: roomId1, name: 'Room 1' });
  db.saveRoom({ id: roomId2, name: 'Room 2' });

  const itemId1 = generateId('mem');
  const itemId2 = generateId('mem');

  db.rememberNode({
    id: itemId1, roomId: roomId1, kind: 'decision', title: 'Decision 1',
    statement: 'Statement 1', status: 'accepted', scope: 'room',
    applicability: { paths: ['src/lib/store.js'] }
  });

  db.rememberNode({
    id: itemId2, roomId: roomId2, kind: 'decision', title: 'Decision 2',
    statement: 'Statement 2', status: 'proposed', scope: 'room'
  });

  assert.throws(
    () => db.connectNodes(itemId1, itemId2, 'relates_to'),
    /cannot cross room boundaries/
  );
  db.connectNodes(itemId1, itemId1, 'relates_to');

  db.addNodeSource({
    itemId: itemId1,
    sourceType: 'message',
    sourceId: 'msg-123',
    sourceRevision: 1,
    sourceHash: 'hash-xyz',
    excerpt: 'excerpt info',
    supportRole: 'required',
    supportState: 'available'
  });

  const adapter = new BackupAdapter({ db, passphrase: 'test-secret-phrase' });

  // 1. Test serializeGraph (all rooms)
  const allSerialized = adapter.serializeGraph();
  const allObj = JSON.parse(allSerialized);
  assert.equal(allObj.type, 'graph');
  assert.equal(allObj.version, 2);
  assert.equal(allObj.data.items.length, 2);
  assert.equal(allObj.data.revisions.length, 2);
  assert.equal(allObj.data.connections.length, 1);
  assert.equal(allObj.data.sources.length, 1);

  // Check parsed applicability
  const item1 = allObj.data.items.find(i => i.id === itemId1);
  assert.deepEqual(item1.applicability, { paths: ['src/lib/store.js'] });

  // 2. Test serializeGraph (filtered by roomId1)
  const room1Serialized = adapter.serializeGraph(roomId1);
  const room1Obj = JSON.parse(room1Serialized);
  assert.equal(room1Obj.type, 'graph');
  assert.equal(room1Obj.roomId, roomId1);
  assert.equal(room1Obj.data.items.length, 1);
  assert.equal(room1Obj.data.revisions.length, 1);
  assert.equal(room1Obj.data.items[0].id, itemId1);
  // Both connections and sources should contain items linked to itemId1
  assert.equal(room1Obj.data.connections.length, 1);
  assert.equal(room1Obj.data.sources.length, 1);

  // 3. Test serializeAll
  const allTables = adapter.serializeAll();
  const tablesObj = JSON.parse(allTables);
  assert.equal(tablesObj.type, 'all');
  assert.ok(tablesObj.data.rooms);
  assert.equal(tablesObj.data.rooms.length, 2);
  assert.equal(tablesObj.data.memory_items.length, 2);

  db.close();
});

test('BackupAdapter encryption and decryption works', () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const passphrase = 'my-super-secret-password-123!';
  const adapter = new BackupAdapter({ db, passphrase });

  const originalText = JSON.stringify({ hello: 'world', nested: { val: 42 } });
  
  // Encrypt
  const encrypted = adapter.encrypt(originalText);
  assert.ok(Buffer.isBuffer(encrypted));
  assert.ok(encrypted.length > originalText.length);

  // Decrypt (same adapter/passphrase)
  const decrypted = adapter.decrypt(encrypted);
  assert.equal(decrypted, originalText);

  // Decrypt with string representation (base64)
  const base64Str = encrypted.toString('base64');
  const decryptedBase64 = adapter.decrypt(base64Str);
  assert.equal(decryptedBase64, originalText);

  // Decrypt with string representation (hex)
  const hexStr = encrypted.toString('hex');
  const decryptedHex = adapter.decrypt(hexStr);
  assert.equal(decryptedHex, originalText);

  // Decrypt with invalid passphrase (different adapter)
  const wrongAdapter = new BackupAdapter({ db, passphrase: 'wrong-passphrase' });
  assert.throws(() => {
    wrongAdapter.decrypt(encrypted);
  }, /Decryption failed/);

  db.close();
});

test('BackupAdapter push to file works', async () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const passphrase = 'test-pass';
  const adapter = new BackupAdapter({ db, passphrase });
  const payload = Buffer.from('encrypted-data-payload');

  const testFileDir = path.join(tmpdir(), 'conclave-backup-tests');
  const testFilePath = path.join(testFileDir, 'backup.enc');

  // Clean up if existing
  await fs.rm(testFileDir, { recursive: true, force: true }).catch(() => {});

  const result = await adapter.push(payload, { type: 'file', path: testFilePath });
  assert.ok(result.success);
  assert.equal(result.path, path.resolve(testFilePath));

  // Verify file was written
  const content = await fs.readFile(testFilePath);
  assert.deepEqual(content, payload);

  // Clean up
  await fs.rm(testFileDir, { recursive: true, force: true }).catch(() => {});
  db.close();
});

test('BackupAdapter push to HTTP works', async () => {
  const db = new MemoryDb(':memory:');
  db.init();

  // Spin up a simple HTTP server to mock the remote funnel
  let serverReceivedHeaders = null;
  let serverReceivedBody = [];
  const server = http.createServer((req, res) => {
    serverReceivedHeaders = req.headers;
    req.on('data', chunk => {
      serverReceivedBody.push(chunk);
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
  });

  // Listen on a random port
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });

  const url = `http://127.0.0.1:${port}/upload`;
  const passphrase = 'test-pass';
  const adapter = new BackupAdapter({ db, passphrase });
  const payload = Buffer.from('my-http-payload-bytes');

  try {
    const result = await adapter.push(payload, {
      type: 'http',
      url,
      headers: {
        'Authorization': 'Bearer my-token-abc'
      }
    });

    assert.ok(result.success);
    assert.equal(result.status, 200);

    // Verify what the mock server received
    assert.equal(serverReceivedHeaders['content-type'], 'application/octet-stream');
    assert.equal(serverReceivedHeaders['authorization'], 'Bearer my-token-abc');
    assert.deepEqual(Buffer.concat(serverReceivedBody), payload);
  } finally {
    server.close();
    db.close();
  }
});

test('BackupAdapter runBackup and restore graphs works', async () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const roomId = generateId('room');
  db.saveRoom({ id: roomId, name: 'Room' });

  const itemId = generateId('mem');
  db.rememberNode({
    id: itemId, roomId, kind: 'decision', title: 'Persisted Node',
    statement: 'To be backed up', status: 'accepted'
  });
  db.connectNodes(itemId, itemId, 'relates_to');
  db.addNodeSource({
    itemId,
    sourceType: 'message',
    sourceId: 'msg-1',
    excerpt: 'excerpt',
    supportRole: 'required',
    supportState: 'available'
  });

  const testFileDir = path.join(tmpdir(), 'conclave-backup-restore-tests');
  const testFilePath = path.join(testFileDir, 'backup.enc');
  await fs.rm(testFileDir, { recursive: true, force: true }).catch(() => {});

  const adapter = new BackupAdapter({ db, passphrase: 'restore-secret-phrase' });

  // Run full backup lifecycle
  const backupResult = await adapter.runBackup({
    type: 'graph',
    roomId,
    destination: { type: 'file', path: testFilePath }
  });

  assert.ok(backupResult.success);
  assert.ok(backupResult.encryptedBytes > 0);

  // 1. Manually mutate the database to verify restore overrides it
  db.db.prepare('DELETE FROM memory_sources').run();
  db.db.prepare('DELETE FROM memory_connections').run();
  db.db.prepare('DELETE FROM memory_items').run();

  assert.equal(db.getNode(itemId), null);

  // 2. Read the backup file, decrypt, and restore
  const encryptedPayload = await fs.readFile(testFilePath);
  const decrypted = adapter.decrypt(encryptedPayload);
  
  const restoreResult = adapter.restore(decrypted);
  assert.ok(restoreResult.success);
  assert.equal(restoreResult.type, 'graph');

  // Verify node is back
  const restoredNode = db.getNode(itemId);
  assert.ok(restoredNode);
  assert.equal(restoredNode.title, 'Persisted Node');
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM memory_item_revisions WHERE itemId = ?').get(itemId).n, 1);

  // Verify connection is back
  const conns = db.getConnections(itemId);
  assert.equal(conns.length, 1);

  // Verify source is back
  const sources = db.getNodeSources(itemId);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].sourceId, 'msg-1');

  // Clean up
  await fs.rm(testFileDir, { recursive: true, force: true }).catch(() => {});
  db.close();
});

test('BackupAdapter restore all tables works', () => {
  const db = new MemoryDb(':memory:');
  db.init();

  const wsId = generateId('ws');
  db.saveWorkspace({ id: wsId, name: 'Backup Workspace', path: '/path' });

  const roomId = generateId('room');
  db.saveRoom({ id: roomId, name: 'Backup Room', workspaceId: wsId });

  const adapter = new BackupAdapter({ db, passphrase: 'test' });
  const allSerialized = adapter.serializeAll();

  // Clear tables
  db.db.prepare('DELETE FROM rooms').run();
  db.db.prepare('DELETE FROM workspaces').run();

  assert.equal(db.getRoom(roomId), null);

  // Restore
  adapter.restore(allSerialized);

  const restoredRoom = db.getRoom(roomId);
  assert.ok(restoredRoom);
  assert.equal(restoredRoom.name, 'Backup Room');
  assert.equal(restoredRoom.workspaceId, wsId);

  db.close();
});

test('BackupAdapter full restore clears rows for tables that were empty in the snapshot', () => {
  const source = new MemoryDb(':memory:');
  source.init();
  source.saveRoom({ id: 'room-empty', name: 'Empty snapshot room' });
  const serialized = new BackupAdapter({ db: source, passphrase: 'test' }).serializeAll();

  const target = new MemoryDb(':memory:');
  target.init();
  target.saveRoom({ id: 'room-stale', name: 'Stale' });
  target.rememberNode({
    id: 'stale-item', roomId: 'room-stale', kind: 'fact', title: 'Stale',
    statement: 'must be cleared', status: 'accepted'
  });

  new BackupAdapter({ db: target, passphrase: 'test' }).restore(serialized);
  assert.equal(target.getNode('stale-item'), null);
  assert.equal(target.getRoom('room-stale'), null);
  assert.ok(target.getRoom('room-empty'));
  source.close();
  target.close();
});

test('BackupAdapter rejects unknown tables and insecure remote HTTP destinations', async () => {
  const db = new MemoryDb(':memory:');
  db.init();
  const adapter = new BackupAdapter({ db, passphrase: 'test' });
  const payload = JSON.parse(adapter.serializeAll());
  payload.data['memory_items; DROP TABLE rooms'] = [];
  assert.throws(() => adapter.restore(JSON.stringify(payload)), /unsupported tables/);
  await assert.rejects(
    adapter.push(Buffer.from('encrypted'), { type: 'http', url: 'http://example.com/backup' }),
    /require HTTPS/
  );
  db.close();
});
