import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyIdleWatchdog,
  boardIdleDurationMs,
  formatIdleWatchdogNotice,
  isBoardIdle,
  isRecoverableBlocker,
  lastBoardActivityAt,
  listEligibleIdleWork
} from '../src/lib/idle-watchdog.js';
import { ConclaveApp } from '../src/server.js';

const hourAgo = (nowMs = Date.now()) => new Date(nowMs - 60 * 60 * 1000).toISOString();
const minutesAgo = (mins, nowMs = Date.now()) => new Date(nowMs - mins * 60_000).toISOString();

const baseState = (overrides = {}) => ({
  room: { paused: false, lastIdleWatchdogAt: null, ...(overrides.room ?? {}) },
  tasks: overrides.tasks ?? [],
  executions: overrides.executions ?? [],
  approvals: overrides.approvals ?? [],
  messages: overrides.messages ?? [],
  audit: overrides.audit ?? []
});

test('lastBoardActivityAt prefers the newest task or task-execution timestamp', () => {
  const state = baseState({
    tasks: [
      { id: 't1', createdAt: '2026-07-16T10:00:00.000Z', updatedAt: '2026-07-16T11:00:00.000Z' },
      { id: 't2', createdAt: '2026-07-16T09:00:00.000Z', updatedAt: '2026-07-16T10:30:00.000Z' }
    ],
    executions: [
      { id: 'e1', taskId: 't1', startedAt: '2026-07-16T11:05:00.000Z', finishedAt: '2026-07-16T11:10:00.000Z' },
      { id: 'e2', kind: 'chat', startedAt: '2026-07-16T12:00:00.000Z' } // ignored — no taskId
    ]
  });
  assert.equal(lastBoardActivityAt(state), Date.parse('2026-07-16T11:10:00.000Z'));
});

test('isBoardIdle is true only after the configured silence interval', () => {
  const nowMs = Date.parse('2026-07-16T12:00:00.000Z');
  const state = baseState({
    tasks: [{ id: 't1', createdAt: hourAgo(nowMs), updatedAt: hourAgo(nowMs), status: 'ready' }]
  });
  assert.equal(isBoardIdle(state, { nowMs, idleIntervalMs: 15 * 60_000 }), true);
  assert.equal(isBoardIdle(state, { nowMs, idleIntervalMs: 2 * 60 * 60_000 }), false);
  assert.equal(boardIdleDurationMs(state, nowMs) >= 60 * 60_000, true);
  assert.equal(isBoardIdle(state, { nowMs, idleIntervalMs: 0 }), false, 'interval <= 0 disables detection');
});

test('listEligibleIdleWork returns ready tasks and restart-blocked tasks with authority', () => {
  const state = baseState({
    tasks: [
      { id: 'ready-1', status: 'ready', accessMode: 'read-only' },
      {
        id: 'restart-ro',
        status: 'blocked',
        accessMode: 'read-only',
        blocker: 'Conclave restarted while this task was queued.'
      },
      {
        id: 'restart-write-ok',
        status: 'blocked',
        accessMode: 'workspace-write',
        blocker: 'Conclave restarted while this task was active.'
      },
      {
        id: 'restart-write-no-auth',
        status: 'blocked',
        accessMode: 'workspace-write',
        blocker: 'Conclave restarted while this task was queued.'
      },
      {
        id: 'dep-blocked',
        status: 'blocked',
        accessMode: 'read-only',
        blocker: 'Dependency “X” failed.',
        dependencies: ['missing']
      },
      {
        id: 'restart-bad-dep',
        status: 'blocked',
        accessMode: 'read-only',
        blocker: 'Conclave restarted while this task was queued.',
        dependencies: ['gone']
      }
    ],
    approvals: [
      { id: 'a1', taskId: 'restart-write-ok', status: 'auto-approved' }
    ]
  });
  const { ready, requeueable } = listEligibleIdleWork(state);
  assert.deepEqual(ready.map((task) => task.id), ['ready-1']);
  assert.deepEqual(requeueable.map((task) => task.id).sort(), ['restart-ro', 'restart-write-ok']);
  assert.equal(isRecoverableBlocker('Conclave restarted while this task was active.'), true);
  assert.equal(isRecoverableBlocker('Dependency “X” failed.'), false);
});

