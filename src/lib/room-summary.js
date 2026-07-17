import crypto from 'node:crypto';
import { redactSecrets } from './redact.js';
import { id, now, clampText } from './utils.js';

/** Producer identity for the deterministic structured summarizer (JSON bridge). */
export const ROOM_SUMMARY_PRODUCER = {
  type: 'deterministic',
  id: 'room-summary-v1'
};

/** Defaults from docs/memory.md §5.3 — overridable per call. */
export const DEFAULT_SUMMARY_OPTIONS = {
  messageThreshold: 20,
  characterThreshold: 12_000,
  checkpointMaxChars: 4_000,
  rollupMaxChars: 8_000,
  maxCheckpoints: 50,
  force: false
};

const EMPTY_SECTION = 'None recorded in the covered sources';

/** Hard list caps so no single section can dominate the rollup budget. */
const SECTION_LIST_CAPS = {
  landedTasks: 12,
  landedMessages: 8,
  active: 12,
  blocked: 12,
  validation: 10,
  questions: 10,
  pending: 12
};

export const ROLLUP_SECTIONS = [
  'Objective and operator constraints',
  'Landed since the prior checkpoint',
  'Active work and owners',
  'Blocked or failed work',
  'Validation and evidence',
  'Proposed/accepted decisions',
  'Open questions and disagreements',
  'Pending reviews and approvals'
];

/** Redact then clamp — secrets must not be split past redaction patterns. */
function safeClamp(value, max) {
  return clampText(redactSecrets(String(value ?? '')), max);
}

export function emptySummaryState(roomId = null) {
  return {
    version: 1,
    roomId,
    checkpoints: [],
    rollup: null,
    currentRollupRef: null,
    coveredThroughIndex: -1,
    lastError: null,
    updatedAt: null
  };
}

export function ensureSummaryState(state) {
  if (!state.summary || typeof state.summary !== 'object') {
    state.summary = emptySummaryState(state.room?.id ?? null);
  }
  const summary = state.summary;
  summary.version = 1;
  summary.roomId = state.room?.id ?? summary.roomId ?? null;
  if (!Array.isArray(summary.checkpoints)) summary.checkpoints = [];
  if (summary.rollup !== null && typeof summary.rollup !== 'object') summary.rollup = null;
  if (typeof summary.coveredThroughIndex !== 'number') summary.coveredThroughIndex = -1;
  if (!('lastError' in summary)) summary.lastError = null;
  if (!('currentRollupRef' in summary)) summary.currentRollupRef = summary.rollup
    ? { id: summary.rollup.id, revision: summary.rollup.revision }
    : null;
  return summary;
}

