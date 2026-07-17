import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  advanceRoomSummary,
  buildCheckpoint,
  emptySummaryState,
  ensureSummaryState,
  hashText,
  markStaleIfSourcesChanged,
  projectSummaryForApi,
  regenerateStaleCheckpoints,
  ROLLUP_SECTIONS,
  sourceDigest,
  structuredStateDigest,
  verifySummaryIntegrity
} from '../src/lib/room-summary.js';
import { ConclaveApp } from '../src/server.js';

function baseState(messageCount = 0) {
  const messages = Array.from({ length: messageCount }, (_, index) => ({
    id: `msg_${index}`,
    source: index % 2 === 0 ? 'user' : 'codex',
    sourceName: index % 2 === 0 ? 'You' : 'Codex',
    type: 'message',
    content: `Message number ${index} with some body text for digest coverage.`,
    createdAt: new Date(Date.UTC(2026, 6, 15, 12, 0, index)).toISOString()
  }));
  return {
    room: {
      id: 'room_test',
      name: 'Summary lab',
      trust: 'unleashed',
      paused: false,
      coordinatorId: 'codex',
      workspace: 'U:\\coding_conclave'
    },
    agents: [{ id: 'codex', name: 'Codex', status: 'installed', activity: 'idle' }],
    tasks: [
      { id: 'task_1', title: 'Land summary', status: 'completed', agentId: 'codex', blocker: null, updatedAt: '2026-07-15T12:00:00.000Z' },
      { id: 'task_2', title: 'Wire refresh', status: 'active', agentId: 'codex', blocker: null, updatedAt: '2026-07-15T12:01:00.000Z' },
      { id: 'task_3', title: 'Blocked sibling', status: 'blocked', agentId: 'gemini', blocker: 'waiting on review', updatedAt: '2026-07-15T12:02:00.000Z' },
      { id: 'task_4', title: 'Needs review', status: 'review-required', agentId: 'claude', blocker: null, updatedAt: '2026-07-15T12:03:00.000Z' }
    ],
    approvals: [
      { id: 'appr_1', type: 'agent-write', status: 'pending', command: 'edit src/lib/room-summary.js', taskId: 'task_2' }
    ],
    executions: [
      { id: 'exec_1', status: 'completed', exitCode: 0, purpose: 'npm test', command: 'npm test' }
    ],
    messages,
    summary: emptySummaryState('room_test')
  };
}

test('sourceDigest is order- and content-sensitive', () => {
  const a = [{ id: 'm1', content: 'alpha', revision: 1 }, { id: 'm2', content: 'beta', revision: 1 }];
  const b = [{ id: 'm2', content: 'beta', revision: 1 }, { id: 'm1', content: 'alpha', revision: 1 }];
  const c = [{ id: 'm1', content: 'ALPHA', revision: 1 }, { id: 'm2', content: 'beta', revision: 1 }];
  assert.notEqual(sourceDigest(a), sourceDigest(b));
  assert.notEqual(sourceDigest(a), sourceDigest(c));
  assert.equal(sourceDigest(a), sourceDigest([...a]));
});

