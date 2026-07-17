// Throwaway: execute the fossil quarantine via the live server API only.
// Order: deny fossil approval -> reject remaining fossils -> archive all -> requeue live 3.
const API = 'http://127.0.0.1:4317';

const REQUEUE_PREFIXES = ['152dc007', '157af431', '78a5b232'];
const FOSSIL_PREFIXES = ['bd4f16c2','2577e86a','10d60710','698a1105','65b9f844','8036a720','a7303d14',
  'cbe750f0','39133cfe','2cd17a89','5307c70b','31b33b46','3d2a12d9','2821fcd0','200f63c2',
  'd76d597a','514bbbf7','9f352028','39fb43c5','8c63293c','b7a3ff27','1eaa4906','312524fa',
  '0af966c0','259efe6f','2fe8ad12','82ee2241','267ce2aa','291e5c38','5d9736be','d9aaf863',
  'bb46c1fe','e00e1794','3ac892b9','1e19d07e','1c7ed1c0','e989e831','f8dc8d1c','1bcc4d7d',
  '70dd7cfd','b085ac87','327efc04','4f4dfe49','cd2ce717','7d369215','450a9fc3','0ac37ea8',
  'a832675a','ac5ab0fd','cb3e46fa','7fe84dfd','5c9f01aa','3819254a','90317494','2710cf50',
  'b4118e81','631426e1','2bf9e33b','d8e29df3','29168a12','76aa2f44','d6c00c1e','002866d7',
  'e369e0b5','a3207788','7caff364','a1772892','51064fd6','41455f36','21499fc8','a694fd44',
  '7ea2e1e5','b589bf4a'];
const DENY_APPROVAL = 'approval_740e231a-f0ad-4745-8de0-29b16c5d0cd8'; // pending write approval for fossil bd4f16c2

const statusCounts = (tasks) => {
  const counts = {};
  for (const t of tasks) {
    const key = `${t.status}${t.archivedAt ? ' (archived)' : ''}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
};

const getState = () => fetch(`${API}/api/state`).then((r) => {
  if (!r.ok) throw new Error(`GET /api/state -> ${r.status}`);
  return r.json();
});

const post = async (path, body) => {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text.slice(0, 200) };
};

const before = await getState();
console.log('== BEFORE ==', JSON.stringify(statusCounts(before.tasks)));

const resolveId = (prefix) => {
  const hits = before.tasks.filter((t) => t.id.startsWith(`task_${prefix}`));
  if (hits.length !== 1) throw new Error(`prefix ${prefix}: ${hits.length} matches`);
  return hits[0];
};
const fossils = FOSSIL_PREFIXES.map(resolveId);
const requeues = REQUEUE_PREFIXES.map(resolveId);
const denyTaskId = 'task_bd4f16c2-7ad9-46e5-a59c-8571edbd339a';

const failures = [];

// 1. Deny the pending approval: marks it denied AND sets its fossil task rejected.
{
  const res = await post(`/api/approvals/${DENY_APPROVAL}`, { decision: 'denied' });
  console.log(`deny ${DENY_APPROVAL.slice(0, 22)} -> ${res.status} ${res.ok ? '' : res.body}`);
  if (!res.ok) failures.push({ step: 'deny', id: DENY_APPROVAL, res });
}

// 2. Reject every other fossil (review verdict: not accepted -> status rejected, terminal).
for (const t of fossils) {
  if (t.id === denyTaskId) continue; // already rejected via the denied approval
  const res = await post(`/api/tasks/${t.id}/review`, { accepted: false });
  console.log(`reject ${t.id.slice(0, 13)} (${t.status}) -> ${res.status} ${res.ok ? '' : res.body}`);
  if (!res.ok) failures.push({ step: 'reject', id: t.id, res });
}

// 3. Archive all fossils (rejected is an archivable terminal status).
for (const t of fossils) {
  const res = await post(`/api/tasks/${t.id}/archive`);
  console.log(`archive ${t.id.slice(0, 13)} -> ${res.status} ${res.ok ? '' : res.body}`);
  if (!res.ok) failures.push({ step: 'archive', id: t.id, res });
}

// 4. Requeue the live three (order: 152dc007, 157af431, then its dependent 78a5b232).
for (const t of requeues) {
  const res = await post(`/api/tasks/${t.id}/requeue`);
  console.log(`requeue ${t.id.slice(0, 13)} -> ${res.status} ${res.ok ? '' : res.body}`);
  if (!res.ok) failures.push({ step: 'requeue', id: t.id, res });
}

// 5. Verify.
const after = await getState();
console.log('\n== AFTER ==', JSON.stringify(statusCounts(after.tasks)));

const afterById = new Map(after.tasks.map((t) => [t.id, t]));
let parked = 0;
const exposed = [];
const RESTART_RE = /Conclave restarted while this task was (?:active|queued)\./;
for (const t of fossils) {
  const live = afterById.get(t.id);
  if (live && live.status === 'rejected' && live.archivedAt) { parked += 1; continue; }
  exposed.push(`${t.id} status=${live?.status} archivedAt=${live?.archivedAt ?? 'null'}`);
}
console.log(`fossils parked (rejected + archived): ${parked}/73`);
for (const line of exposed) console.log('STILL EXPOSED:', line);

for (const t of requeues) {
  const live = afterById.get(t.id);
  console.log(`requeued ${t.id.slice(0, 13)}: status=${live?.status} blocker=${JSON.stringify(live?.blocker ?? null)}`);
}

// Watchdog-exposure simulation on the after state: a task is dispatchable by the
// idle watchdog/drainer if ready, or blocked with the restart blocker (deps OK +
// write authority). No fossil may qualify.
const wouldWake = after.tasks.filter((t) => {
  if (t.archivedAt) return false;
  if (t.status === 'ready') return true;
  if (t.status !== 'blocked' || !RESTART_RE.test(String(t.blocker ?? ''))) return false;
  return true;
});
const fossilIdSet = new Set(fossils.map((t) => t.id));
const wakeableFossils = wouldWake.filter((t) => fossilIdSet.has(t.id));
console.log(`watchdog-wakeable tasks after quarantine: ${wouldWake.length} (fossils among them: ${wakeableFossils.length})`);
for (const t of wakeableFossils) console.log('WAKEABLE FOSSIL:', t.id, t.status, t.blocker);

console.log(`\nfailures: ${failures.length}`);
for (const f of failures) console.log(JSON.stringify(f));
