export const BAD_DEP_STATUSES = ['failed', 'rejected', 'cancelled'];

// Iterative DFS with a visited set: true if candidateId is reachable from depIds.
// Terminates even on a hand-corrupted cyclic graph.
export function reachesTask(tasks, depIds, candidateId) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const stack = [...depIds];
  const visited = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (current === candidateId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(byId.get(current)?.dependencies ?? []));
  }
  return false;
}

// Validates createTask's dependencies input. Returns a deduped string array.
// The API mints fresh task ids, so self-reference and cycles are unreachable
// through it — both checks are defense in depth for a hand-edited state.json.
export function validateDependencies(tasks, input, selfId) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((entry) => typeof entry !== 'string')) throw new Error('dependencies must be an array of task ids');
  const dependencies = [...new Set(input)];
  if (dependencies.length > 20) throw new Error('dependencies supports at most 20 entries');
  const known = new Set(tasks.map((task) => task.id));
  for (const depId of dependencies) {
    if (depId === selfId) throw new Error('A task cannot depend on itself');
    if (!known.has(depId)) throw new Error(`Unknown dependency task ${depId}`);
  }
  if (selfId != null && reachesTask(tasks, dependencies, selfId)) throw new Error('Dependencies would create a cycle');
  return dependencies;
}

// Dependencies of `task` not yet 'completed'. A missing id counts as unmet.
export function unmetDependencies(byId, task) {
  return (task.dependencies ?? []).filter((depId) => byId.get(depId)?.status !== 'completed');
}

// Dependencies that can never complete: bad status, or the id no longer exists.
export function failedDependencies(byId, task) {
  const fragments = [];
  for (const depId of task.dependencies ?? []) {
    const dep = byId.get(depId);
    if (!dep) fragments.push(`Dependency ${depId} no longer exists.`);
    else if (BAD_DEP_STATUSES.includes(dep.status)) fragments.push(`Dependency “${dep.title}” ${dep.status}.`);
  }
  return fragments;
}

// The scheduling decision. Pure; the caller applies mutations inside store.update.
// Scans queued AND waiting tasks for terminally-bad dependencies (block list), then
// walks queued tasks FIFO by createdAt (tie-break id): merely-unmet deps and
// not-installed agents are skipped (stay queued), everything else starts while free
// slots remain. Iteration continues past free===0 so dep-failure blocking still
// applies to every queued/waiting task.
export function selectStartable(state, load) {
  if (state.room.paused) return { start: [], block: [] };
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const start = [];
  const block = [];
  let free = state.room.limits.maxConcurrentRuns - load;
  const candidates = state.tasks.filter((task) => ['queued', 'waiting'].includes(task.status))
    .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
  for (const task of candidates) {
    const failed = failedDependencies(byId, task);
    if (failed.length) { block.push({ id: task.id, blocker: failed.join(' ') }); continue; }
    if (task.status !== 'queued') continue;
    if (unmetDependencies(byId, task).length) continue;
    const agent = state.agents.find((entry) => entry.id === task.agentId);
    if (!agent || agent.status !== 'installed') continue;
    if (free > 0) { start.push(task.id); free -= 1; }
  }
  return { start, block };
}
