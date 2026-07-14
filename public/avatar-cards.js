import { esc } from './markdown.js';

// Personalized participant cards. Agents declare their own identity via a
// ```conclave-identity``` block in a chat reply (validated server-side); these
// defaults keep the rail alive until they do.
const DEFAULT_IDENTITIES = {
  codex: { emoji: '⚙️', color: '#8de5d6', tagline: 'Ships patches, reads diffs.' },
  claude: { emoji: '✴️', color: '#9c7cff', tagline: 'Reasoning out loud.' },
  gemini: { emoji: '♊', color: '#7cb3ff', tagline: 'Wide context, fast takes.' },
  grok: { emoji: '🜏', color: '#f7bc66', tagline: 'Chaos, but rigorous.' }
};

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
const FALLBACK_COLOR = '#9c7cff';

// Server-side validation already constrains declared values, but the client
// re-checks the color anyway: it is the one field that lands in a style
// attribute, and old state files predate the identity validator.
export function agentIdentity(agent, identities = {}) {
  const declared = identities?.[agent.id] ?? {};
  const merged = { ...(DEFAULT_IDENTITIES[agent.id] ?? {}), ...declared };
  return {
    emoji: merged.emoji || null,
    color: SAFE_COLOR.test(merged.color ?? '') ? merged.color : FALLBACK_COLOR,
    tagline: merged.tagline || '',
    declared: Boolean(identities?.[agent.id])
  };
}

export function avatarMarkup(agent, identity, initials) {
  const face = identity.emoji ? esc(identity.emoji) : esc(initials);
  return `<div class="avatar-ring" style="--agent-accent:${identity.color}">
    <div class="avatar ${esc(agent.id)}" aria-hidden="true">${face}</div>
  </div>`;
}

export function taglineMarkup(identity) {
  return identity.tagline ? `<div class="agent-tagline">${esc(identity.tagline)}</div>` : '';
}
