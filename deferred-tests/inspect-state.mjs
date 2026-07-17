// Throwaway inspection helper: summarize agent status + recent gemini/grok runs
import { readFileSync } from 'node:fs';

const s = JSON.parse(readFileSync(new URL('../.conclave/state.json', import.meta.url), 'utf8'));
for (const a of s.agents || []) {
  console.log(a.id, '| status:', a.status, '| conn:', a.connection, '| activity:', a.activity, '| version:', JSON.stringify(a.version), '| lastAction:', JSON.stringify(a.lastAction));
}
const ex = s.executions || [];
console.log('--- executions total:', ex.length);
for (const id of ['gemini', 'grok']) {
  const runs = ex.filter((e) => e.agentId === id).slice(-4);
  for (const e of runs) {
    console.log('\n===', id, '|', e.id, '|', e.status, '| exit:', e.exitCode, '| started:', e.startedAt);
    console.log('command:', JSON.stringify(e.command).slice(0, 300));
    console.log('output tail:', JSON.stringify(String(e.output || '').slice(-500)));
  }
}
