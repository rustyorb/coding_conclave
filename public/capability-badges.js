import { esc } from './markdown.js';

// Capability badges (docs/capability-broker-design.md §6.6 hook E): render each
// agent's capabilityProfile confidence truthfully. The hard rule (§5.2 / PRD
// §4.5): verified styling comes only from a probe-upgraded `verified` entry —
// the UI never upgrades `declared`, and a verified result past its TTL is shown
// stale rather than silently kept green.

const CONFIDENCE_LEVELS = new Set(['declared', 'probed', 'verified', 'stale', 'failed', 'unsupported']);
const DEFAULT_TTL_HOURS = 72;

function probeTimestamp(profile, entry) {
  return profile.probes?.[entry.probeId]?.at || profile.probedAt || null;
}

function resolveConfidence(profile, entry, now) {
  const confidence = CONFIDENCE_LEVELS.has(entry?.confidence) ? entry.confidence : 'declared';
  if (confidence !== 'verified') return confidence;
  const at = probeTimestamp(profile, entry);
  const ttlHours = Number.isFinite(profile.ttlHours) ? profile.ttlHours : DEFAULT_TTL_HOURS;
  const age = now - Date.parse(at ?? '');
  // No parsable probe timestamp also lands here: freshness that cannot be
  // proven is stale, never silent green.
  if (!Number.isFinite(age) || age > ttlHours * 3_600_000) return 'stale';
  return 'verified';
}

/**
 * Flatten one agent's capabilityProfile into displayable entries:
 * { key, label, confidence, title }. Falls back to the legacy string labels
 * (clearly marked declared-only) when the server predates structured profiles.
 */
export function capabilityEntries(agent, { now = Date.now() } = {}) {
  const profile = agent?.capabilityProfile;
  const capabilities = profile?.capabilities ?? {};
  if (Object.keys(capabilities).length) {
    return Object.entries(capabilities).map(([key, entry]) => {
      const confidence = resolveConfidence(profile, entry, now);
      const at = probeTimestamp(profile, entry);
      const parts = [`${key} · ${confidence}`];
      if (entry.reason) parts.push(entry.reason);
      if (confidence === 'stale') parts.push(`verified result past its ${Number.isFinite(profile.ttlHours) ? profile.ttlHours : DEFAULT_TTL_HOURS}h TTL`);
      if (entry.probeId) parts.push(`probe ${entry.probeId}${at ? ` @ ${at}` : ''}`);
      else parts.push('declared by the adapter — not yet probed');
      return { key, label: entry.label || key, confidence, title: parts.join(' · ') };
    });
  }
  return (agent?.capabilities ?? []).map((label) => ({
    key: label,
    label,
    confidence: 'declared',
    title: `${label} · declared — legacy label, no verification data`
  }));
}

/** Badge row markup for an agent card; empty string when nothing to show. */
export function capabilityBadges(agent, options) {
  const entries = capabilityEntries(agent, options);
  if (!entries.length) return '';
  return `<div class="agent-capabilities">${entries.map((entry) =>
    `<span class="cap-badge ${entry.confidence}" title="${esc(entry.title)}">${esc(entry.label)}</span>`
  ).join('')}</div>`;
}