export function hashText(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function messageContentHash(message) {
  return hashText(String(message?.content ?? ''));
}

/**
 * Digest over an ordered message range: id, optional revision, content hash.
 * Timestamps alone are never used as provenance (docs/memory.md §3).
 */
export function sourceDigest(messages) {
  const lines = messages.map((message) => {
    const revision = message.revision ?? 1;
    return `${message.id}|${revision}|${messageContentHash(message)}`;
  });
  return hashText(lines.join('\n'));
}

export function structuredStateDigest(state) {
  const tasks = (state.tasks ?? []).map((task) => [
    task.id,
    task.status,
    task.agentId ?? '',
    task.title ?? '',
    task.blocker ?? '',
    task.updatedAt ?? ''
  ].join('|'));
  const approvals = (state.approvals ?? [])
    .filter((entry) => entry.status === 'pending')
    .map((entry) => [entry.id, entry.type, entry.taskId ?? '', entry.status].join('|'));
  const room = [
    state.room?.id ?? '',
    state.room?.name ?? '',
    state.room?.trust ?? '',
    state.room?.paused ? '1' : '0',
    state.room?.coordinatorId ?? ''
  ].join('|');
  return hashText([room, ...tasks, ...approvals].join('\n'));
}

function formatMessageLine(message, clamp = 240) {
  const label = message.type && message.type !== 'message' ? ` [${message.type}]` : '';
  return `- ${message.sourceName || message.source || 'unknown'}${label}: ${safeClamp(message.content, clamp)}`;
}

function section(title, body) {
  const text = String(body ?? '').trim() || EMPTY_SECTION;
  return `## ${title}\n${text}`;
}

/**
 * Assemble fixed-section markdown so every section header always survives.
 * Global post-hoc truncation is forbidden — it would drop trailing sections.
 */
function assembleFixedSections(bodies, maxChars) {
  const titles = ROLLUP_SECTIONS;
  const headerOverhead = titles.reduce((sum, title) => sum + `## ${title}\n`.length, 0)
    + Math.max(0, titles.length - 1) * 2; // blank-line separators
  let bodyBudget = Math.max(40, Math.floor((maxChars - headerOverhead) / titles.length));

  const render = (budget) => titles.map((title) => {
    const raw = String(bodies[title] ?? '').trim() || EMPTY_SECTION;
    return section(title, safeClamp(raw, budget));
  }).join('\n\n');

  let content = render(bodyBudget);
  while (content.length > maxChars && bodyBudget > 24) {
    bodyBudget = Math.max(24, Math.floor(bodyBudget * 0.75));
    content = render(bodyBudget);
  }
  // Absolute floor: headers + empty markers only (still all eight sections).
  if (content.length > maxChars) {
    content = titles.map((title) => section(title, EMPTY_SECTION)).join('\n\n');
  }
  return content;
}

function buildCheckpointContent(messages, { maxChars }) {
  const lines = messages.map((message) => formatMessageLine(message));
  let content = section(
    'Covered activity',
    lines.length ? lines.join('\n') : EMPTY_SECTION
  );
  if (content.length > maxChars) {
    // Single-section checkpoint: truncate body only, keep the header.
    const header = '## Covered activity\n';
    const bodyBudget = Math.max(0, maxChars - header.length - 1);
    const body = lines.length ? lines.join('\n') : EMPTY_SECTION;
    content = header + (body.length > bodyBudget
      ? `${body.slice(0, bodyBudget)}…`
      : body);
  }
  return redactSecrets(content);
}

function agentLabel(state, agentId) {
  if (!agentId) return 'unassigned';
  const agent = (state.agents ?? []).find((entry) => entry.id === agentId);
  return agent?.name || agentId;
}

function buildRollupContent(state, checkpointMessages, { maxChars }) {
  const tasks = state.tasks ?? [];
  const approvals = state.approvals ?? [];
  const executions = state.executions ?? [];

  const objective = [
    `Room: ${safeClamp(state.room?.name || 'unnamed', 120)}`,
    `Trust: ${state.room?.trust || 'gated'}`,
    state.room?.paused ? 'Paused: yes' : 'Paused: no',
    state.room?.coordinatorId
      ? `Coordinator: ${agentLabel(state, state.room.coordinatorId)}`
      : 'Coordinator: none'
  ].join('\n');

  const landedTasks = tasks
    .filter((task) => task.status === 'completed')
    .slice(0, SECTION_LIST_CAPS.landedTasks)
    .map((task) => `- completed: ${safeClamp(task.title, 160)} (${agentLabel(state, task.agentId)})`);
  const landedMessages = checkpointMessages
    .filter((message) => ['handoff', 'review', 'autopilot'].includes(message.type) || message.source === 'system')
    .slice(-SECTION_LIST_CAPS.landedMessages)
    .map((message) => formatMessageLine(message, 160));
  const landed = [...landedTasks, ...landedMessages];

  const active = tasks
    .filter((task) => ['ready', 'active', 'waiting'].includes(task.status))
    .slice(0, SECTION_LIST_CAPS.active)
    .map((task) => `- ${task.status}: ${safeClamp(task.title, 160)} — ${agentLabel(state, task.agentId)}`);

  const blocked = tasks
    .filter((task) => ['blocked', 'failed', 'rejected', 'cancelled'].includes(task.status))
    .slice(0, SECTION_LIST_CAPS.blocked)
    .map((task) => `- ${task.status}: ${safeClamp(task.title, 160)}${task.blocker ? ` — ${safeClamp(task.blocker, 120)}` : ''}`);

  const validation = executions
    .filter((execution) => ['completed', 'failed', 'cancelled'].includes(execution.status))
    .slice(0, SECTION_LIST_CAPS.validation)
    .map((execution) => {
      const code = execution.exitCode === null || execution.exitCode === undefined ? '' : ` exit=${execution.exitCode}`;
      return `- ${execution.status}${code}: ${safeClamp(execution.purpose || execution.command || execution.id, 140)}`;
    });

  const decisions = EMPTY_SECTION; // Tier 3 ledger not wired in this phase

  const questions = checkpointMessages
    .filter((message) => message.type === 'blocker' || /\?\s*$/.test(String(message.content || '').trim()))
    .slice(-SECTION_LIST_CAPS.questions)
    .map((message) => formatMessageLine(message, 160));

  const pending = [
    ...tasks
      .filter((task) => task.status === 'review-required')
      .map((task) => `- review-required: ${safeClamp(task.title, 160)} (${agentLabel(state, task.agentId)})`),
    ...approvals
      .filter((approval) => approval.status === 'pending')
      .map((approval) => `- pending approval (${approval.type}): ${safeClamp(approval.command || approval.reason || approval.id, 140)}`)
  ].slice(0, SECTION_LIST_CAPS.pending);

  const bodies = {
    'Objective and operator constraints': objective,
    'Landed since the prior checkpoint': landed.join('\n'),
    'Active work and owners': active.join('\n'),
    'Blocked or failed work': blocked.join('\n'),
    'Validation and evidence': validation.join('\n'),
    'Proposed/accepted decisions': decisions,
    'Open questions and disagreements': questions.join('\n'),
    'Pending reviews and approvals': pending.join('\n')
  };

  return assembleFixedSections(bodies, maxChars);
}

function uncoveredStats(state, coveredThroughIndex) {
  const messages = state.messages ?? [];
  const start = coveredThroughIndex + 1;
  let characters = 0;
  for (let index = start; index < messages.length; index += 1) {
    characters += String(messages[index]?.content ?? '').length;
  }
  return {
    count: Math.max(0, messages.length - start),
    characters,
    fromIndex: start,
    throughIndex: messages.length - 1
  };
}

function materialStructuredChange(state, previousDigest) {
  if (!previousDigest) return true;
  return structuredStateDigest(state) !== previousDigest;
}

/**
 * Build one immutable checkpoint for a contiguous message index range.
 * Indices are the JSON-bridge stand-in for room sequence until SQLite.
 */
export function buildCheckpoint(state, fromIndexExclusive, throughIndexInclusive, options = {}) {
  const opts = { ...DEFAULT_SUMMARY_OPTIONS, ...options };
  const messages = state.messages ?? [];
  if (throughIndexInclusive < fromIndexExclusive + 1) {
    throw new Error('checkpoint range is empty');
  }
  if (fromIndexExclusive < -1 || throughIndexInclusive >= messages.length) {
    throw new Error('checkpoint range is out of bounds');
  }
  const slice = messages.slice(fromIndexExclusive + 1, throughIndexInclusive + 1);
  const content = buildCheckpointContent(slice, { maxChars: opts.checkpointMaxChars });
  const generatedAt = now();
  return {
    id: id('sumcp'),
    roomId: state.room?.id ?? null,
    revision: 1,
    status: 'current',
    fromIndexExclusive,
    throughIndexInclusive,
    sourceMessageIds: slice.map((message) => message.id),
    sourceDigest: sourceDigest(slice),
    content,
    contentHash: hashText(content),
    producerType: ROOM_SUMMARY_PRODUCER.type,
    producerId: ROOM_SUMMARY_PRODUCER.id,
    generatedAt,
    staleReason: null
  };
}

export function buildRollup(state, checkpoints, options = {}) {
  const opts = { ...DEFAULT_SUMMARY_OPTIONS, ...options };
  const active = checkpoints.filter((entry) => entry.status === 'current' || entry.status === 'stale');
  const throughIndexInclusive = active.length
    ? Math.max(...active.map((entry) => entry.throughIndexInclusive))
    : -1;
  const coveredMessages = throughIndexInclusive >= 0
    ? (state.messages ?? []).slice(0, throughIndexInclusive + 1)
    : [];
  // Prefer messages from the newest checkpoint for "landed" prose; structured
  // task/approval/run claims still come from live state.
  const newest = active.at(-1);
  const checkpointMessages = newest
    ? (state.messages ?? []).slice(newest.fromIndexExclusive + 1, newest.throughIndexInclusive + 1)
    : coveredMessages;
  const content = buildRollupContent(state, checkpointMessages, { maxChars: opts.rollupMaxChars });
  const previous = state.summary?.rollup;
  const revision = previous ? (previous.revision || 0) + 1 : 1;
  const rollupId = previous?.id || id('sumroll');
  const generatedAt = now();
  return {
    id: rollupId,
    roomId: state.room?.id ?? null,
    revision,
    status: 'current',
    checkpointIds: active.map((entry) => entry.id),
    throughIndexInclusive,
    structuredStateDigest: structuredStateDigest(state),
    content,
    contentHash: hashText(content),
    producerType: ROOM_SUMMARY_PRODUCER.type,
    producerId: ROOM_SUMMARY_PRODUCER.id,
    generatedAt,
    staleReason: null
  };
}

/**
 * Recompute digests/hashes against the live store and report integrity problems.
 * Does not mutate state.
 */
export function verifySummaryIntegrity(state) {
  const errors = [];
  const summary = state?.summary;
  if (!summary) return { ok: true, errors: [], coverage: { coveredThroughIndex: -1, messageCount: state?.messages?.length ?? 0 } };

  const messages = state.messages ?? [];
  const checkpoints = summary.checkpoints ?? [];
  // Contiguity is required among non-superseded checkpoints. A trimmed head
  // (maxCheckpoints) may start after -1; that is allowed for the JSON bridge.
  let previousThrough = null;

  for (const checkpoint of checkpoints) {
    if (checkpoint.status === 'superseded') continue;
    if (previousThrough === null) {
      previousThrough = checkpoint.fromIndexExclusive;
    }
    if (checkpoint.fromIndexExclusive !== previousThrough) {
      errors.push(`checkpoint ${checkpoint.id} leaves a coverage gap or overlap (expected fromIndexExclusive=${previousThrough}, got ${checkpoint.fromIndexExclusive})`);
    }
    if (checkpoint.throughIndexInclusive < checkpoint.fromIndexExclusive + 1) {
      errors.push(`checkpoint ${checkpoint.id} has an empty range`);
    }
    if (checkpoint.throughIndexInclusive >= messages.length) {
      errors.push(`checkpoint ${checkpoint.id} points past the message list`);
    } else {
      const slice = messages.slice(checkpoint.fromIndexExclusive + 1, checkpoint.throughIndexInclusive + 1);
      const expectedIds = slice.map((message) => message.id);
      if (JSON.stringify(expectedIds) !== JSON.stringify(checkpoint.sourceMessageIds ?? [])) {
        errors.push(`checkpoint ${checkpoint.id} sourceMessageIds do not match the covered range`);
      }
      const digest = sourceDigest(slice);
      if (digest !== checkpoint.sourceDigest) {
        errors.push(`checkpoint ${checkpoint.id} sourceDigest mismatch`);
      }
    }
    if (hashText(checkpoint.content) !== checkpoint.contentHash) {
      errors.push(`checkpoint ${checkpoint.id} contentHash mismatch`);
    }
    previousThrough = checkpoint.throughIndexInclusive;
  }

  if (summary.rollup) {
    if (hashText(summary.rollup.content) !== summary.rollup.contentHash) {
      errors.push(`rollup ${summary.rollup.id} contentHash mismatch`);
    }
    if (summary.currentRollupRef
      && (summary.currentRollupRef.id !== summary.rollup.id
        || summary.currentRollupRef.revision !== summary.rollup.revision)) {
      errors.push('currentRollupRef does not match the stored rollup');
    }
    for (const title of ROLLUP_SECTIONS) {
      if (!summary.rollup.content.includes(`## ${title}`)) {
        errors.push(`rollup missing fixed section “${title}”`);
      }
    }
  }

  if (typeof summary.coveredThroughIndex === 'number' && previousThrough !== null) {
    // coveredThroughIndex may lag when sources go stale, but must never claim past
    // the newest non-superseded checkpoint's end.
    if (summary.coveredThroughIndex > previousThrough) {
      errors.push('coveredThroughIndex is ahead of retained checkpoints');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    coverage: {
      coveredThroughIndex: summary.coveredThroughIndex,
      messageCount: messages.length,
      checkpointCount: checkpoints.length
    }
  };
}

/**
 * Mark checkpoints whose source messages no longer match stored digests.
 * Any stale checkpoint also marks the rollup stale (dependent synthesis).
 * Returns true when any record was marked stale.
 */
export function markStaleIfSourcesChanged(state) {
  const summary = ensureSummaryState(state);
  const messages = state.messages ?? [];
  let changed = false;
  let checkpointStale = false;
  for (const checkpoint of summary.checkpoints) {
    if (checkpoint.status === 'superseded') continue;
    if (checkpoint.throughIndexInclusive >= messages.length) {
      if (checkpoint.status !== 'stale' || checkpoint.staleReason !== 'source-range-missing') {
        checkpoint.status = 'stale';
        checkpoint.staleReason = 'source-range-missing';
        changed = true;
      }
      checkpointStale = true;
      continue;
    }
    const slice = messages.slice(checkpoint.fromIndexExclusive + 1, checkpoint.throughIndexInclusive + 1);
    if (sourceDigest(slice) !== checkpoint.sourceDigest) {
      if (checkpoint.status !== 'stale' || checkpoint.staleReason !== 'source-digest-mismatch') {
        checkpoint.status = 'stale';
        checkpoint.staleReason = 'source-digest-mismatch';
        changed = true;
      }
      checkpointStale = true;
    } else if (checkpoint.status === 'stale') {
      checkpointStale = true;
    }
  }
  if (checkpointStale && summary.rollup) {
    if (summary.rollup.status !== 'stale'
      || !['source-checkpoint-stale', 'structured-state-changed', 'generation-failed-integrity'].includes(summary.rollup.staleReason)) {
      summary.rollup.status = 'stale';
      summary.rollup.staleReason = 'source-checkpoint-stale';
      changed = true;
    }
  }
  if (summary.rollup && materialStructuredChange(state, summary.rollup.structuredStateDigest)) {
    if (summary.rollup.status !== 'stale' || summary.rollup.staleReason !== 'structured-state-changed') {
      summary.rollup.status = 'stale';
      summary.rollup.staleReason = 'structured-state-changed';
      changed = true;
    }
  }
  if (changed) summary.updatedAt = now();
  return changed;
}

/**
 * Rebuild stale checkpoint prose/digests from the current source range in place.
 * Replaces pre-edit text so redacted/rewritten sources are not retained on disk.
 * Skips ranges that no longer match stored sourceMessageIds (structural shift).
 */
export function regenerateStaleCheckpoints(state, options = {}) {
  const opts = { ...DEFAULT_SUMMARY_OPTIONS, ...options };
  const summary = ensureSummaryState(state);
  const messages = state.messages ?? [];
  let changed = false;
  for (const checkpoint of summary.checkpoints) {
    if (checkpoint.status !== 'stale') continue;
    if (checkpoint.staleReason === 'source-range-missing') continue;
    if (checkpoint.throughIndexInclusive >= messages.length) continue;
    if (checkpoint.fromIndexExclusive < -1) continue;
    const slice = messages.slice(checkpoint.fromIndexExclusive + 1, checkpoint.throughIndexInclusive + 1);
    const expectedIds = slice.map((message) => message.id);
    if (JSON.stringify(expectedIds) !== JSON.stringify(checkpoint.sourceMessageIds ?? [])) {
      continue;
    }
    const content = buildCheckpointContent(slice, { maxChars: opts.checkpointMaxChars });
    checkpoint.content = content;
    checkpoint.contentHash = hashText(content);
    checkpoint.sourceDigest = sourceDigest(slice);
    checkpoint.status = 'current';
    checkpoint.staleReason = null;
    checkpoint.revision = (checkpoint.revision || 1) + 1;
    checkpoint.generatedAt = now();
    checkpoint.producerType = ROOM_SUMMARY_PRODUCER.type;
    checkpoint.producerId = ROOM_SUMMARY_PRODUCER.id;
    changed = true;
  }
  if (changed) summary.updatedAt = now();
  return changed;
}

function cloneSummarySnapshot(summary) {
  return {
    checkpoints: (summary.checkpoints ?? []).map((entry) => ({ ...entry })),
    coveredThroughIndex: summary.coveredThroughIndex,
    rollup: summary.rollup ? { ...summary.rollup } : null,
    currentRollupRef: summary.currentRollupRef ? { ...summary.currentRollupRef } : null,
    lastError: summary.lastError,
    updatedAt: summary.updatedAt
  };
}

function restoreSummarySnapshot(summary, snapshot) {
  summary.checkpoints = snapshot.checkpoints;
  summary.coveredThroughIndex = snapshot.coveredThroughIndex;
  summary.rollup = snapshot.rollup;
  summary.currentRollupRef = snapshot.currentRollupRef;
  summary.lastError = snapshot.lastError;
  summary.updatedAt = snapshot.updatedAt;
}

/**
 * Incrementally advance checkpoints and rebuild the current rollup when thresholds
 * are met. Safe to call after any message/domain mutation. Returns whether summary
 * state changed. Never throws into the caller for generation failures when
 * `options.safe` is true (default).
 *
 * Commits only after `verifySummaryIntegrity` passes; on failure the prior
 * checkpoint/rollup snapshot is restored and `lastError` is set.
 */
export function advanceRoomSummary(state, options = {}) {
  const opts = { ...DEFAULT_SUMMARY_OPTIONS, ...options };
  const safe = opts.safe !== false;
  try {
    const summary = ensureSummaryState(state);
    markStaleIfSourcesChanged(state);
    const regenerated = regenerateStaleCheckpoints(state, opts);

    const uncovered = uncoveredStats(state, summary.coveredThroughIndex);
    const needsCheckpoint = opts.force
      || uncovered.count >= opts.messageThreshold
      || uncovered.characters >= opts.characterThreshold;

    const needsRollup = opts.force
      || needsCheckpoint
      || regenerated
      || !summary.rollup
      || summary.rollup.status === 'stale'
      || materialStructuredChange(state, summary.rollup?.structuredStateDigest);

    if (!needsCheckpoint && !needsRollup && !regenerated) return false;

    const snapshot = cloneSummarySnapshot(summary);

    if (needsCheckpoint && uncovered.count > 0) {
      const checkpoint = buildCheckpoint(
        state,
        summary.coveredThroughIndex,
        uncovered.throughIndex,
        opts
      );
      summary.checkpoints.push(checkpoint);
      summary.coveredThroughIndex = checkpoint.throughIndexInclusive;
      while (summary.checkpoints.length > opts.maxCheckpoints) {
        summary.checkpoints.shift();
      }
    }

    if (needsCheckpoint || needsRollup || regenerated) {
      const liveCheckpoints = summary.checkpoints.filter((entry) => entry.status !== 'superseded');
      const rollup = buildRollup(state, liveCheckpoints, opts);
      summary.rollup = rollup;
      summary.currentRollupRef = { id: rollup.id, revision: rollup.revision };
    }

    const integrity = verifySummaryIntegrity(state);
    if (!integrity.ok) {
      restoreSummarySnapshot(summary, snapshot);
      if (summary.rollup) {
        summary.rollup = {
          ...summary.rollup,
          status: 'stale',
          staleReason: 'generation-failed-integrity'
        };
      }
      summary.lastError = integrity.errors.join('; ');
      summary.updatedAt = now();
      return true;
    }

    summary.lastError = null;
    summary.updatedAt = now();
    summary.roomId = state.room?.id ?? summary.roomId;
    return true;
  } catch (error) {
    if (!safe) throw error;
    try {
      const summary = ensureSummaryState(state);
      summary.lastError = error instanceof Error ? error.message : String(error);
      summary.updatedAt = now();
    } catch {
      // ignore secondary failure
    }
    return false;
  }
}

/**
 * Public projection for /api/state: full rollup + compact checkpoint metadata.
 * Full checkpoint bodies and the full sourceMessageIds list stay in the store
 * for integrity checks; the API only exposes a count (payload diet).
 */
export function projectSummaryForApi(summary) {
  if (!summary) return null;
  return {
    version: summary.version,
    roomId: summary.roomId,
    coveredThroughIndex: summary.coveredThroughIndex,
    lastError: summary.lastError,
    updatedAt: summary.updatedAt,
    currentRollupRef: summary.currentRollupRef,
    rollup: summary.rollup,
    checkpointCount: (summary.checkpoints ?? []).length,
    checkpoints: (summary.checkpoints ?? []).map((checkpoint) => ({
      id: checkpoint.id,
      revision: checkpoint.revision,
      status: checkpoint.status,
      fromIndexExclusive: checkpoint.fromIndexExclusive,
      throughIndexInclusive: checkpoint.throughIndexInclusive,
      sourceMessageCount: Array.isArray(checkpoint.sourceMessageIds)
        ? checkpoint.sourceMessageIds.length
        : 0,
      sourceDigest: checkpoint.sourceDigest,
      contentHash: checkpoint.contentHash,
      producerType: checkpoint.producerType,
      producerId: checkpoint.producerId,
      generatedAt: checkpoint.generatedAt,
      staleReason: checkpoint.staleReason
      // content + sourceMessageIds omitted from list projection to keep /api/state lean
    }))
  };
}
