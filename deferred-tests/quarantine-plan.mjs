// Throwaway: dry-run planner for the fossil quarantine. Reads the LIVE API only.
const API = 'http://127.0.0.1:4317';

const REQUEUE = ['152dc007', '157af431', '78a5b232'];
const FOSSIL = [
  // waiting (7)
  'bd4f16c2', '2577e86a', '10d60710', '698a1105', '65b9f844', '8036a720', 'a7303d14',
  // chat-promoted july 12-13 (4)
  'cbe750f0', '39133cfe', '2cd17a89', '5307c70b',
  // dead july-14 wave (5)
  '31b33b46', '3d2a12d9', '2821fcd0', '200f63c2', 'd76d597a',
  // resolved question (1)
  '514bbbf7',
  // guest gateway (5)
  '9f352028', '39fb43c5', '8c63293c', 'b7a3ff27', '1eaa4906',
  // attachments (4)
  '312524fa', '0af966c0', '259efe6f', '2fe8ad12',
  // autonomy/broker (12)
  '82ee2241', '267ce2aa', '291e5c38', '5d9736be', 'd9aaf863', 'bb46c1fe',
  'e00e1794', '3ac892b9', '1e19d07e', '1c7ed1c0', 'e989e831', 'f8dc8d1c',
  // misc july-14 (2)
  '1bcc4d7d', '70dd7cfd',
  // memory waves (11)
  'b085ac87', '327efc04', '4f4dfe49', 'cd2ce717', '7d369215', '450a9fc3',
  '0ac37ea8', 'a832675a', 'ac5ab0fd', 'cb3e46fa', '7fe84dfd',
  // heartbeat wave (5)
  '5c9f01aa', '3819254a', '90317494', '2710cf50', 'b4118e81',
  // drain/restart orchestration (10)
  '631426e1', '2bf9e33b', 'd8e29df3', '29168a12', '76aa2f44', 'd6c00c1e',
  '002866d7', 'e369e0b5', 'a3207788', '7caff364',
  // avatar thread (4)
  'a1772892', '51064fd6', '41455f36', '21499fc8',
  // verification elsewhere (3)
  'a694fd44', '7ea2e1e5', 'b589bf4a'
];

const res = await fetch(`${API}/api/state`);
if (!res.ok) throw new Error(`GET /api/state -> ${res.status}`);
const s = await res.json();

const counts = {};
for (const t of s.tasks) {
  const key = `${t.status}${t.archivedAt ? ' (archived)' : ''}`;
  counts[key] = (counts[key] || 0) + 1;
}
console.log('== BEFORE status counts (live API, total', s.tasks.length, ') ==');
console.log(JSON.stringify(counts));
console.log('room: trust =', s.room?.trust, '| paused =', s.room?.paused,
  '| policy.enabled =', s.policy?.enabled, '| autoApproveWrites =', s.policy?.autoApproveWrites);

const matchPrefix = (prefix) => s.tasks.filter((t) => t.id.startsWith(`task_${prefix}`));
const resolve = (list, label) => {
  const out = [];
  for (const p of list) {
    const hits = matchPrefix(p);
    if (hits.length !== 1) {
      console.log(`!! ${label} prefix ${p}: ${hits.length} matches`);
      continue;
    }
    out.push(hits[0]);
  }
  return out;
};

const requeueTasks = resolve(REQUEUE, 'REQUEUE');
const fossilTasks = resolve(FOSSIL, 'FOSSIL');

console.log('\n== REQUEUE (', requeueTasks.length, ') ==');
for (const t of requeueTasks) {
  console.log(`${t.id} | ${t.status} | ${t.accessMode} | agent=${t.agentId} | deps=${JSON.stringify(t.dependsOn ?? [])} | ${t.title}`);
}

console.log('\n== FOSSIL (', fossilTasks.length, ') by status ==');
const byStatus = {};
for (const t of fossilTasks) (byStatus[t.status] ??= []).push(t);
for (const [st, list] of Object.entries(byStatus)) console.log(st, ':', list.length);

const stranded = s.tasks.filter((t) => ['blocked', 'waiting'].includes(t.status));
const classified = new Set([...requeueTasks, ...fossilTasks].map((t) => t.id));
const unclassified = stranded.filter((t) => !classified.has(t.id));
console.log('\n== stranded (blocked+waiting):', stranded.length, '| classified:', classified.size, '| stranded-but-unclassified:', unclassified.length, '==');
for (const t of unclassified) console.log(`UNCLASSIFIED: ${t.id} | ${t.status} | created ${t.createdAt} | ${t.title}`);

const fossilIds = new Set(fossilTasks.map((t) => t.id));
const pending = (s.approvals ?? []).filter((a) => a.status === 'pending' && a.taskId);
console.log('\n== pending approvals tied to tasks:', pending.length, '==');
for (const a of pending) {
  const tag = fossilIds.has(a.taskId) ? 'FOSSIL' : (classified.has(a.taskId) ? 'REQUEUE' : 'other');
  console.log(`${a.id} | task ${a.taskId} | ${tag} | ${a.title}`);
}

// Non-fossil live tasks depending on a fossil (triage said none — re-verify)
const liveDeps = s.tasks.filter((t) => !fossilIds.has(t.id)
  && !['completed', 'rejected', 'cancelled', 'failed'].includes(t.status)
  && (t.dependsOn ?? []).some((d) => fossilIds.has(d)));
console.log('\n== live non-fossil tasks depending on a fossil:', liveDeps.length, '==');
for (const t of liveDeps) console.log(`${t.id} | ${t.status} | deps=${JSON.stringify(t.dependsOn)} | ${t.title}`);
