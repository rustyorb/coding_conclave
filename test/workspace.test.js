import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { inspectWorkspace } from '../src/lib/workspace.js';

const run = promisify(execFile);

async function makeRepo(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-workspace-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => run('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', ...args], { cwd: directory });
  await git('init');
  await writeFile(path.join(directory, 'tracked.txt'), 'one\n');
  await git('add', '.');
  await git('commit', '-m', 'init');
  return directory;
}

test('a clean tree still inspects to an empty diff', async (context) => {
  const directory = await makeRepo(context);
  const workspace = await inspectWorkspace(directory);
  assert.equal(workspace.git, true);
  assert.deepEqual(workspace.status, []);
  assert.equal(workspace.diff, '');
});

test('untracked new files contribute their content to the inspection diff', async (context) => {
  const directory = await makeRepo(context);
  await writeFile(path.join(directory, 'brand-new-feature.js'), 'export const fresh = 1;\n');
  const workspace = await inspectWorkspace(directory);
  assert.ok(workspace.status.some((line) => line.startsWith('??') && line.includes('brand-new-feature.js')));
  assert.ok(workspace.diff.includes('brand-new-feature.js'));
  assert.ok(workspace.diff.includes('+export const fresh = 1;'));
  assert.ok(workspace.diff.includes('# Untracked files'));
});

test('a diff beyond the capture limit is truncated instead of failing the inspection', async (context) => {
  const directory = await makeRepo(context);
  await writeFile(path.join(directory, 'tracked.txt'), `${'y'.repeat(120)}\n`.repeat(50_000)); // ~6MB rewrite
  const workspace = await inspectWorkspace(directory); // previously threw 'stdout maxBuffer length exceeded'
  assert.ok(workspace.diff.includes('tracked.txt'));
  assert.ok(workspace.diff.includes('[diff truncated'));
});

test('an oversized untracked file is truncated instead of dropped', async (context) => {
  const directory = await makeRepo(context);
  await writeFile(path.join(directory, 'huge-new.txt'), `${'z'.repeat(120)}\n`.repeat(50_000)); // ~6MB new file
  const workspace = await inspectWorkspace(directory);
  assert.ok(workspace.diff.includes('huge-new.txt'));
  assert.ok(workspace.diff.includes('[diff truncated'));
});
