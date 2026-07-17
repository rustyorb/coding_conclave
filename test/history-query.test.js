import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_TOKEN_ESTIMATOR, estimateTokens, queryHistory } from '../src/lib/store.js';
import { transcriptLines } from '../src/server.js';

test('budget governs history depth, not a fixed message count', () => {
  const tiny = Array.from({ length: 100 }, (_, i) => ({
    id: `m${i}`, sourceName: 'A', type: 'message', content: `n${i}`
  }));
  const deep = queryHistory({ messages: tiny }, { limit: 100, clamp: 400, budget: 2_000 });
  assert.ok(deep.entries.length > 50, `tiny messages pack deep (got ${deep.entries.length})`);
  assert.equal(deep.omitted, 0);

  const huge = tiny.map((entry) => ({ ...entry, content: 'y'.repeat(5_000) }));
  const shallow = queryHistory({ messages: huge }, { limit: 100, clamp: 400, budget: 2_000 });
  assert.ok(shallow.entries.length < 6, `huge messages stop early (got ${shallow.entries.length})`);
  assert.ok(shallow.usedCharacters <= 2_000, 'selection stays within the budget');
  assert.equal(shallow.omitted, 100 - shallow.entries.length);
});

test('the newest message always survives even when it alone exceeds the budget', () => {
  const messages = [
    { id: 'a', sourceName: 'Old', type: 'message', content: 'old note' },
    { id: 'b', sourceName: 'New', type: 'message', content: 'z'.repeat(500) }
  ];
  const result = queryHistory({ messages }, { limit: 10, clamp: 600, budget: 50 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].id, 'b');
  assert.equal(result.omitted, 1);
});

test('entries return oldest-first; the excluded reply target is not counted as pruned', () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`, sourceName: `S${i}`, type: 'message', content: `note ${i}`
  }));
  const result = queryHistory({ messages }, { excludeId: 'm9', limit: 4, clamp: 100, budget: 9_000 });
  assert.deepEqual(result.entries.map((entry) => entry.id), ['m5', 'm6', 'm7', 'm8']);
  assert.equal(result.omitted, 5, 'm0–m4 pruned; m9 was excluded by the caller, not pruned');
});

test('per-message clamp applies without mutating the stored message', () => {
  const state = { messages: [{ id: 'a', sourceName: 'S', type: 'message', content: 'x'.repeat(2_000) }] };
  const result = queryHistory(state, { limit: 5, clamp: 100, budget: 9_000 });
  assert.match(result.entries[0].content, /…\[truncated\]$/);
  assert.ok(result.entries[0].content.length <= 115, 'content is clamped');
  assert.equal(state.messages[0].content.length, 2_000, 'the store record keeps the full text');
});

test('token limits convert through the identified estimator and bound the selection', () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({
    id: `m${i}`, sourceName: 'S', type: 'message', content: 'w'.repeat(200)
  }));
  const result = queryHistory({ messages }, { limit: 50, clamp: 600, maxTokens: 250 });
  assert.equal(result.estimator, HISTORY_TOKEN_ESTIMATOR);
  assert.ok(result.usedCharacters <= 250 * 4, `stays within the token budget (${result.usedCharacters} chars)`);
  assert.ok(result.estimatedTokens <= 250);
  assert.ok(result.entries.length >= 4, 'the token budget still admits several messages');
  assert.equal(estimateTokens('abcdefgh'), 2);
});

test('the strictest of character and token budgets wins', () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({
    id: `m${i}`, sourceName: 'S', type: 'message', content: 'w'.repeat(200)
  }));
  const tokenBound = queryHistory({ messages }, { limit: 50, clamp: 600, budget: 100_000, maxTokens: 250 });
  const charBound = queryHistory({ messages }, { limit: 50, clamp: 600, budget: 500, maxTokens: 100_000 });
  assert.ok(tokenBound.usedCharacters <= 1_000);
  assert.ok(charBound.usedCharacters <= 500);
  assert.ok(tokenBound.entries.length > charBound.entries.length);
});

test('query cost accounting exactly matches the prompt lines the server injects', () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    id: `m${i}`, sourceName: `Agent${i}`, type: i % 3 ? 'message' : 'progress', content: `note ${i} ${'x'.repeat(40)}`
  }));
  const options = { limit: 30, clamp: 600, budget: 9_000 };
  const result = queryHistory({ messages }, options);
  const lines = transcriptLines({ messages }, options);
  assert.equal(result.omitted, 0);
  assert.equal(lines.length, result.entries.length);
  assert.equal(lines.join('').length, result.usedCharacters);
});

test('transcriptLines accepts a token limit and discloses pruned history', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({
    id: `m${i}`, sourceName: 'S', type: 'message', content: 'w'.repeat(200)
  }));
  const lines = transcriptLines({ messages }, { limit: 30, clamp: 600, maxTokens: 250 });
  assert.match(lines[0], /^- \[\d+ earlier messages pruned to fit the context budget\]$/);
  assert.ok(lines.length > 1, 'history lines follow the marker');
});
