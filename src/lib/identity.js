export const IDENTITY_BLOCK = /```conclave-identity\s*\n([\s\S]*?)```/;

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;

// Cosmetic self-identity for an agent's participant card. Strictly validated
// because agents author it: color must be 6-digit hex (it lands in an inline
// style attribute), emoji is capped at 8 code points, tagline at 80 chars —
// both rendered through esc() on the client.
export function validateIdentity(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('identity must be a JSON object');
  }
  const identity = {};
  if (input.emoji !== undefined && input.emoji !== null) {
    const emoji = Array.from(String(input.emoji).trim()).slice(0, 8).join('');
    if (emoji) identity.emoji = emoji;
  }
  if (input.color !== undefined && input.color !== null) {
    const color = String(input.color).trim();
    if (!SAFE_COLOR.test(color)) throw new Error('color must be a 6-digit hex value like #8de5d6');
    identity.color = color.toLowerCase();
  }
  if (input.tagline !== undefined && input.tagline !== null) {
    const tagline = String(input.tagline).trim().slice(0, 80);
    if (tagline) identity.tagline = tagline;
  }
  if (!Object.keys(identity).length) {
    throw new Error('identity needs at least one of emoji, color, or tagline');
  }
  return identity;
}