test('applyIdleWatchdog is a no-op when not idle, paused, or lacking eligible work', () => {
  const nowMs = Date.parse('2026-07-16T12:00:00.000Z');
  const recent = baseState({
    tasks: [{ id: 't1', status: 'ready', createdAt: minutesAgo(1, nowMs), updatedAt: minutesAgo(1, nowMs) }]
  });
  assert.equal(applyIdleWatchdog(recent, { nowMs, idleIntervalMs: 15 * 60_000 }).reason, 'not-idle');

  const paused = baseState({
    room: { paused: true },
    tasks: [{ id: 't1', status: 'ready', createdAt: hourAgo(nowMs), updatedAt: hourAgo(nowMs) }]
  });
  assert.equal(applyIdleWatchdog(paused, { nowMs, idleIntervalMs: 15 * 60_000 }).reason, 'paused');

  const empty = baseState({
    tasks: [{ id: 't1', status: 'completed', createdAt: hourAgo(nowMs), updatedAt: hourAgo(nowMs) }]
  });
  assert.equal(applyIdleWatchdog(empty, { nowMs, idleIntervalMs: 15 * 60_000 }).reason, 'no-eligible-work');
  assert.equal(empty.messages.length, 0);
});

test('applyIdleWatchdog re-queues recoverable work and emits an autopilot notice + audit', () => {
  const nowMs = Date.parse('2026-07-16T12:00:00.000Z');
  const nowIso = new Date(nowMs).toISOString();
  const state = baseState({
    tasks: [
      {
        id: 'ready-1',
        status: 'ready',
        accessMode: 'read-only',
        createdAt: hourAgo(nowMs),
        updatedAt: hourAgo(nowMs)
      },
      {
        id: 'restart-1',
        status: 'blocked',
        accessMode: 'read-only',
        blocker: 'Conclave restarted while this task was queued.',
        createdAt: hourAgo(nowMs),
        updatedAt: hourAgo(nowMs)
      },
      {
        id: 'dep-1',
        status: 'blocked',
        accessMode: 'read-only',
        blocker: 'Dependency “upstream” failed.',
        dependencies: ['missing'],
        createdAt: hourAgo(nowMs),
        updatedAt: hourAgo(nowMs)
      }
    ]
  });

  const result = applyIdleWatchdog(state, { nowMs, nowIso, idleIntervalMs: 15 * 60_000 });
  assert.equal(result.acted, true);
  assert.equal(result.reason, 'fired');
  assert.deepEqual(result.requeuedIds, ['restart-1']);
  assert.equal(result.readyCount, 1);

  assert.equal(state.tasks.find((task) => task.id === 'restart-1').status, 'ready');
  assert.equal(state.tasks.find((task) => task.id === 'restart-1').blocker, null);
  assert.equal(state.tasks.find((task) => task.id === 'dep-1').status, 'blocked', 'non-recoverable blockers stay put');
  assert.equal(state.room.lastIdleWatchdogAt, nowIso);

  const notice = state.messages.find((entry) => entry.type === 'autopilot');
  assert.ok(notice);
  assert.match(notice.content, /Idle watchdog/);
  assert.match(notice.content, /Re-queued 1 recoverable blocked task/);
  assert.match(notice.content, /Nudge-draining 1 ready task/);
  assert.ok(state.audit.some((entry) => entry.type === 'idle-watchdog.fired' && entry.requeuedTaskIds.includes('restart-1')));

  // A second tick within the interval must not re-fire (watchdog stamp is activity).
  const again = applyIdleWatchdog(state, { nowMs: nowMs + 60_000, idleIntervalMs: 15 * 60_000 });
  assert.equal(again.acted, false);
  assert.equal(again.reason, 'not-idle');
});

test('formatIdleWatchdogNotice summarizes silence and actions', () => {
  assert.match(formatIdleWatchdogNotice({ idleMs: 12 * 60 * 60_000, readyCount: 2, requeuedCount: 3 }), /~720m/);
  assert.match(formatIdleWatchdogNotice({ idleMs: 30_000, readyCount: 0, requeuedCount: 1 }), /Re-queued 1 recoverable blocked task\./);
});

async function makeApp(context, prefix, seed, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const app = new ConclaveApp({
    sessionToken: 'test-token',
    workspace: directory,
    storeFile: path.join(directory, '.state', 'state.json'),
    idleWatchdogIntervalMs: options.idleWatchdogIntervalMs ?? 0,
    idleWatchdogCheckMs: options.idleWatchdogCheckMs ?? 0,
    ...options
  });
  await app.initialize();
  if (seed) await app.store.update(seed);
  const started = [];
  app.processes.start = ({ taskId = null, agentId = null, kind = 'agent', purpose = '', cwd }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind, purpose, command: '', cwd,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    app.processes.running.set(execution.id, { kill() {} });
    started.push(execution);
    return execution;
  };
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.listen({ port: 0 });
  return { app, started };
}

