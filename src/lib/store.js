import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clampText, id, now } from './utils.js';
import { defaultPolicy } from './policy.js';
import { emptySummaryState, ensureSummaryState } from './room-summary.js';
import { emptyMemoryState, ensureMemoryState } from './memory-ledger.js';

// Timestamped event identity (docs/adr/0001 "Timestamped event identity", Stage 0):
// wall-clock timestamps and random IDs cannot totally order room history — the live
// room held same-millisecond createdAt values and array order that disagreed with
// timestamp order. Durable messages and audit (lifecycle) records therefore carry a
// shared per-room monotonic `seq` plus a server-authored UTC `recordedAt`, both
// allocated at commit time inside the serialized store queue. Legacy records are
// backfilled with `seq` in persisted array order (never re-sorted by ambiguous
// timestamps); a missing or unparsable legacy createdAt is flagged via
// `timestampStatus` and no recordedAt is invented for history. The counter only
// ever moves forward, so pruned records (the audit cap) never free their numbers.
// Within one commit, messages are numbered before audit records; cross-stream
// interleaving inside a single commit is not significant.
const EVENT_STREAMS = ['messages', 'audit'];

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function ensureEventIdentity(state, { legacy = false } = {}) {
  let next = Number.isSafeInteger(state.events?.nextSequence) && state.events.nextSequence >= 1
    ? state.events.nextSequence
    : 1;
  for (const stream of EVENT_STREAMS) {
    for (const record of Array.isArray(state[stream]) ? state[stream] : []) {
      if (Number.isSafeInteger(record.seq) && record.seq >= next) next = record.seq + 1;
    }
  }
  const recordedAt = now();
  let stamped = 0;
  for (const stream of EVENT_STREAMS) {
    for (const record of Array.isArray(state[stream]) ? state[stream] : []) {
      if (Number.isSafeInteger(record.seq)) continue;
      record.seq = next++;
      stamped += 1;
      if (legacy) {
        if (record.createdAt == null) record.timestampStatus = 'legacy-missing';
        else if (!validTimestamp(record.createdAt)) record.timestampStatus = 'legacy-invalid';
        continue;
      }
      record.recordedAt = recordedAt;
      if (record.createdAt == null) {
        record.createdAt = recordedAt;
        record.timestampStatus = 'source-missing';
      } else if (!validTimestamp(record.createdAt)) {
        record.timestampStatus = 'source-invalid';
      }
    }
  }
  state.events = { nextSequence: next };
  return stamped;
}

export function initialState(workspace) {
  const createdAt = now();
  const roomId = id('room');
  return {
    version: 2,
    room: {
      id: roomId,
      name: 'Engineering room',
      workspace,
      mode: 'general-chat',
      paused: false,
      trust: 'gated',
      coordinatorId: null,
      roles: {},
      createdAt,
      limits: { maxTurnsPerAgent: 12, maxConcurrentRuns: 3, timeoutMinutes: 20 }
    },
    agents: [],
    tasks: [],
    taskDeletions: [],
    chatTurns: [],
    events: { nextSequence: 2 },
    messages: [{
      id: id('msg'),
      seq: 1,
      source: 'system',
      sourceName: 'Conclave',
      type: 'system',
      content: 'Room created. Agent availability is determined from installed CLIs on this machine.',
      createdAt,
      recordedAt: createdAt
    }],
    approvals: [],
    policy: defaultPolicy(),
    executions: [],
    workspace: { status: [], diff: '', refreshedAt: createdAt },
    audit: [],
    summary: emptySummaryState(roomId),
    memory: emptyMemoryState(roomId)
  };
}

// Tier 1 verbatim-history query (docs/memory.md §7.2): walk messages newest-first
// under a character or token budget so prompt depth adapts to message size instead
// of a fixed count. `limit` is a sanity cap only — the budget governs. Token limits
// use a conservative fixed chars-per-token estimate; the result names the estimator
// so context receipts can identify it later. The newest message always survives.
export const HISTORY_TOKEN_ESTIMATOR = 'chars/4';
export const HISTORY_CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / HISTORY_CHARS_PER_TOKEN);
}

