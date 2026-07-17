/**
 * Adversarial memory evaluation harness (ADR-0001 / docs/memory.md).
 *
 * Seeds the labeled corpus into MemoryDb, runs assembleContext against each
 * labeled query, and scores relevant recall, false recall, cross-room isolation,
 * stale supersession, malicious stored-content handling, deletion, latency,
 * and prompt-token overhead.
 *
 * Pure library: no network, no process spawn. Safe for node:test and CI.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { MemoryDb } from './memory-db.js';
import { assembleContext } from './context-assembler.js';
import { now } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORPUS_PATH = path.resolve(
  __dirname,
  '../../test/fixtures/adversarial-memory-corpus.json'
);

/** Same estimator identity used by context receipts (`chars/4`). */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

export function loadCorpus(corpusPath = DEFAULT_CORPUS_PATH) {
  const raw = readFileSync(corpusPath, 'utf8');
  const corpus = JSON.parse(raw);
  if (!corpus?.rooms?.length || !corpus?.queries?.length) {
    throw new Error('adversarial corpus missing rooms or queries');
  }
  return corpus;
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

/**
 * Seed a MemoryDb from the corpus. Returns { db, corpus }.
 * @param {object} [options]
 * @param {string} [options.dbPath]
 * @param {object} [options.corpus]
 * @param {string} [options.corpusPath]
 */
export function seedAdversarialCorpus(options = {}) {
  const corpus = options.corpus || loadCorpus(options.corpusPath || DEFAULT_CORPUS_PATH);
  const db = new MemoryDb(options.dbPath || ':memory:');
  db.init();

  for (const room of corpus.rooms) {
    db.saveRoom({ id: room.id, name: room.name || room.id, createdAt: now() });

    for (const msg of room.messages || []) {
      db.saveMessage({
        id: msg.id,
        roomId: room.id,
        sequence: msg.sequence,
        sourceType: msg.sourceType || 'user',
        sourceId: msg.sourceId || null,
        sourceNameSnapshot: msg.sourceNameSnapshot || 'Unknown',
        type: msg.type || 'message',
        content: msg.content,
        contentHash: contentHash(msg.content),
        revision: 1,
        createdAt: now(),
        timestampStatus: 'valid'
      });
    }

    // Two-phase insert so supersession FKs can resolve (stale before current, then link).
    for (const item of room.memoryItems || []) {
      db.rememberNode({
        id: item.id,
        roomId: room.id,
        workspaceId: item.workspaceId || null,
        kind: item.kind,
        title: item.title,
        statement: item.statement,
        status: item.status,
        scope: item.scope || 'room',
        supersedesItemId: null,
        supersededByItemId: null,
        version: 1,
        createdAt: now(),
        updatedAt: now()
      });
    }
    for (const item of room.memoryItems || []) {
      if (!item.supersedesItemId && !item.supersededByItemId) continue;
      db.rememberNode({
        id: item.id,
        roomId: room.id,
        workspaceId: item.workspaceId || null,
        kind: item.kind,
        title: item.title,
        statement: item.statement,
        status: item.status,
        scope: item.scope || 'room',
        supersedesItemId: item.supersedesItemId || null,
        supersededByItemId: item.supersededByItemId || null,
        version: 1,
        createdAt: now(),
        updatedAt: now()
      });
    }

    for (const rollup of room.rollups || []) {
      db.saveRollup({
        id: rollup.id,
        roomId: room.id,
        revision: rollup.revision || 1,
        status: rollup.status || 'current',
        throughSequenceInclusive: rollup.throughSequenceInclusive,
        structuredStateDigest: rollup.structuredStateDigest || 'ssd',
        ledgerDigest: rollup.ledgerDigest || 'ld',
        content: rollup.content,
        contentHash: contentHash(rollup.content),
        producerType: 'fixture',
        producerId: 'adversarial-corpus',
        generatedAt: now()
      });
    }
  }

  return { db, corpus };
}

/**
 * Apply labeled deletions for after_delete phases.
 */
export function applyDeletions(db, query) {
  for (const id of query.deleteObjectIds || []) {
    db.deleteNode(id);
  }
  // Forget path: hard purge so FTS/revisions leave no canary residue (AC-12).
  for (const id of query.deleteMessageIds || []) {
    if (typeof db.purgeMessage === 'function') {
      db.purgeMessage(id);
    } else {
      db.deleteMessage(id);
    }
  }
}

/**
 * Scan SQLite + FTS for residual canary strings after deletion (AC-12 style).
 */
export function scanForResidues(db, needles) {
  const hits = [];
  for (const needle of needles) {
    if (!needle) continue;
    const like = `%${needle}%`;
    const tables = [
      ['messages', 'content'],
      ['message_revisions', 'content'],
      ['memory_items', 'statement'],
      ['memory_items', 'title'],
      ['memory_item_revisions', 'statement'],
      ['memory_item_revisions', 'title'],
      ['summary_rollups', 'content'],
      ['summary_checkpoints', 'content'],
      ['messages_fts', 'content'],
      ['memory_items_fts', 'statement']
    ];
    for (const [table, column] of tables) {
      try {
        // Soft-deleted messages still retain content by design; only active
        // retrieval surfaces and hard-deleted nodes must be clean. For messages
        // table, ignore rows with deletedAt set when scanning "active" residue.
        let sql;
        if (table === 'messages') {
          sql = `SELECT id FROM messages WHERE ${column} LIKE ? AND deletedAt IS NULL LIMIT 1`;
        } else {
          sql = `SELECT rowid AS id FROM ${table} WHERE ${column} LIKE ? LIMIT 1`;
        }
        const row = db.db.prepare(sql).get(like);
        if (row) {
          hits.push({ needle, table, column, id: row.id });
        }
      } catch {
        // FTS or missing table — skip
      }
    }
  }
  return hits;
}

function selectedIds(assembly) {
  return new Set(
    (assembly.entries || [])
      .filter((e) => e.status === 'selected')
      .map((e) => e.objectId)
  );
}

function checkIncludes(set, required) {
  const missing = [];
  for (const id of required || []) {
    if (!set.has(id)) missing.push(id);
  }
  return missing;
}

function checkExcludes(set, forbidden) {
  const leaked = [];
  for (const id of forbidden || []) {
    if (set.has(id)) leaked.push(id);
  }
  return leaked;
}

function checkSubstrings(text, required, forbidden) {
  const missing = [];
  const leaked = [];
  for (const s of required || []) {
    if (!text.includes(s)) missing.push(s);
  }
  for (const s of forbidden || []) {
    if (text.includes(s)) leaked.push(s);
  }
  return { missing, leaked };
}

/**
 * Score one labeled query against an assembly result.
 */
export function scoreQuery(query, assembly, extra = {}) {
  const ids = selectedIds(assembly);
  const block = assembly.memoryBlock || '';
  const missingIds = checkIncludes(ids, query.mustIncludeObjectIds);
  const leakedIds = checkExcludes(ids, query.mustExcludeObjectIds);
  const { missing: missingSub, leaked: leakedSub } = checkSubstrings(
    block,
    query.mustIncludeSubstrings,
    query.mustExcludeSubstrings
  );

  const missingEscaped = [];
  for (const marker of query.requireEscapedMarkers || []) {
    if (!block.includes(marker)) missingEscaped.push(marker);
  }

  const maliciousRaw = leakedSub.filter((s) =>
    ['```', 'SYSTEM:', 'USER:', 'ASSISTANT:', 'DEVELOPER:', 'conclave-plan', 'conclave-identity', '<untrusted_memory_context>'].includes(s)
  );

  const excessiveSubstringOccurrences = [];
  for (const [substring, maximum] of Object.entries(query.maxSubstringOccurrences || {})) {
    const occurrences = substring ? block.split(substring).length - 1 : 0;
    if (occurrences > maximum) excessiveSubstringOccurrences.push({ substring, occurrences, maximum });
  }

  // False-recall / retrieval-only exclusions: object may appear in recent dump,
  // but must not be chosen as hybrid "retrieved" evidence for this query.
  const wronglyRetrieved = [];
  for (const id of query.mustNotRetrieveObjectIds || []) {
    const hit = (assembly.entries || []).find(
      (e) => e.status === 'selected' && e.objectId === id && String(e.reason || '').includes('retrieved')
    );
    if (hit) wronglyRetrieved.push(id);
  }

  const tokens = estimateTokens(block);
  const passed =
    missingIds.length === 0 &&
    leakedIds.length === 0 &&
    missingSub.length === 0 &&
    leakedSub.length === 0 &&
    missingEscaped.length === 0 &&
    excessiveSubstringOccurrences.length === 0 &&
    wronglyRetrieved.length === 0 &&
    (extra.residueHits || []).length === 0;

  return {
    queryId: query.id,
    category: query.category,
    phase: query.phase || null,
    passed,
    missingIds,
    leakedIds,
    missingSubstrings: missingSub,
    leakedSubstrings: leakedSub,
    missingEscapedMarkers: missingEscaped,
    excessiveSubstringOccurrences,
    wronglyRetrieved,
    maliciousRawMarkers: maliciousRaw,
    residueHits: extra.residueHits || [],
    selectedCount: ids.size,
    memoryBlockChars: block.length,
    estimatedTokens: tokens,
    latencyMs: extra.latencyMs ?? null,
    receipt: assembly.receipt
      ? {
          id: assembly.receipt.id,
          totalCharacters: assembly.receipt.totalCharacters,
          assemblerVersion: assembly.receipt.assemblerVersion,
          estimatorVersion: assembly.receipt.estimatorVersion
        }
      : null
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Run the full evaluation suite.
 * @returns {{ report: object, results: object[], db: MemoryDb, corpus: object }}
 */
export function runAdversarialEvaluation(options = {}) {
  const { db, corpus } = seedAdversarialCorpus(options);
  const thresholds = { ...corpus.thresholds, ...(options.thresholds || {}) };
  const maxCharacters = options.maxCharacters ?? 24000;
  const nonMemoryLength = options.nonMemoryLength ?? 2000;
  const latencySamples = thresholds.latencySamples ?? 25;

  const results = [];
  const latencyMs = [];
  let deleted = false;

  // Pre-delete phase first (stable order by corpus definition)
  const ordered = [...corpus.queries].sort((a, b) => {
    const phaseRank = (q) => (q.phase === 'after_delete' ? 1 : 0);
    return phaseRank(a) - phaseRank(b);
  });

  for (const query of ordered) {
    if (query.phase === 'after_delete' && !deleted) {
      applyDeletions(db, query);
      deleted = true;
    }

    const t0 = performance.now();
    const assembly = assembleContext(db, {
      roomId: query.roomId,
      queryText: query.queryText,
      maxCharacters,
      nonMemoryLength,
      executionId: `eval-${query.id}`
    });
    const t1 = performance.now();
    const oneShotMs = t1 - t0;
    latencyMs.push(oneShotMs);

    // Extra latency samples on a representative query for p95
    if (query.id === 'q-relevant-store') {
      for (let i = 0; i < latencySamples - 1; i++) {
        const s0 = performance.now();
        assembleContext(db, {
          roomId: query.roomId,
          queryText: query.queryText,
          maxCharacters,
          nonMemoryLength,
          executionId: `eval-latency-${i}`
        });
        latencyMs.push(performance.now() - s0);
      }
    }

    let residueHits = [];
    if (query.category === 'deletion' && query.phase === 'after_delete') {
      residueHits = scanForResidues(db, query.mustExcludeSubstrings || []);
    }

    results.push(
      scoreQuery(query, assembly, {
        latencyMs: oneShotMs,
        residueHits
      })
    );
  }

  const byCategory = (cat) => results.filter((r) => r.category === cat);
  const failCount = (cat) => byCategory(cat).filter((r) => !r.passed).length;

  const relevant = byCategory('relevant_recall');
  const relevantHits = relevant.filter((r) => r.passed).length;
  const relevantRecall =
    relevant.length === 0 ? 1 : relevantHits / relevant.length;

  const falseRecallFails = failCount('false_recall');
  const crossRoomFails = failCount('cross_room_isolation');
  const staleFails = failCount('stale_supersession');
  const maliciousFails = failCount('malicious_content');
  const deletionFails = failCount('deletion');

  const sortedLat = [...latencyMs].sort((a, b) => a - b);
  const p95 = percentile(sortedLat, 95);
  const p50 = percentile(sortedLat, 50);

  const maxBlockChars = Math.max(0, ...results.map((r) => r.memoryBlockChars));
  const maxTokens = Math.max(0, ...results.map((r) => r.estimatedTokens));

  const gates = {
    relevant_recall: {
      value: relevantRecall,
      threshold: thresholds.relevantRecallMin ?? 1,
      passed: relevantRecall >= (thresholds.relevantRecallMin ?? 1)
    },
    false_recall: {
      value: falseRecallFails,
      threshold: thresholds.falseRecallMax ?? 0,
      passed: falseRecallFails <= (thresholds.falseRecallMax ?? 0)
    },
    cross_room_isolation: {
      value: crossRoomFails,
      threshold: thresholds.crossRoomLeakMax ?? 0,
      passed: crossRoomFails <= (thresholds.crossRoomLeakMax ?? 0)
    },
    stale_supersession: {
      value: staleFails,
      threshold: thresholds.staleSupersessionFailMax ?? 0,
      passed: staleFails <= (thresholds.staleSupersessionFailMax ?? 0)
    },
    malicious_content: {
      value: maliciousFails,
      threshold: thresholds.maliciousMutationMax ?? 0,
      passed: maliciousFails <= (thresholds.maliciousMutationMax ?? 0)
    },
    deletion: {
      value: deletionFails,
      threshold: thresholds.deletionResidueMax ?? 0,
      passed: deletionFails <= (thresholds.deletionResidueMax ?? 0)
    },
    latency_p95_ms: {
      value: Number(p95.toFixed(3)),
      threshold: thresholds.assembleLatencyMsP95Max ?? 150,
      passed: p95 <= (thresholds.assembleLatencyMsP95Max ?? 150)
    },
    prompt_token_overhead: {
      value: maxTokens,
      threshold: thresholds.memoryTokensMax ?? 6000,
      passed:
        maxTokens <= (thresholds.memoryTokensMax ?? 6000) &&
        maxBlockChars <= (thresholds.memoryBlockCharsMax ?? 24000)
    }
  };

  const allPassed = Object.values(gates).every((g) => g.passed);

  const report = {
    corpusVersion: corpus.version,
    corpusName: corpus.name,
    estimator: corpus.estimator || 'chars/4',
    queryCount: results.length,
    passedQueryCount: results.filter((r) => r.passed).length,
    allGatesPassed: allPassed,
    gates,
    latency: {
      samples: latencyMs.length,
      p50Ms: Number(p50.toFixed(3)),
      p95Ms: Number(p95.toFixed(3)),
      maxMs: Number(Math.max(...latencyMs).toFixed(3))
    },
    tokenOverhead: {
      maxMemoryBlockChars: maxBlockChars,
      maxEstimatedTokens: maxTokens,
      estimator: corpus.estimator || 'chars/4'
    },
    results
  };

  return { report, results, db, corpus };
}

/**
 * Human-readable summary for CI logs / handoffs.
 */
export function formatEvaluationReport(report) {
  const lines = [
    `Adversarial memory eval: ${report.corpusName} v${report.corpusVersion}`,
    `Queries: ${report.passedQueryCount}/${report.queryCount} passed; gates: ${report.allGatesPassed ? 'ALL PASS' : 'FAIL'}`,
    `Latency p50=${report.latency.p50Ms}ms p95=${report.latency.p95Ms}ms max=${report.latency.maxMs}ms (n=${report.latency.samples})`,
    `Token overhead maxChars=${report.tokenOverhead.maxMemoryBlockChars} maxTokens=${report.tokenOverhead.maxEstimatedTokens} (${report.tokenOverhead.estimator})`,
    'Gates:'
  ];
  for (const [name, gate] of Object.entries(report.gates)) {
    lines.push(
      `  ${gate.passed ? 'PASS' : 'FAIL'} ${name}: value=${gate.value} threshold=${gate.threshold}`
    );
  }
  const failed = report.results.filter((r) => !r.passed);
  if (failed.length) {
    lines.push('Failed queries:');
    for (const r of failed) {
      lines.push(
        `  - ${r.queryId} [${r.category}] missingIds=${JSON.stringify(r.missingIds)} leakedIds=${JSON.stringify(r.leakedIds)} leakedSub=${JSON.stringify(r.leakedSubstrings)} residues=${r.residueHits.length}`
      );
    }
  }
  return lines.join('\n');
}
