import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CORPUS_PATH,
  estimateTokens,
  formatEvaluationReport,
  loadCorpus,
  runAdversarialEvaluation,
  scoreQuery,
  seedAdversarialCorpus,
  applyDeletions,
  scanForResidues
} from '../src/lib/adversarial-memory-eval.js';
import { assembleContext, escapeUntrustedContent } from '../src/lib/context-assembler.js';

test('adversarial corpus fixture loads with stable labeled queries', () => {
  const corpus = loadCorpus(DEFAULT_CORPUS_PATH);
  assert.equal(corpus.version, '1.0.0');
  assert.ok(corpus.rooms.length >= 2, 'needs at least two rooms for isolation');
  assert.ok(corpus.queries.length >= 6);

  const categories = new Set(corpus.queries.map((q) => q.category));
  for (const required of [
    'relevant_recall',
    'false_recall',
    'cross_room_isolation',
    'stale_supersession',
    'malicious_content',
    'deletion'
  ]) {
    assert.ok(categories.has(required), `missing category ${required}`);
  }

  // Deterministic IDs: re-load must match
  const again = loadCorpus();
  assert.deepEqual(
    again.queries.map((q) => q.id),
    corpus.queries.map((q) => q.id)
  );
});

test('seedAdversarialCorpus materializes both rooms without cross-write', () => {
  const { db, corpus } = seedAdversarialCorpus();
  const alphaMsgs = db.db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE roomId = ?')
    .get('room-alpha').n;
  const betaMsgs = db.db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE roomId = ?')
    .get('room-beta').n;
  assert.equal(alphaMsgs, corpus.rooms.find((r) => r.id === 'room-alpha').messages.length);
  assert.equal(betaMsgs, corpus.rooms.find((r) => r.id === 'room-beta').messages.length);

  const betaOnly = db.searchMessages('CROSS_ROOM_CANARY_BETA_deadbeef', { roomId: 'room-beta' });
  assert.ok(betaOnly.length >= 1);
  const alphaLeak = db.searchMessages('CROSS_ROOM_CANARY_BETA_deadbeef', { roomId: 'room-alpha' });
  assert.equal(alphaLeak.length, 0, 'FTS must not return beta canary in alpha scope');

  db.close();
});

test('relevant recall: store and exact-symbol queries retrieve labeled targets', () => {
  const { db } = seedAdversarialCorpus();
  const assembly = assembleContext(db, {
    roomId: 'room-alpha',
    queryText: 'What store does Conclave use for local memory?',
    maxCharacters: 24000,
    nonMemoryLength: 2000
  });
  const selected = new Set(assembly.entries.filter((e) => e.status === 'selected').map((e) => e.objectId));
  assert.ok(selected.has('fact-sqlite-primary'), 'must recall accepted SQLite decision');
  assert.match(assembly.memoryBlock, /SQLite/);
  assert.match(assembly.memoryBlock, /FTS5/);
  assert.doesNotMatch(assembly.memoryBlock, /CROSS_ROOM_CANARY_BETA_deadbeef/);
  db.close();
});

test('false recall: store query selects SQLite fact, not astronomy transcript as evidence', () => {
  const { db, corpus } = seedAdversarialCorpus();
  const query = corpus.queries.find((q) => q.id === 'q-false-astronomy');
  const assembly = assembleContext(db, {
    roomId: query.roomId,
    queryText: query.queryText,
    maxCharacters: 24000,
    nonMemoryLength: 2000
  });
  const scored = scoreQuery(query, assembly);
  assert.equal(scored.passed, true, JSON.stringify(scored, null, 2));
  const selected = assembly.entries.filter((e) => e.status === 'selected');
  assert.ok(selected.some((e) => e.objectId === 'fact-sqlite-primary'));
  // Unrelated weather chatter must not be chosen as retrieved/recent evidence for a DB query.
  // (A labeled proposed hypothesis may still appear in Tier 3 dump; that is not false authority.)
  assert.ok(!selected.some((e) => e.objectId === 'msg-a-distractor' && e.reason.includes('retrieved')));
  db.close();
});

test('cross-room isolation: alpha assembly never contains beta canaries (AC-10)', () => {
  const { db, corpus } = seedAdversarialCorpus();
  const query = corpus.queries.find((q) => q.id === 'q-cross-room-isolation');
  const assembly = assembleContext(db, {
    roomId: 'room-alpha',
    queryText: query.queryText,
    maxCharacters: 24000,
    nonMemoryLength: 2000
  });
  const scored = scoreQuery(query, assembly);
  assert.equal(scored.passed, true, JSON.stringify(scored, null, 2));
  assert.doesNotMatch(assembly.memoryBlock, /CROSS_ROOM_CANARY_BETA_deadbeef/);
  assert.doesNotMatch(assembly.memoryBlock, /NEBULA_VAULT/);
  assert.doesNotMatch(assembly.memoryBlock, /sk-beta-not-real/);
  db.close();
});