test('buildCheckpoint covers a contiguous range with matching digests and hashes', () => {
  const state = baseState(5);
  const checkpoint = buildCheckpoint(state, -1, 4, { checkpointMaxChars: 4_000 });
  assert.equal(checkpoint.fromIndexExclusive, -1);
  assert.equal(checkpoint.throughIndexInclusive, 4);
  assert.equal(checkpoint.sourceMessageIds.length, 5);
  assert.equal(checkpoint.sourceDigest, sourceDigest(state.messages));
  assert.equal(checkpoint.contentHash, hashText(checkpoint.content));
  assert.equal(checkpoint.producerId, 'room-summary-v1');
  assert.match(checkpoint.content, /## Covered activity/);
});

test('advanceRoomSummary is incremental: second checkpoint starts after the first', () => {
  const state = baseState(0);
  // First batch — force a checkpoint over the first 5 messages.
  for (let index = 0; index < 5; index += 1) {
    state.messages.push({
      id: `msg_a_${index}`, source: 'user', sourceName: 'You', type: 'message',
      content: `batch-a-${index}`, createdAt: '2026-07-15T12:00:00.000Z'
    });
  }
  assert.equal(advanceRoomSummary(state, { force: true, messageThreshold: 100 }), true);
  assert.equal(state.summary.checkpoints.length, 1);
  assert.equal(state.summary.coveredThroughIndex, 4);
  const first = state.summary.checkpoints[0];

  // Second batch — five more messages, force another checkpoint.
  for (let index = 0; index < 5; index += 1) {
    state.messages.push({
      id: `msg_b_${index}`, source: 'codex', sourceName: 'Codex', type: 'message',
      content: `batch-b-${index}`, createdAt: '2026-07-15T12:01:00.000Z'
    });
  }
  assert.equal(advanceRoomSummary(state, { force: true, messageThreshold: 100 }), true);
  assert.equal(state.summary.checkpoints.length, 2);
  const second = state.summary.checkpoints[1];
  assert.equal(second.fromIndexExclusive, first.throughIndexInclusive);
  assert.equal(second.throughIndexInclusive, 9);
  assert.equal(state.summary.coveredThroughIndex, 9);

  const integrity = verifySummaryIntegrity(state);
  assert.equal(integrity.ok, true, integrity.errors.join('; '));
});

test('advanceRoomSummary respects thresholds and still rebuilds rollup on structured change', () => {
  const state = baseState(3);
  // Below message threshold, no force → first call still builds rollup (none yet).
  assert.equal(advanceRoomSummary(state, { messageThreshold: 20, characterThreshold: 50_000 }), true);
  assert.equal(state.summary.checkpoints.length, 0, 'no checkpoint under threshold');
  assert.ok(state.summary.rollup, 'rollup still materializes from structured state');
  assert.match(state.summary.rollup.content, /## Active work and owners/);
  assert.match(state.summary.rollup.content, /Wire refresh/);
  assert.match(state.summary.rollup.content, /## Pending reviews and approvals/);

  const digestBefore = state.summary.rollup.structuredStateDigest;
  assert.equal(structuredStateDigest(state), digestBefore);

  // No new messages and no structured change → no-op.
  assert.equal(advanceRoomSummary(state, { messageThreshold: 20, characterThreshold: 50_000 }), false);

  // Structured change marks rollup stale then rebuilds on next advance.
  state.tasks[1].status = 'completed';
  assert.equal(markStaleIfSourcesChanged(state), true);
  assert.equal(state.summary.rollup.status, 'stale');
  assert.equal(advanceRoomSummary(state, { messageThreshold: 20, characterThreshold: 50_000 }), true);
  assert.equal(state.summary.rollup.status, 'current');
  assert.notEqual(state.summary.rollup.structuredStateDigest, digestBefore);
});

test('verifySummaryIntegrity detects contentHash and sourceDigest tampering', () => {
  const state = baseState(4);
  advanceRoomSummary(state, { force: true });
  assert.equal(verifySummaryIntegrity(state).ok, true);

  state.summary.rollup.contentHash = 'deadbeef';
  assert.equal(verifySummaryIntegrity(state).ok, false);
  state.summary.rollup.contentHash = hashText(state.summary.rollup.content);

  const checkpoint = state.summary.checkpoints[0];
  checkpoint.sourceDigest = 'tampered';
  const broken = verifySummaryIntegrity(state);
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((error) => error.includes('sourceDigest mismatch')));
});

test('source rewrite marks checkpoint and rollup stale without deleting history', () => {
  const state = baseState(4);
  advanceRoomSummary(state, { force: true });
  assert.equal(state.summary.checkpoints[0].status, 'current');
  assert.equal(state.summary.rollup.status, 'current');

  state.messages[1].content = 'rewritten after summarization';
  assert.equal(markStaleIfSourcesChanged(state), true);
  assert.equal(state.summary.checkpoints[0].status, 'stale');
  assert.equal(state.summary.checkpoints[0].staleReason, 'source-digest-mismatch');
  assert.equal(state.summary.rollup.status, 'stale');
  assert.equal(state.summary.rollup.staleReason, 'source-checkpoint-stale');
  // Original messages remain.
  assert.equal(state.messages.length, 4);
});

test('advance regenerates stale checkpoint content so pre-edit prose is not retained', () => {
  const state = baseState(4);
  advanceRoomSummary(state, { force: true });
  const before = state.summary.checkpoints[0].content;
  assert.match(before, /Message number 1/);

  state.messages[1].content = 'sanitized replacement body with no secret sk-abcdefghijklmnopqrst';
  markStaleIfSourcesChanged(state);
  assert.equal(state.summary.checkpoints[0].status, 'stale');

  assert.equal(advanceRoomSummary(state, { messageThreshold: 100, characterThreshold: 1_000_000 }), true);
  const checkpoint = state.summary.checkpoints[0];
  assert.equal(checkpoint.status, 'current');
  assert.equal(checkpoint.staleReason, null);
  assert.match(checkpoint.content, /sanitized replacement body/);
  assert.doesNotMatch(checkpoint.content, /Message number 1 with some body/);
  assert.doesNotMatch(checkpoint.content, /sk-abcdefghijklmnopqrst/);
  assert.equal(checkpoint.sourceDigest, sourceDigest(state.messages));
  assert.equal(state.summary.rollup.status, 'current');
  assert.equal(verifySummaryIntegrity(state).ok, true);
});

test('summarizer failure does not throw and leaves lastError (honest failure)', () => {
  const state = baseState(2);
  // Force buildCheckpoint to fail after ensure/mark by poisoning the message list length
  // mid-flight: replace messages with a sparse array whose length lies about content.
  state.messages = {
    length: 5,
    slice() { throw new Error('slice failed'); },
    [Symbol.iterator]: function* () { throw new Error('iterate failed'); }
  };
  assert.equal(advanceRoomSummary(state, { force: true, safe: true }), false);
  assert.equal(state.summary.lastError, 'slice failed');
  // Original durable fields remain present; summary records the failure.
  assert.equal(state.summary.version, 1);
});

test('messageThreshold triggers checkpoint without force', () => {
  const state = baseState(0);
  for (let index = 0; index < 5; index += 1) {
    state.messages.push({
      id: `msg_t_${index}`, source: 'user', sourceName: 'You', type: 'message',
      content: `threshold-${index}`, createdAt: '2026-07-15T12:00:00.000Z'
    });
  }
  assert.equal(advanceRoomSummary(state, { messageThreshold: 5, characterThreshold: 1_000_000 }), true);
  assert.equal(state.summary.checkpoints.length, 1);
  assert.equal(state.summary.coveredThroughIndex, 4);
  const integrity = verifySummaryIntegrity(state);
  assert.equal(integrity.ok, true, integrity.errors.join('; '));
});

test('projectSummaryForApi omits checkpoint bodies and sourceMessageIds but keeps digests', () => {
  const state = baseState(3);
  advanceRoomSummary(state, { force: true });
  const projected = projectSummaryForApi(state.summary);
  assert.ok(projected.rollup?.content);
  assert.equal(projected.checkpointCount, 1);
  assert.equal(projected.checkpoints[0].sourceDigest, state.summary.checkpoints[0].sourceDigest);
  assert.equal(projected.checkpoints[0].sourceMessageCount, 3);
  assert.equal('content' in projected.checkpoints[0], false);
  assert.equal('sourceMessageIds' in projected.checkpoints[0], false);
});

test('oversized rollup keeps all fixed sections and passes integrity', () => {
  const state = baseState(0);
  // Flood active/blocked/pending so a naive global truncate would drop trailing sections.
  for (let index = 0; index < 80; index += 1) {
    state.tasks.push({
      id: `task_big_${index}`,
      title: `Oversized board item ${index} ${'x'.repeat(120)}`,
      status: index % 3 === 0 ? 'active' : index % 3 === 1 ? 'blocked' : 'review-required',
      agentId: 'codex',
      blocker: index % 3 === 1 ? `blocker detail ${'y'.repeat(80)}` : null,
      updatedAt: '2026-07-15T12:00:00.000Z'
    });
    state.approvals.push({
      id: `appr_big_${index}`,
      type: 'agent-write',
      status: 'pending',
      command: `edit file-${index}.js ${'z'.repeat(100)}`,
      taskId: `task_big_${index}`
    });
  }
  for (let index = 0; index < 5; index += 1) {
    state.messages.push({
      id: `msg_big_${index}`,
      source: 'user',
      sourceName: 'You',
      type: 'message',
      content: `noise ${index}`,
      createdAt: '2026-07-15T12:00:00.000Z'
    });
  }
  assert.equal(advanceRoomSummary(state, { force: true, rollupMaxChars: 2_000 }), true);
  const content = state.summary.rollup.content;
  assert.ok(content.length <= 2_000, `rollup length ${content.length} exceeds cap`);
  for (const title of ROLLUP_SECTIONS) {
    assert.ok(content.includes(`## ${title}`), `missing section ${title}`);
  }
  assert.equal(verifySummaryIntegrity(state).ok, true, verifySummaryIntegrity(state).errors.join('; '));
  assert.equal(state.summary.lastError, null);
});

test('generated summary content is re-scanned for secrets before persistence', () => {
  const state = baseState(0);
  state.messages.push({
    id: 'msg_secret',
    source: 'user',
    sourceName: 'You',
    type: 'message',
    content: 'rotate key sk-abcdefghijklmnopqrstuvwxyz012345 and keep going',
    createdAt: '2026-07-15T12:00:00.000Z'
  });
  state.approvals[0].command = 'token=super-sensitive-value npm test';
  state.tasks[1].title = 'Handle password=hunter2-migration';
  assert.equal(advanceRoomSummary(state, { force: true }), true);

  const checkpoint = state.summary.checkpoints[0].content;
  const rollup = state.summary.rollup.content;
  assert.doesNotMatch(checkpoint, /sk-abcdefghijklmnopqrstuvwxyz012345/);
  assert.match(checkpoint, /\[REDACTED\]/);
  assert.doesNotMatch(rollup, /super-sensitive-value/);
  assert.doesNotMatch(rollup, /hunter2-migration/);
  assert.match(rollup, /\[REDACTED\]/);
  assert.equal(state.summary.checkpoints[0].contentHash, hashText(checkpoint));
  assert.equal(state.summary.rollup.contentHash, hashText(rollup));
});

test('integrity gate restores prior rollup and sets lastError when provisional commit fails', () => {
  const state = baseState(3);
  assert.equal(advanceRoomSummary(state, { force: true }), true);
  const priorContent = state.summary.rollup.content;
  const priorRevision = state.summary.rollup.revision;
  const priorCheckpointCount = state.summary.checkpoints.length;

  // Plant a coverage gap so any provisional rebuild fails verifySummaryIntegrity.
  state.summary.checkpoints.push({
    id: 'sumcp_gap',
    roomId: 'room_test',
    revision: 1,
    status: 'current',
    fromIndexExclusive: 99,
    throughIndexInclusive: 100,
    sourceMessageIds: ['ghost_a', 'ghost_b'],
    sourceDigest: 'dead',
    content: '## Covered activity\ngap',
    contentHash: hashText('## Covered activity\ngap'),
    producerType: 'deterministic',
    producerId: 'room-summary-v1',
    generatedAt: '2026-07-15T12:00:00.000Z',
    staleReason: null
  });
  assert.equal(verifySummaryIntegrity(state).ok, false);

  // Force a rebuild attempt (structured change) — gate must restore the pre-call snapshot.
  state.tasks[1].status = 'completed';
  const changed = advanceRoomSummary(state, { messageThreshold: 100, characterThreshold: 1_000_000 });
  assert.equal(changed, true, 'stale mark / restore still counts as a state change');
  assert.equal(state.summary.rollup.content, priorContent);
  assert.equal(state.summary.rollup.revision, priorRevision);
  assert.equal(state.summary.checkpoints.length, priorCheckpointCount + 1, 'snapshot includes planted gap');
  assert.ok(state.summary.lastError, 'lastError records the integrity failure');
  assert.match(state.summary.lastError, /gap|mismatch|past the message/i);
  assert.equal(state.summary.rollup.status, 'stale');
  assert.equal(state.summary.rollup.staleReason, 'generation-failed-integrity');
});

test('regenerateStaleCheckpoints skips ranges whose source ids no longer match', () => {
  const state = baseState(3);
  advanceRoomSummary(state, { force: true });
  state.messages[1] = {
    id: 'msg_id_shifted',
    source: 'codex',
    sourceName: 'Codex',
    type: 'message',
    content: 'different id under the same index',
    createdAt: '2026-07-15T12:00:00.000Z'
  };
  markStaleIfSourcesChanged(state);
  assert.equal(state.summary.checkpoints[0].status, 'stale');
  assert.equal(regenerateStaleCheckpoints(state), false);
  assert.equal(state.summary.checkpoints[0].status, 'stale');
  assert.match(state.summary.checkpoints[0].content, /Message number/);
});

test('server persists summary in room state and exposes it via /api/state', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-room-summary-'));
  const app = new ConclaveApp({
    sessionToken: 'test-token',
    workspace: directory,
    storeFile: path.join(directory, '.state', 'state.json'),
    summaryDebounceMs: 0,
    summaryOptions: { messageThreshold: 3, characterThreshold: 1_000_000 }
  });
  await app.initialize();
  app.processes.start = () => { throw new Error('no real processes in this test'); };
  const address = await app.listen({ port: 0 });
  context.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  // Seed enough messages to trip the threshold, then force a refresh (debounce is 0).
  await app.store.update((state) => {
    for (let index = 0; index < 4; index += 1) {
      state.messages.push({
        id: `seed_${index}`,
        source: 'user',
        sourceName: 'You',
        type: 'message',
        content: `seeded activity ${index}`,
        createdAt: new Date().toISOString()
      });
    }
  });
  const changed = await app.refreshRoomSummary('test');
  assert.equal(changed, true);
  assert.ok(app.store.state.summary?.rollup);
  assert.ok(app.store.state.summary.checkpoints.length >= 1);

  const integrity = verifySummaryIntegrity(app.store.state);
  assert.equal(integrity.ok, true, integrity.errors.join('; '));

  const base = `http://127.0.0.1:${address.port}`;
  const projected = await (await fetch(`${base}/api/state`, { headers: { 'x-conclave-token': 'test-token' } })).json();
  assert.ok(projected.summary, 'summary is present in /api/state');
  assert.ok(projected.summary.rollup?.content.includes('## Objective and operator constraints'));
  assert.equal(projected.summary.coveredThroughIndex, app.store.state.summary.coveredThroughIndex);
  assert.equal(
    projected.summary.checkpoints[0]?.content,
    undefined,
    'checkpoint prose is not projected in the list'
  );
  // Store still holds full checkpoint content for integrity.
  assert.ok(app.store.state.summary.checkpoints[0].content.includes('## Covered activity'));
});

test('ensureSummaryState backfills missing summary on legacy state', () => {
  const state = { room: { id: 'room_legacy' }, messages: [] };
  const summary = ensureSummaryState(state);
  assert.equal(summary.roomId, 'room_legacy');
  assert.equal(summary.coveredThroughIndex, -1);
  assert.deepEqual(summary.checkpoints, []);
});
