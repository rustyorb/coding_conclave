import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/lib/store.js';
import { redactSecrets } from '../src/lib/redact.js';
import { isInsideWorkspace } from '../src/lib/workspace.js';

test('JSON store persists mutations atomically', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-store-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const store = new JsonStore(file, directory);
  await store.load();
  await store.update((state) => { state.room.name = 'Persisted room'; });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).room.name, 'Persisted room');
});

test('common credential shapes are redacted from logs', () => {
  assert.equal(redactSecrets('token=super-sensitive-value'), 'token=[REDACTED]');
  assert.equal(redactSecrets('Authorization sk-abcdefghijklmnop123'), 'Authorization [REDACTED]');
  assert.equal(redactSecrets('ordinary output'), 'ordinary output');
});

test('workspace boundary check rejects sibling prefixes', () => {
  const root = path.resolve('project');
  assert.equal(isInsideWorkspace(root, path.join(root, 'src', 'file.js')), true);
  assert.equal(isInsideWorkspace(root, `${root}-other/file.js`), false);
});