test('stale-memory supersession: current constraint wins; superseded and stale excluded (AC-05)', () => {
  const { db, corpus } = seedAdversarialCorpus();
  const query = corpus.queries.find((q) => q.id === 'q-stale-supersession');
  const assembly = assembleContext(db, {
    roomId: query.roomId,
    queryText: query.queryText,
    maxCharacters: 24000,
    nonMemoryLength: 2000
  });
  const scored = scoreQuery(query, assembly);
  assert.equal(scored.passed, true, JSON.stringify(scored, null, 2));
  assert.match(assembly.memoryBlock, /concurrent agents is 3/);
  assert.doesNotMatch(assembly.memoryBlock, /Concurrency limit \(stale\)/);
  assert.doesNotMatch(assembly.memoryBlock, /fact-concurrency-stale/);
  assert.doesNotMatch(assembly.memoryBlock, /CONCLAVE_LEGACY_JSON is required forever/);
  // Superseded / stale nodes must not be selected even if history still says "1".
  const selected = new Set(assembly.entries.filter((e) => e.status === 'selected').map((e) => e.objectId));
  assert.ok(selected.has('fact-concurrency-current'));
  assert.ok(!selected.has('fact-concurrency-stale'));
  assert.ok(!selected.has('fact-stale-labeled'));
  db.close();
});

test('malicious stored content: injection markers stay escaped data (AC-09)', () => {
  const { db, corpus } = seedAdversarialCorpus();
  const query = corpus.queries.find((q) => q.id === 'q-malicious-content');
  const assembly = assembleContext(db, {
    roomId: query.roomId,
    queryText: query.queryText,
    maxCharacters: 24000,
    nonMemoryLength: 2000
  });
  const scored = scoreQuery(query, assembly);
  assert.equal(scored.passed, true, JSON.stringify(scored, null, 2));
  assert.match(assembly.memoryBlock, /BEGIN UNTRUSTED ROOM MEMORY CONTEXT/);
  assert.match(assembly.memoryBlock, /escaped-plan/);
  assert.doesNotMatch(assembly.memoryBlock, /```/);
  assert.doesNotMatch(assembly.memoryBlock, /SYSTEM:/);
  assert.doesNotMatch(assembly.memoryBlock, /conclave-plan/i);
  // Direct escape helper still neutralizes the raw fixture string.
  const raw = corpus.rooms[0].messages.find((m) => m.id === 'msg-a-injection').content;
  const clean = escapeUntrustedContent(raw);
  assert.doesNotMatch(clean, /```/);
  assert.doesNotMatch(clean, /SYSTEM:/);
  db.close();
});

test('deletion / forget: canaries leave active retrieval and residue scan clean (AC-12)', () => {
  const { db, corpus } = seedAdversarialCorpus();
  const before = corpus.queries.find((q) => q.id === 'q-deletion-baseline');
  const after = corpus.queries.find((q) => q.id === 'q-deletion-after');

  const beforeAssembly = assembleContext(db, {
    roomId: before.roomId,
    queryText: before.queryText,
    maxCharacters: 24000,
    nonMemoryLength: 2000
  });
  assert.match(beforeAssembly.memoryBlock, /CANARY_DELETE_FACT_alpha_9b2/);

  applyDeletions(db, after);

  const afterAssembly = assembleContext(db, {
    roomId: after.roomId,
    queryText: after.queryText,
    maxCharacters: 24000,
    nonMemoryLength: 2000
  });
  const residues = scanForResidues(db, after.mustExcludeSubstrings);
  const scored = scoreQuery(after, afterAssembly, { residueHits: residues });
  assert.equal(scored.passed, true, JSON.stringify(scored, null, 2));
  assert.doesNotMatch(afterAssembly.memoryBlock, /CANARY_DELETE_FACT_alpha_9b2/);
  assert.doesNotMatch(afterAssembly.memoryBlock, /CANARY_DELETE_ALPHA_7f3c9e/);
  assert.equal(db.getNode('fact-delete-canary'), null);
  assert.equal(db.getMessage('msg-a-delete-canary'), null);
  db.close();
});

test('latency and prompt-token overhead stay within corpus thresholds', () => {
  const { report, db } = runAdversarialEvaluation();
  assert.ok(report.latency.samples >= 25, 'should warm-sample latency');
  assert.ok(
    report.gates.latency_p95_ms.passed,
    `latency p95 ${report.gates.latency_p95_ms.value}ms exceeds ${report.gates.latency_p95_ms.threshold}ms`
  );
  assert.ok(
    report.gates.prompt_token_overhead.passed,
    `token overhead ${report.tokenOverhead.maxEstimatedTokens} exceeds budget`
  );
  assert.ok(report.tokenOverhead.maxMemoryBlockChars <= 24000);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
  db.close();
});

test('full adversarial evaluation report: all gates pass (reproducible suite)', () => {
  const { report, db } = runAdversarialEvaluation();
  const summary = formatEvaluationReport(report);
  // Always print metrics for handoff / CI inspection
  console.log('\n' + summary + '\n');

  assert.equal(report.allGatesPassed, true, summary);
  for (const [name, gate] of Object.entries(report.gates)) {
    assert.equal(gate.passed, true, `gate ${name} failed: value=${gate.value} threshold=${gate.threshold}`);
  }
  for (const result of report.results) {
    assert.equal(result.passed, true, `query ${result.queryId} failed: ${JSON.stringify(result)}`);
  }
  assert.ok(report.receipt === undefined); // report uses nested receipt per result
  assert.ok(report.results.every((r) => r.receipt && r.receipt.estimatorVersion === 'chars/4'));
  db.close();
});