export function queryHistory(state, { excludeId, limit = 60, clamp = 600, budget, maxTokens } = {}) {
  const fromChars = Number.isFinite(budget) ? budget : Infinity;
  const fromTokens = Number.isFinite(maxTokens) ? maxTokens * HISTORY_CHARS_PER_TOKEN : Infinity;
  const strictest = Math.min(fromChars, fromTokens);
  const charBudget = Number.isFinite(strictest) ? strictest : 9_000;
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const entries = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0 && entries.length < limit; index -= 1) {
    const entry = messages[index];
    if (excludeId && entry.id === excludeId) continue;
    const content = clampText(entry.content, clamp);
    // Cost mirrors the prompt line `- ${sourceName}[ [type]]: ${content}` exactly.
    const label = entry.type && entry.type !== 'message' ? ` [${entry.type}]` : '';
    const cost = 4 + String(entry.sourceName ?? '').length + label.length + content.length;
    if (entries.length && used + cost > charBudget) break;
    entries.push({ ...entry, content });
    used += cost;
  }
  entries.reverse();
  const excluded = excludeId && messages.some((entry) => entry.id === excludeId) ? 1 : 0;
  return {
    entries,
    omitted: Math.max(0, messages.length - excluded - entries.length),
    usedCharacters: used,
    estimatedTokens: Math.ceil(used / HISTORY_CHARS_PER_TOKEN),
    estimator: HISTORY_TOKEN_ESTIMATOR
  };
}

export class JsonStore {
  constructor(file, workspace) {
    this.file = file;
    this.workspace = workspace;
    this.state = initialState(workspace);
    this.queue = Promise.resolve();
  }

  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const persisted = JSON.parse(await readFile(this.file, 'utf8'));
      const defaults = initialState(this.workspace);
      this.state = {
        ...defaults,
        ...persisted,
        version: defaults.version,
        room: {
          ...defaults.room,
          ...persisted.room,
          mode: 'general-chat',
          trust: persisted.room?.trust === 'unleashed' ? 'unleashed' : 'gated',
          limits: { ...defaults.room.limits, ...persisted.room?.limits }
        },
        taskDeletions: Array.isArray(persisted.taskDeletions) ? persisted.taskDeletions : [],
        policy: { ...defaults.policy, ...persisted.policy,
          autoRetry: { ...defaults.policy.autoRetry, ...(persisted.policy?.autoRetry ?? {}) } },
        chatTurns: Array.isArray(persisted.chatTurns) ? persisted.chatTurns : [],
        // Legacy states have no counter; backfill must start at 1, not inherit
        // the fresh-state default. A persisted counter is never lowered.
        events: Number.isSafeInteger(persisted.events?.nextSequence)
          ? { nextSequence: persisted.events.nextSequence }
          : { nextSequence: 1 },
        summary: persisted.summary && typeof persisted.summary === 'object'
          ? persisted.summary
          : emptySummaryState(persisted.room?.id ?? defaults.room.id)
      };
      this.state.room.workspace = this.workspace;
      ensureSummaryState(this.state);
      ensureMemoryState(this.state);
      ensureEventIdentity(this.state, { legacy: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }
    return this.state;
  }

  async save() {
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await rename(temp, this.file);
  }

  update(mutator) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const result = await mutator(this.state);
      // Commit-time stamping: any message/audit record this mutator appended
      // gets its monotonic seq and server UTC recordedAt here, so no push site
      // can forget them and allocation stays serialized with persistence.
      ensureEventIdentity(this.state);
      await this.save();
      return result;
    });
    // Keep the queue alive after a failed update, but surface the failure —
    // persistent save errors (e.g. disk full) must not vanish silently.
    this.queue = operation.catch((error) => console.error('store update failed:', error?.message || error));
    return operation;
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
