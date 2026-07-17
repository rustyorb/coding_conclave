import test from 'node:test';
import assert from 'node:assert/strict';

import { capabilityEntries, capabilityBadges } from '../public/capability-badges.js';

const PROBED_AT = '2026-07-16T00:00:00.000Z';
const FRESH_NOW = Date.parse('2026-07-16T01:00:00.000Z');
const EXPIRED_NOW = Date.parse('2026-07-20T00:00:00.000Z');

function agentWithProfile(overrides = {}) {
  return {
    id: 'codex',
    capabilities: ['file editing'],
    capabilityProfile: {
      adapterVersion: 1,
      cliVersion: 'codex 1.2.3',
      probedAt: PROBED_AT,
      ttlHours: 72,
      capabilities: {
        'conversation.stream': { confidence: 'verified', probeId: 'P-stream' },
        'filesystem.write': { confidence: 'declared', label: 'file editing' },
        'structured.output': { confidence: 'failed', probeId: 'P-stream', code: 'PROBE_STRUCTURED_PARSE' },
        'mcp.inventory': { confidence: 'unsupported', reason: 'agy has no mcp subcommand' }
      },
      probes: { 'P-stream': { pass: true, at: PROBED_AT } },
      ...overrides
    }
  };
}

test('profile entries render their own confidence; declared is never shown verified', () => {
  const entries = capabilityEntries(agentWithProfile(), { now: FRESH_NOW });
  const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry]));

  assert.equal(byKey['conversation.stream'].confidence, 'verified');
  assert.equal(byKey['filesystem.write'].confidence, 'declared');
  assert.equal(byKey['structured.output'].confidence, 'failed');
  assert.equal(byKey['mcp.inventory'].confidence, 'unsupported');

  // Declared entries carry the honest "not yet probed" note and the label alias.
  assert.equal(byKey['filesystem.write'].label, 'file editing');
  assert.match(byKey['filesystem.write'].title, /not yet probed/);
  assert.match(byKey['mcp.inventory'].title, /agy has no mcp subcommand/);

  const html = capabilityBadges(agentWithProfile(), { now: FRESH_NOW });
  assert.match(html, /class="cap-badge verified"[^>]*>conversation\.stream</);
  assert.match(html, /class="cap-badge declared"[^>]*>file editing</);
  assert.doesNotMatch(html, /class="cap-badge verified"[^>]*>file editing</);
});

test('verified results past their TTL downgrade to stale, never silent green', () => {
  const entries = capabilityEntries(agentWithProfile(), { now: EXPIRED_NOW });
  const stream = entries.find((entry) => entry.key === 'conversation.stream');
  assert.equal(stream.confidence, 'stale');
  assert.match(stream.title, /past its 72h TTL/);
  // Non-verified entries are unaffected by the TTL.
  assert.equal(entries.find((entry) => entry.key === 'filesystem.write').confidence, 'declared');
});

test('verified without a provable probe timestamp is stale', () => {
  const agent = agentWithProfile({ probedAt: null, probes: {} });
  const stream = capabilityEntries(agent, { now: FRESH_NOW })
    .find((entry) => entry.key === 'conversation.stream');
  assert.equal(stream.confidence, 'stale');
});

test('unknown confidence values style as declared instead of injecting classes', () => {
  const agent = agentWithProfile({
    capabilities: { 'conversation.stream': { confidence: '"><script>alert(1)</script>' } }
  });
  const [entry] = capabilityEntries(agent, { now: FRESH_NOW });
  assert.equal(entry.confidence, 'declared');
  assert.doesNotMatch(capabilityBadges(agent, { now: FRESH_NOW }), /<script>/);
});

test('legacy string capabilities fall back as clearly-declared labels', () => {
  const agent = { id: 'codex', capabilities: ['file editing', 'testing'] };
  const entries = capabilityEntries(agent);
  assert.deepEqual(entries.map((entry) => entry.confidence), ['declared', 'declared']);
  assert.match(entries[0].title, /legacy label, no verification data/);
  assert.match(capabilityBadges(agent), /class="cap-badge declared"[^>]*>file editing</);
});

test('hostile labels and reasons are escaped in the markup', () => {
  const agent = agentWithProfile({
    capabilities: {
      'filesystem.write': {
        confidence: 'declared',
        label: '<img src=x onerror=alert(1)>',
        reason: '" onmouseover="alert(1)'
      }
    }
  });
  const html = capabilityBadges(agent, { now: FRESH_NOW });
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /" onmouseover="/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('agents with no profile and no legacy labels render nothing', () => {
  assert.equal(capabilityBadges({ id: 'codex' }), '');
  assert.equal(capabilityBadges({ id: 'codex', capabilities: [] }), '');
});
