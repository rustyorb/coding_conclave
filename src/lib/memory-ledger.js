import crypto from 'node:crypto';
import path from 'node:path';
import { clampText, id, now } from './utils.js';
import { redactSecrets } from './redact.js';

// Tier 3 curated facts ledger — JSON bridge (docs/memory.md §6, §8.1).
// Pure state operations: validation happens before any mutation so a thrown
// error never leaves a partially-appended item, source edge, or revision.
// Storage lives in `state.memory` (items / itemRevisions / sources); policy
// stays here, out of the server and the store.

export const MEMORY_KINDS = [
  'decision', 'requirement', 'preference', 'constraint', 'fact',
  'hypothesis', 'question', 'evidence', 'risk', 'disagreement', 'rejected-approach'
];

export const SUPPORT_ROLES = ['required', 'supplemental'];

export const MEMORY_TITLE_MAX = 160;
export const MEMORY_STATEMENT_MAX = 2_000;
export const MEMORY_EXCERPT_MAX = 300;

export function emptyMemoryState(roomId = null) {
  return { version: 1, roomId, items: [], itemRevisions: [], sources: [] };
}

function currentWorkspaceId(state) {
  const workspace = state.room?.workspace;
  if (!workspace) return null;
  let canonical = path.resolve(String(workspace));
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function ensureMemoryState(state) {
  if (!state.memory || typeof state.memory !== 'object') {
    state.memory = emptyMemoryState(state.room?.id ?? null);
  }
  const memory = state.memory;
  memory.version = 1;
  memory.roomId = state.room?.id ?? memory.roomId ?? null;
  if (!Array.isArray(memory.items)) memory.items = [];
  if (!Array.isArray(memory.itemRevisions)) memory.itemRevisions = [];
  if (!Array.isArray(memory.sources)) memory.sources = [];
  const workspaceId = currentWorkspaceId(state);
  for (const item of memory.items) {
    if (!Object.hasOwn(item, 'workspaceId')) item.workspaceId = workspaceId;
  }
  return memory;
}

function contentHash(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

// Redact before clamping so a secret cannot be split across the truncation
// boundary past the redaction patterns (same order as process-manager).
function sanitizeText(value, max) {
  return clampText(redactSecrets(String(value ?? '')).trim(), max);
}

function sanitizeTitle(value) {
  const title = redactSecrets(String(value ?? '')).replace(/\s+/g, ' ').trim();
  return title.length > MEMORY_TITLE_MAX ? `${title.slice(0, MEMORY_TITLE_MAX - 1)}…` : title;
}

function versionConflict(item, expectedVersion) {
  const error = new Error(`Memory item version conflict: expected ${expectedVersion}, current version is ${item.version}`);
  error.code = 'memory-version-conflict';
  return error;
}

function requireItem(state, itemId) {
  const item = ensureMemoryState(state).items.find((entry) => entry.id === itemId);
  if (!item) throw new Error('Memory item not found');
  return item;
}

function checkExpectedVersion(item, expectedVersion) {
  if (!Number.isInteger(expectedVersion)) throw new Error('expectedVersion is required for memory mutations');
  if (expectedVersion !== item.version) throw versionConflict(item, expectedVersion);
}

// Deterministic support aggregation over source edges (docs/memory.md §6.3).
export function aggregateSupportState(edges) {
  if (!edges.length) return 'unavailable';
  const required = edges.filter((edge) => edge.supportRole === 'required');
  if (required.some((edge) => edge.supportState === 'hash-mismatch')) return 'compromised';
  const availableRequired = required.filter((edge) => edge.supportState === 'available');
  const allAvailable = edges.every((edge) => edge.supportState === 'available');
  if (required.length && availableRequired.length === required.length && allAvailable) return 'available';
  if (availableRequired.length) return 'partial';
  return 'unavailable';
}

function itemSources(memory, itemId) {
  return memory.sources.filter((edge) => edge.itemId === itemId);
}

// Build (but do not append) a message-provenance edge, capturing the message
// revision and content hash at curation time (docs/memory.md §6.3).
function buildMessageEdge(state, itemId, source, { defaultRole, createdAt }) {
  const messageId = String(source?.messageId ?? '');
  if (!messageId) throw new Error('Each memory source needs a messageId');
  const message = (state.messages ?? []).find((entry) => entry.id === messageId);
  if (!message) throw new Error(`Source message ${messageId} was not found in this room`);
  const supportRole = source.supportRole === undefined ? defaultRole : String(source.supportRole);
  if (!SUPPORT_ROLES.includes(supportRole)) {
    throw new Error(`supportRole must be one of: ${SUPPORT_ROLES.join(', ')}`);
  }
  return {
    id: id('memsrc'),
    itemId,
    type: 'message',
    messageId,
    messageRevision: message.revision ?? 1,
    contentHash: contentHash(message.content),
    excerpt: sanitizeText(source.excerpt ?? message.content, MEMORY_EXCERPT_MAX),
    supportRole,
    supportState: 'available',
    supportChangedAt: createdAt,
    supportChangeReason: null,
    createdAt
  };
}

function pushRevision(memory, item, actor, createdAt) {
  memory.itemRevisions.push({
    id: id('memrev'),
    itemId: item.id,
    version: item.version,
    kind: item.kind,
    title: item.title,
    statement: item.statement,
    status: item.status,
    actor,
    createdAt
  });
}

/**
 * Create a curated ledger item from one or more source messages. Governance
 * (docs/memory.md §6.2): creation always enters `proposed` and requires at
 * least one in-scope source and a redacted statement. When no supportRole is
 * given, the first edge defaults to `required` and later edges to `supplemental`.
 */
export function createMemoryItem(state, input, { actor = 'operator' } = {}) {
  const memory = ensureMemoryState(state);
  const kind = String(input?.kind ?? '');
  if (!MEMORY_KINDS.includes(kind)) throw new Error(`kind must be one of: ${MEMORY_KINDS.join(', ')}`);
  const title = sanitizeTitle(input?.title);
  if (!title) throw new Error('A memory item needs a title');
  const statement = sanitizeText(input?.statement, MEMORY_STATEMENT_MAX);
  if (!statement) throw new Error('A memory item needs a statement');
  const rawSources = Array.isArray(input?.sources) ? input.sources : [];
  if (!rawSources.length) throw new Error('A memory item needs at least one source message');
  const createdAt = now();
  const itemId = id('mem');
  const edges = rawSources.map((source, index) => buildMessageEdge(state, itemId, source, {
    defaultRole: index === 0 ? 'required' : 'supplemental', createdAt
  }));
  const seen = new Set();
  for (const edge of edges) {
    if (seen.has(edge.messageId)) throw new Error(`Message ${edge.messageId} is listed as a source twice`);
    seen.add(edge.messageId);
  }
  const item = {
    id: itemId,
    roomId: state.room?.id ?? null,
    workspaceId: currentWorkspaceId(state),
    kind,
    title,
    statement,
    status: 'proposed',
    scope: 'room',
    pinned: input?.pinned === true,
    authorType: actor === 'operator' ? 'operator' : 'agent',
    authorId: actor,
    supportState: aggregateSupportState(edges),
    version: 1,
    createdAt,
    updatedAt: createdAt
  };
  memory.items.push(item);
  memory.sources.push(...edges);
  pushRevision(memory, item, actor, createdAt);
  return { item, sources: edges };
}

/**
 * Revise an item's title and/or statement. Requires the caller's
 * expectedVersion to match (optimistic concurrency, docs/memory.md §6.2);
 * a mismatch throws with code `memory-version-conflict` before any mutation.
 */
export function reviseMemoryItem(state, itemId, input, { actor = 'operator' } = {}) {
  const memory = ensureMemoryState(state);
  const item = requireItem(state, itemId);
  checkExpectedVersion(item, input?.expectedVersion);
  const patch = {};
  if (input?.title !== undefined) {
    const title = sanitizeTitle(input.title);
    if (!title) throw new Error('A memory item needs a title');
    patch.title = title;
  }
  if (input?.statement !== undefined) {
    const statement = sanitizeText(input.statement, MEMORY_STATEMENT_MAX);
    if (!statement) throw new Error('A memory item needs a statement');
    patch.statement = statement;
  }
  if (!Object.keys(patch).length) throw new Error('Provide a title or statement to update');
  const updatedAt = now();
  Object.assign(item, patch, { version: item.version + 1, updatedAt });
  pushRevision(memory, item, actor, updatedAt);
  return item;
}

/**
 * Pin or unpin an item. Pinning raises context priority only (docs/memory.md
 * §6.6); it is a version-checked mutation but not a content revision.
 */
export function setMemoryItemPinned(state, itemId, input) {
  const item = requireItem(state, itemId);
  checkExpectedVersion(item, input?.expectedVersion);
  if (typeof input?.pinned !== 'boolean') throw new Error('pinned must be true or false');
  Object.assign(item, { pinned: input.pinned, version: item.version + 1, updatedAt: now() });
  return item;
}

/**
 * Associate another source message with an existing item. Later edges default
 * to `supplemental` (docs/memory.md §6.3); duplicates by message lineage are
 * rejected. Recalculates the item's derived supportState.
 */
export function addMemorySource(state, itemId, input) {
  const memory = ensureMemoryState(state);
  const item = requireItem(state, itemId);
  checkExpectedVersion(item, input?.expectedVersion);
  const createdAt = now();
  const edge = buildMessageEdge(state, itemId, input, { defaultRole: 'supplemental', createdAt });
  if (itemSources(memory, itemId).some((existing) => existing.messageId === edge.messageId)) {
    throw new Error(`Message ${edge.messageId} is already a source of this item`);
  }
  memory.sources.push(edge);
  Object.assign(item, {
    supportState: aggregateSupportState(itemSources(memory, itemId)),
    version: item.version + 1,
    updatedAt: createdAt
  });
  return { item, source: edge };
}

// Lean /api/state projection: items and their provenance edges, without the
// append-only revision history (that stays on disk, docs/memory.md §8.1).
export function projectMemoryForApi(memory) {
  const safe = memory && typeof memory === 'object' ? memory : emptyMemoryState();
  const items = Array.isArray(safe.items) ? safe.items : [];
  const sources = Array.isArray(safe.sources) ? safe.sources : [];
  return { version: 1, roomId: safe.roomId ?? null, itemsTotal: items.length, items, sources };
}
