import { failedDependencies } from './scheduler.js';
import { clampText, id, now } from './utils.js';

// Default cadence inspired by OpenClaw heartbeats (~30m), but tuned shorter so a
// drained or post-restart board cannot sit silent for hours. Set
// idleIntervalMs <= 0 (or CONCLAVE_IDLE_INTERVAL_MS=0) to disable.
export const DEFAULT_IDLE_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_IDLE_CHECK_MS = 60 * 1000;

const RESTART_BLOCKER_RE = /Conclave restarted while this task was (?:active|queued)\./;

export function parseTimestamp(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

// Latest Board-relevant activity: task create/update, task executions, and the
// last idle-watchdog fire (so a quiet board does not re-alert every tick).
export function lastBoardActivityAt(state) {
  let latest = null;
  const consider = (value) => {
    const ms = parseTimestamp(value);
    if (ms == null) return;
    if (latest == null || ms > latest) latest = ms;
  };

  for (const task of state.tasks ?? []) {
    consider(task.createdAt);
    consider(task.updatedAt);
  }
  for (const execution of state.executions ?? []) {
    if (!execution.taskId) continue;
    consider(execution.startedAt);
    consider(execution.finishedAt);
  }
  consider(state.room?.lastIdleWatchdogAt);
  return latest;
}

export function boardIdleDurationMs(state, nowMs = Date.now()) {
  const last = lastBoardActivityAt(state);
  if (last == null) return 0;
  return Math.max(0, nowMs - last);
}

export function isBoardIdle(state, { nowMs = Date.now(), idleIntervalMs = DEFAULT_IDLE_INTERVAL_MS } = {}) {
  if (!(idleIntervalMs > 0)) return false;
  return boardIdleDurationMs(state, nowMs) >= idleIntervalMs;
}

export function isRecoverableBlocker(blocker) {
  return RESTART_BLOCKER_RE.test(String(blocker ?? ''));
}

// Eligible work for a wake: ready tasks (nudge the drainer) and restart-blocked
// tasks that still have write authority and solvable dependencies.
export function listEligibleIdleWork(state) {
  const tasks = state.tasks ?? [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ready = tasks.filter((task) => task.status === 'ready');
  const requeueable = tasks.filter((task) => {
    if (task.status !== 'blocked' || !isRecoverableBlocker(task.blocker)) return false;
    if (failedDependencies(byId, task).length) return false;
    if (task.accessMode === 'workspace-write') {
      const hasAuthority = (state.approvals ?? []).some((entry) =>
        entry.taskId === task.id && ['approved', 'auto-approved'].includes(entry.status));
      if (!hasAuthority) return false;
    }
    return true;
  });
  return { ready, requeueable };
}

export function formatIdleWatchdogNotice({ idleMs, readyCount, requeuedCount }) {
  const minutes = Math.max(1, Math.round(Math.max(0, idleMs) / 60_000));
  const parts = [`Idle watchdog: no Board task activity for ~${minutes}m.`];
  if (requeuedCount > 0) {
    parts.push(`Re-queued ${requeuedCount} recoverable blocked task${requeuedCount === 1 ? '' : 's'}.`);
  }
  if (readyCount > 0) {
    parts.push(`Nudge-draining ${readyCount} ready task${readyCount === 1 ? '' : 's'}.`);
  }
  return parts.join(' ');
}

/**
 * Pure store mutator. When the board has been idle longer than idleIntervalMs
 * and eligible work exists, re-queue recoverable blocked tasks, stamp
 * room.lastIdleWatchdogAt, and append an autopilot room notice + audit event.
 * Process start is left to the caller (startQueuedTasks).
 */
export function applyIdleWatchdog(state, {
  nowMs = Date.now(),
  nowIso = now(),
  idleIntervalMs = DEFAULT_IDLE_INTERVAL_MS
} = {}) {
  if (state.room?.paused) return { acted: false, reason: 'paused' };
  if (!isBoardIdle(state, { nowMs, idleIntervalMs })) return { acted: false, reason: 'not-idle' };

  const { ready, requeueable } = listEligibleIdleWork(state);
  if (!ready.length && !requeueable.length) return { acted: false, reason: 'no-eligible-work' };

  const requeuedIds = [];
  for (const task of requeueable) {
    Object.assign(task, { status: 'ready', blocker: null, updatedAt: nowIso });
    requeuedIds.push(task.id);
  }

  const idleMs = boardIdleDurationMs(state, nowMs);
  const notice = formatIdleWatchdogNotice({
    idleMs,
    readyCount: ready.length,
    requeuedCount: requeuedIds.length
  });

  state.room ??= {};
  state.room.lastIdleWatchdogAt = nowIso;
  state.messages.push({
    id: id('msg'),
    source: 'system',
    sourceName: 'Conclave',
    type: 'autopilot',
    content: clampText(notice),
    createdAt: nowIso
  });
  state.audit.push({
    id: id('audit'),
    type: 'idle-watchdog.fired',
    detail: notice,
    requeuedTaskIds: requeuedIds,
    readyCount: ready.length,
    createdAt: nowIso
  });
  if (state.audit.length > 2_000) state.audit.splice(0, state.audit.length - 2_000);

  return {
    acted: true,
    reason: 'fired',
    readyCount: ready.length,
    requeuedIds,
    notice,
    idleMs
  };
}
