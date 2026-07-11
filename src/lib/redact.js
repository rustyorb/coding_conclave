const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi
];

export function redactSecrets(value) {
  let output = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, prefix) => prefix && /[=:]/.test(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]');
  }
  return output;
}
