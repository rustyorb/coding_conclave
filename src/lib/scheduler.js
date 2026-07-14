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

// The dependency-failure decision for the current server's vocabulary, where
// 'ready' is the queued-eligible state and 'waiting' means gated on approval.
// Pure; the caller applies mutations inside store.update. Returns the tasks
// whose dependencies can never complete, with the blocker text to apply.
// Start selection stays in the server's FIFO drainer (startQueuedTasks), which
// also owns the one-run-per-agent and writer-lock rules.
export function selectDependencyBlocked(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks
    .filter((task) => ['ready', 'waiting'].includes(task.status))
    .map((task) => ({ id: task.id, blocker: failedDependencies(byId, task).join(' ') }))
    .filter((entry) => entry.blocker);
}
