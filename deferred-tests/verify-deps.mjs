// Throwaway: verify dependsOn fidelity (raw state vs API projection) and
// re-run the fossil-dependency safety walk against the raw file (read-only).
import { readFileSync } from 'node:fs';

const s = JSON.parse(readFileSync(new URL('../.conclave/state.json', import.meta.url), 'utf8'));
const api = await fetch('http://127.0.0.1:4317/api/state').then((r) => r.json());

console.log('raw tasks with dependsOn:', s.tasks.filter((t) => (t.dependsOn || []).length).length);
console.log('api tasks with dependsOn:', api.tasks.filter((t) => (t.dependsOn || []).length).length);

const FOSSIL = ['bd4f16c2','2577e86a','10d60710','698a1105','65b9f844','8036a720','a7303d14',
  'cbe750f0','39133cfe','2cd17a89','5307c70b','31b33b46','3d2a12d9','2821fcd0','200f63c2',
  'd76d597a','514bbbf7','9f352028','39fb43c5','8c63293c','b7a3ff27','1eaa4906','312524fa',
  '0af966c0','259efe6f','2fe8ad12','82ee2241','267ce2aa','291e5c38','5d9736be','d9aaf863',
  'bb46c1fe','e00e1794','3ac892b9','1e19d07e','1c7ed1c0','e989e831','f8dc8d1c','1bcc4d7d',
  '70dd7cfd','b085ac87','327efc04','4f4dfe49','cd2ce717','7d369215','450a9fc3','0ac37ea8',
  'a832675a','ac5ab0fd','cb3e46fa','7fe84dfd','5c9f01aa','3819254a','90317494','2710cf50',
  'b4118e81','631426e1','2bf9e33b','d8e29df3','29168a12','76aa2f44','d6c00c1e','002866d7',
  'e369e0b5','a3207788','7caff364','a1772892','51064fd6','41455f36','21499fc8','a694fd44',
  '7ea2e1e5','b589bf4a'];

const fossilIds = new Set();
for (const p of FOSSIL) {
  const hits = s.tasks.filter((t) => t.id.startsWith(`task_${p}`));
  if (hits.length !== 1) console.log('BAD prefix', p, hits.length);
  else fossilIds.add(hits[0].id);
}
console.log('fossils resolved from raw:', fossilIds.size);

const liveDeps = s.tasks.filter((t) => !fossilIds.has(t.id)
  && !['completed', 'rejected', 'cancelled', 'failed'].includes(t.status)
  && (t.dependsOn || []).some((d) => fossilIds.has(d)));
console.log('live non-fossil tasks depending on a fossil (raw):', liveDeps.length);
for (const t of liveDeps) console.log(' ', t.id, t.status, JSON.stringify(t.dependsOn), t.title);

// Which fossils depend on other fossils (affects rejection ordering noise only)
const fossilOnFossil = s.tasks.filter((t) => fossilIds.has(t.id)
  && (t.dependsOn || []).some((d) => fossilIds.has(d)));
console.log('fossil-on-fossil dependents:', fossilOnFossil.length);
for (const t of fossilOnFossil) console.log(' ', t.id, t.status, JSON.stringify(t.dependsOn));

// REQUEUE set deps in raw state
for (const p of ['152dc007', '157af431', '78a5b232']) {
  const t = s.tasks.find((x) => x.id.startsWith(`task_${p}`));
  console.log(`REQUEUE ${p}: status=${t.status} deps=${JSON.stringify(t.dependsOn || [])} blocker=${JSON.stringify(t.blocker)}`);
}
