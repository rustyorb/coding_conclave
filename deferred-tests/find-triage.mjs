// Throwaway: locate the triage classification message and count task statuses.
import { readFileSync } from 'node:fs';

const s = JSON.parse(readFileSync(new URL('../.conclave/state.json', import.meta.url), 'utf8'));

const counts = {};
for (const t of s.tasks || []) {
  const key = `${t.status}${t.archivedAt ? ' (archived)' : ''}`;
  counts[key] = (counts[key] || 0) + 1;
}
console.log('--- task status counts (total', (s.tasks || []).length, ') ---');
console.log(JSON.stringify(counts, null, 2));

const hits = (s.messages || []).filter((m) => /FOSSIL/.test(String(m.content || '')));
console.log('--- messages mentioning FOSSIL:', hits.length, '---');
for (const m of hits) {
  console.log('\n=== id:', m.id, '| source:', m.source, '| type:', m.type, '| createdAt:', m.createdAt, '| length:', String(m.content || '').length);
  console.log(String(m.content).slice(0, 800));
}
