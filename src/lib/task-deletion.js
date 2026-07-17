function taskDeletionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function expirePendingApprovals(state, taskId, deletedAt, reason) {
  for (const approval of state.approvals ?? []) {
    if (approval.taskId !== taskId || approval.status !== 'pending') continue;
    Object.assign(approval, {
      status: 'expired',
      decidedAt: deletedAt,
      decidedBy: 'system',
      reason
    });
  }
}

// Permanently removes one Board row while retaining a compact, append-only
// tombstone outside the capped lifecycle audit window. Call only from inside a
// serialized store.update mutator so deletion cannot race a task reservation.
export function deleteBoardTask(state, taskId, { confirmTaskId, deletionId, deletedAt } = {}) {
  if (confirmTaskId !== taskId) {
    throw taskDeletionError('task-delete-confirmation-required', 'Confirm deletion with the exact task id');
  }
  const taskIndex = state.tasks.findIndex((entry) => entry.id === taskId);
  if (taskIndex === -1) throw taskDeletionError('task-not-found', 'Task not found');
  const task = state.tasks[taskIndex];
  const executionRunning = (state.executions ?? []).some((entry) => entry.taskId === taskId && entry.status === 'running');
  if (task.status === 'active' || executionRunning) {
    throw taskDeletionError('task-active', 'Cancel the active task and wait for it to stop before deleting it');
  }

  const dependentTasks = state.tasks.filter((entry) => (entry.dependencies ?? []).includes(taskId));
  const blocker = `Dependency “${task.title}” was deleted.`;
  for (const dependent of dependentTasks) {
    if (!['ready', 'waiting'].includes(dependent.status)) continue;
    Object.assign(dependent, { status: 'blocked', blocker, updatedAt: deletedAt });
    expirePendingApprovals(state, dependent.id, deletedAt, blocker);
    state.audit.push({
      id: `audit_${deletionId}_dependency_${dependent.id}`,
      type: 'task.dependency-blocked',
      taskId: dependent.id,
      detail: blocker,
      createdAt: deletedAt
    });
  }

  const approvalReason = `Task ${taskId} was deleted by the operator.`;
  expirePendingApprovals(state, taskId, deletedAt, approvalReason);
  const deletion = {
    id: deletionId,
    taskId,
    title: task.title,
    agentId: task.agentId,
    statusAtDeletion: task.status,
    accessMode: task.accessMode,
    origin: task.origin,
    dependentTaskIds: dependentTasks.map((entry) => entry.id),
    deletedBy: 'operator',
    deletedAt
  };
  if (!Array.isArray(state.taskDeletions)) state.taskDeletions = [];
  state.taskDeletions.unshift(deletion);
  state.tasks.splice(taskIndex, 1);
  state.audit.push({
    id: `audit_${deletionId}_deleted`,
    type: 'task.deleted',
    taskId,
    detail: `${task.title} (${task.status}); ${dependentTasks.length} dependent task(s) retained`,
    createdAt: deletedAt
  });
  return deletion;
}