test('tickIdleWatchdog notifies the room and starts eligible ready work', async (context) => {
  const nowMs = Date.now();
  const stale = hourAgo(nowMs);
  const { app, started } = await makeApp(context, 'conclave-idle-wd-', (state) => {
    state.agents = [{
      id: 'codex', name: 'Codex', provider: 'Test', status: 'installed', connection: 'verified',
      activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, currentChatTurnId: null,
      lastAction: 'Ready'
    }];
    state.tasks = [{
      id: 'task_stale_ready',
      title: 'Stale ready work',
      objective: 'Should be drained by the idle watchdog',
      agentId: 'codex',
      accessMode: 'read-only',
      status: 'ready',
      priority: 'medium',
      origin: 'operator',
      dependencies: [],
      attempts: 0,
      blocker: null,
      executionId: null,
      createdAt: stale,
      updatedAt: stale
    }, {
      id: 'task_restart_blocked',
      title: 'Restart residue',
      objective: 'Should be re-queued',
      agentId: 'codex',
      accessMode: 'read-only',
      status: 'blocked',
      priority: 'medium',
      origin: 'operator',
      dependencies: [],
      attempts: 0,
      blocker: 'Conclave restarted while this task was queued.',
      executionId: null,
      createdAt: stale,
      updatedAt: stale
    }];
  }, { idleWatchdogIntervalMs: 5 * 60_000, idleWatchdogCheckMs: 0 });

  // initialize() may have started a disabled timer (checkMs 0); force interval for the tick.
  app.idleWatchdogIntervalMs = 5 * 60_000;

  const result = await app.tickIdleWatchdog();
  assert.equal(result.acted, true);
  assert.ok(result.requeuedIds.includes('task_restart_blocked'));
  assert.equal(app.store.state.tasks.find((task) => task.id === 'task_restart_blocked').status, 'ready');
  assert.ok(app.store.state.messages.some((entry) => entry.type === 'autopilot' && /Idle watchdog/.test(entry.content)));
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'idle-watchdog.fired'));
  // Drainer starts one task (one-run-per-agent); the other stays ready for a later drain.
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, 'agent');
  assert.ok(['task_stale_ready', 'task_restart_blocked'].includes(started[0].taskId));
});

test('tickIdleWatchdog leaves a normally idle board without runnable work untouched', async (context) => {
  const stale = hourAgo();
  const { app, started } = await makeApp(context, 'conclave-idle-wd-empty-', (state) => {
    state.tasks = [{
      id: 'task_already_done',
      title: 'Already complete',
      objective: 'Nothing remains to run',
      agentId: 'codex',
      accessMode: 'read-only',
      status: 'completed',
      priority: 'medium',
      origin: 'operator',
      dependencies: [],
      attempts: 1,
      blocker: null,
      executionId: null,
      createdAt: stale,
      updatedAt: stale
    }];
  }, { idleWatchdogIntervalMs: 5 * 60_000, idleWatchdogCheckMs: 0 });

  const result = await app.tickIdleWatchdog();
  assert.deepEqual(result, { acted: false, reason: 'no-eligible-work' });
  assert.equal(started.length, 0);
  assert.equal(app.store.state.room.lastIdleWatchdogAt, undefined);
  assert.equal(app.store.state.messages.some((entry) => entry.type === 'autopilot' && /Idle watchdog/.test(entry.content)), false);
  assert.equal(app.store.state.audit.some((entry) => entry.type === 'idle-watchdog.fired'), false);
});

test('tickIdleWatchdog never double-starts a busy agent and queued work drains once idle', async (context) => {
  const stale = hourAgo();
  const { app, started } = await makeApp(context, 'conclave-idle-wd-busy-', (state) => {
    state.agents = [{
      id: 'codex', name: 'Codex', provider: 'Test', status: 'installed', connection: 'verified',
      activity: 'running', executable: 'codex-fake', version: 'test', currentTaskId: 'task_active', currentChatTurnId: null,
      lastAction: 'Working'
    }];
    state.tasks = [{
      id: 'task_active',
      title: 'Existing run',
      objective: 'Keep the agent occupied',
      agentId: 'codex',
      accessMode: 'read-only',
      status: 'active',
      priority: 'medium',
      origin: 'operator',
      dependencies: [],
      attempts: 1,
      blocker: null,
      executionId: 'exec_existing',
      createdAt: stale,
      updatedAt: stale
    }, {
      id: 'task_waiting_for_agent',
      title: 'Queued behind busy agent',
      objective: 'Run only after the existing work finishes',
      agentId: 'codex',
      accessMode: 'read-only',
      status: 'ready',
      priority: 'medium',
      origin: 'operator',
      dependencies: [],
      attempts: 0,
      blocker: null,
      executionId: null,
      createdAt: stale,
      updatedAt: stale
    }];
  }, { idleWatchdogIntervalMs: 5 * 60_000, idleWatchdogCheckMs: 0 });

  const result = await app.tickIdleWatchdog();
  assert.equal(result.acted, true);
  assert.equal(started.length, 0, 'the watchdog must not launch a second run for a busy agent');
  assert.equal(app.store.state.tasks.find((task) => task.id === 'task_waiting_for_agent').status, 'ready');

  await app.store.update((state) => {
    const agent = state.agents.find((entry) => entry.id === 'codex');
    Object.assign(agent, { activity: 'idle', currentTaskId: null, lastAction: 'Ready' });
    state.tasks.find((task) => task.id === 'task_active').status = 'completed';
  });
  await app.startQueuedTasks();
  assert.equal(started.length, 1);
  assert.equal(started[0].taskId, 'task_waiting_for_agent');
});

