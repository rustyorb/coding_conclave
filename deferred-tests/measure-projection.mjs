// Throwaway measurement: /api/state execution-record sizes, raw vs projected.
// Usage: node deferred-tests/measure-projection.mjs
import { readFileSync } from 'node:fs';

const state = JSON.parse(readFileSync(new URL('../.conclave/state.json', import.meta.url), 'utf8'));

// Mirror of src/server.js projectStateForApi (kept in sync by hand for measurement only).
const previewCommand = (value, max = 200) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}… [${text.length} chars total]` : text;
};
const LIMIT = 200;
const TAIL = 500;
const project = (s, { previewPurpose }) => {
  const executions = s.executions.slice(0, LIMIT).map((execution) => {
    const { output, ...rest } = execution;
    const text = output || '';
    const row = { ...rest, command: previewCommand(rest.command), outputSize: text.length, outputTail: text.slice(-TAIL) };
    if (previewPurpose) row.purpose = previewCommand(row.purpose);
    return row;
  });
  return { ...s, executions, executionsTotal: s.executions.length };
};

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const raw = bytes(state);
const current = project(state, { previewPurpose: false });
const patched = project(state, { previewPurpose: true });

console.log('executions in store:', state.executions.length, '| projected:', current.executions.length);
console.log('raw state (no projection at all):     ', bytes(state), `(${kb(raw)})`);
console.log('projected, current code:              ', bytes(current), `(${kb(bytes(current))})`);
console.log('projected + purpose preview:          ', bytes(patched), `(${kb(bytes(patched))})`);
console.log('executions slice, current:            ', bytes(current.executions), `(${kb(bytes(current.executions))})`);
console.log('executions slice, + purpose preview:  ', bytes(patched.executions), `(${kb(bytes(patched.executions))})`);

const top = state.executions.slice(0, LIMIT);
const sum = (fn) => top.reduce((a, e) => a + fn(e), 0);
console.log('--- top-200 per-field chars (pre-projection) ---');
console.log('command:', sum((e) => (e.command || '').length),
  '| purpose:', sum((e) => (e.purpose || '').length),
  '| output:', sum((e) => (e.output || '').length),
  '| cwd:', sum((e) => (e.cwd || '').length));
console.log('purpose > 200 chars:', top.filter((e) => (e.purpose || '').length > 200).length, 'records; max',
  Math.max(0, ...top.map((e) => (e.purpose || '').length)));
