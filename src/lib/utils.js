import { randomUUID } from 'node:crypto';

export function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function now() {
  return new Date().toISOString();
}

export function clampText(value, max = 20_000) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

export async function readJsonBody(request, limit = 1_000_000) {
  // Require a JSON content-type so a cross-origin "simple request" (text/plain,
  // which skips the CORS preflight) cannot smuggle a body into a mutating route.
  const contentType = String(request.headers?.['content-type'] || '');
  if (!contentType.includes('application/json')) throw new Error('Content-Type must be application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function publicError(error) {
  return error instanceof Error ? error.message : String(error);
}