test('persisted active work is interrupted on restart then recovered by the idle watchdog', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-idle-wd-restart-'));
  const storeFile = path.join(directory, '.state', 'state.json');
  let original;
  let restarted;
  try {
    original = new ConclaveApp({
      sessionToken: 'test-token', workspace: directory, storeFile,
      idleWatchdogIntervalMs: 0, idleWatchdogCheckMs: 0
    });
    await original.initialize();
    await original.listen({ port: 0 });
    const stale = hourAgo();
    await original.store.update((state) => {
      state.agents = [{
        id: 'codex', name: 'Codex', provider: 'Test', status: 'installed', connection: 'verified',
        activity: 'running', executable: 'codex-fake', version: 'test', currentTaskId: 'task_interrupted',
        currentChatTurnId: null, lastAction: 'Working'
      }];
      state.tasks = [{
        id: 'task_interrupted',
        title: 'Interrupted by restart',
        objective: 'Resume safely after the restart idle threshold',
        agentId: 'codex',
        accessMode: 'read-only',
        status: 'active',
        priority: 'critical',
        origin: 'operator',
        dependencies: [],
        attempts: 1,
        blocker: null,
        executionId: 'exec_before_restart',
        createdAt: stale,
        updatedAt: stale
      }];
      state.executions = [{
        id: 'exec_before_restart', taskId: 'task_interrupted', agentId: 'codex', kind: 'agent',
        purpose: 'task', command: 'codex-fake', cwd: directory, status: 'running', exitCode: null,
        output: '', startedAt: stale, finishedAt: null
      }];
    });
    await original.close();
    original = null;

    restarted = new ConclaveApp({
      sessionToken: 'test-token', workspace: directory, storeFile,
      idleWatchdogIntervalMs: 5 * 60_000, idleWatchdogCheckMs: 0
    });
    await restarted.initialize();
    await restarted.listen({ port: 0 });

    const recoveredTask = restarted.store.state.tasks.find((task) => task.id === 'task_interrupted');
    const interruptedExecution = restarted.store.state.executions.find((entry) => entry.id === 'exec_before_restart');
    assert.equal(recoveredTask.status, 'blocked');
    assert.equal(recoveredTask.blocker, 'Conclave restarted while this task was active.');
    assert.equal(interruptedExecution.status, 'interrupted');
    assert.ok(interruptedExecution.finishedAt);

    const started = [];
    restarted.processes.start = ({ taskId, agentId, kind, purpose, cwd }) => {
      const execution = {
        id: `exec_after_restart_${started.length}`, taskId, agentId, kind, purpose, command: '', cwd,
        status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
      };
      restarted.processes.running.set(execution.id, { kill() {} });
      started.push(execution);
      return execution;
    };
    await restarted.store.update((state) => {
      state.agents = [{
        id: 'codex', name: 'Codex', provider: 'Test', status: 'installed', connection: 'verified',
        activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null,
        currentChatTurnId: null, lastAction: 'Ready'
      }];
      state.tasks.find((task) => task.id === 'task_interrupted').updatedAt = hourAgo();
      state.executions.find((entry) => entry.id === 'exec_before_restart').finishedAt = hourAgo();
    });

    const result = await restarted.tickIdleWatchdog();
    assert.equal(result.acted, true);
    assert.deepEqual(result.requeuedIds, ['task_interrupted']);
    assert.equal(started.length, 1);
    assert.equal(started[0].taskId, 'task_interrupted');
    const activeTask = restarted.store.state.tasks.find((task) => task.id === 'task_interrupted');
    assert.equal(activeTask.status, 'active');
    assert.equal(activeTask.executionId, 'exec_after_restart_0');
  } finally {
    if (original) await original.close();
    if (restarted) {
      restarted.processes.running.clear();
      await restarted.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
