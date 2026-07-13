const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{22,})\b/g,
  /\b(glpat-[A-Za-z0-9_-]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
  /(:\/\/[^/\s:@]+:)([^@\s/]+)(?=@)/g,
  /((?:authorization|bearer)\s*[=:]\s*(?:bearer\s+)?)[A-Za-z0-9._/+-]{16,}/gi,
  /((?:api[_-]?key|access[_-]?key|secret(?:[_-][a-z]+)*|token|password|passwd|pwd)\s*[=:]\s*)['"]?[^\s,;'"]+/gi
];

export function redactSecrets(value) {
  let output = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, prefix) => prefix && /[=:]/.test(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]');
  }
  return output;
}
