import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';
import { id, now } from '../src/lib/utils.js';

async function makeApp(context, storeFile) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-autopilot-'));
  const app = new ConclaveApp({ workspace: directory, storeFile: storeFile || path.join(directory, '.state', 'state.json') });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, base: `http://127.0.0.1:${address.port}`, directory };
}

function stubProcesses(app) {
  const started = [];
  app.processes.start = (options) => { started.push(options); return { id: id('exec'), ...options }; };
  return started;
}

async function post(base, url, body) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

const getState = async (base) => (await fetch(`${base}/api/state`)).json();

function seedAgent(app, overrides = {}) {
  return app.store.update((state) => {
    state.agents = [{
      id: 'claude', name: 'Claude', provider: 'Anthropic', status: 'installed', connection: 'verified',
      activity: 'idle', executable: '/usr/bin/claude', version: '1.0.0', capabilities: [], currentTaskId: null, lastAction: '', ...overrides
    }];
  });
}

const enable = (base, overrides = {}) => post(base, '/api/policy', {
  enabled: true, autoApproveWrites: 'off', commandAllowlist: [], autoAcceptReviews: false, maxAutoApprovalsPerHour: 20, ...overrides
});

test('defaults keep every command pending with autopilot off', async (context) => {
  const { app, base } = await makeApp(context);
  const state = await getState(base);
  assert.deepEqual(state.policy, {
    enabled: false, autoApproveWrites: 'off', commandAllowlist: [], autoAcceptReviews: false, maxAutoApprovalsPerHour: 20
  });
  const { status, body } = await post(base, '/api/commands', { command: 'node --version', purpose: 'Verify Node' });
  assert.equal(status, 201);
  assert.equal(body.status, 'pending');
  assert.equal(app.processes.running.size, 0);
});

test('POST /api/policy validates, persists, audits, and never poisons the store queue', async (context) => {
  const { base } = await makeApp(context);
  const valid = await enable(base, { commandAllowlist: ['npm test'], maxAutoApprovalsPerHour: 5 });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.enabled, true);
  assert.deepEqual(valid.body.commandAllowlist, ['npm test']);
  let state = await getState(base);
  assert.equal(state.policy.maxAutoApprovalsPerHour, 5);
  assert.ok(state.audit.some((entry) => entry.type === 'policy.updated'));
  const invalid = await post(base, '/api/policy', { autoApproveWrites: 'yolo' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /autoApproveWrites/);
  state = await getState(base);
  assert.equal(state.policy.autoApproveWrites, 'off');
  const message = await post(base, '/api/messages', { content: 'still alive' });
  assert.equal(message.status, 201);
});

test('allowlisted command is auto-approved, executed, and fully attributed', async (context) => {
  const { app, base } = await makeApp(context);
  const started = stubProcesses(app);
  await enable(base, { commandAllowlist: ['npm test'] });
  const { status, body } = await post(base, '/api/commands', { command: 'npm test', purpose: 'Run the suite' });
  assert.equal(status, 201);
  assert.equal(body.status, 'auto-approved');
  assert.equal(body.decidedBy, 'autopilot');
  assert.match(body.reason, /npm test/);
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, 'command');
  const state = await getState(base);
  assert.ok(state.messages.some((entry) => entry.type === 'autopilot' && entry.content.includes('Autopilot approved')));
  assert.ok(state.audit.some((entry) => entry.type === 'approval.auto-approved'));
});

test('non-matching command stays pending and the manual path still works', async (context) => {
  const { app, base } = await makeApp(context);
  const started = stubProcesses(app);
  await enable(base, { commandAllowlist: ['npm test'] });
  const { body } = await post(base, '/api/commands', { command: 'npm test && rm -rf /', purpose: 'Sneaky' });
  assert.equal(body.status, 'pending');
  assert.equal(started.length, 0);
  const decision = await post(base, `/api/approvals/${body.id}`, { decision: 'denied' });
  assert.equal(decision.status, 200);
  assert.equal(decision.body.status, 'denied');
  assert.equal(decision.body.decidedBy, 'user');
});

test('paused room never auto-approves', async (context) => {
  const { app, base } = await makeApp(context);
  const started = stubProcesses(app);
  await enable(base, { commandAllowlist: ['npm test'] });
  await post(base, '/api/room/pause', {});
  const { body } = await post(base, '/api/commands', { command: 'npm test', purpose: 'Run the suite' });
  assert.equal(body.status, 'pending');
  assert.equal(started.length, 0);
});

test('hourly rate cap holds and survives a restart', async (context) => {
  const { app, base, directory } = await makeApp(context);
  stubProcesses(app);
  await enable(base, { commandAllowlist: ['npm test'], maxAutoApprovalsPerHour: 1 });
  const first = await post(base, '/api/commands', { command: 'npm test', purpose: 'First' });
  assert.equal(first.body.status, 'auto-approved');
  const second = await post(base, '/api/commands', { command: 'npm test', purpose: 'Second' });
  assert.equal(second.body.status, 'pending');
  const state = await getState(base);
  assert.ok(state.audit.some((entry) => entry.type === 'autopilot.rate-capped'));
  const storeFile = path.join(directory, '.state', 'state.json');
  const revived = new ConclaveApp({ workspace: directory, storeFile });
  await revived.initialize();
  const address = await revived.listen({ port: 0 });
  context.after(() => revived.close());
  stubProcesses(revived);
  const third = await post(`http://127.0.0.1:${address.port}`, '/api/commands', { command: 'npm test', purpose: 'Third' });
  assert.equal(third.body.status, 'pending');
});

test('agent-write auto-approval follows the verification matrix', async (context) => {
  const { app, base } = await makeApp(context);
  const startedTasks = [];
  app.startTask = async (taskId) => { startedTasks.push(taskId); };
  await seedAgent(app);
  await enable(base, { autoApproveWrites: 'verified-agents' });
  const makeTask = () => post(base, '/api/tasks', {
    title: 'Write things', objective: 'Edit files', agentId: 'claude', accessMode: 'workspace-write'
  });

  const verified = await makeTask();
  assert.equal(verified.status, 201);
  let state = await getState(base);
  assert.equal(state.approvals[0].status, 'auto-approved');
  assert.equal(state.approvals[0].decidedBy, 'autopilot');
  assert.deepEqual(startedTasks, [verified.body.id]);

  await seedAgent(app, { connection: 'detected' });
  const unverified = await makeTask();
  state = await getState(base);
  assert.equal(state.approvals[0].status, 'pending');
  assert.equal(state.tasks.find((entry) => entry.id === unverified.body.id).status, 'waiting');
  assert.equal(startedTasks.length, 1);

  await enable(base, { autoApproveWrites: 'all-agents' });
  await makeTask();
  state = await getState(base);
  assert.equal(state.approvals[0].status, 'auto-approved');
  assert.equal(startedTasks.length, 2);

  await enable(base, { enabled: false, autoApproveWrites: 'all-agents' });
  const manual = await makeTask();
  state = await getState(base);
  assert.equal(state.approvals[0].status, 'pending');
  const approved = await post(base, `/api/approvals/${state.approvals[0].id}`, { decision: 'approved' });
  assert.equal(approved.status, 200);
  assert.deepEqual(startedTasks.at(-1), manual.body.id);
});

test('start failure after auto-approval reverts to pending for manual recovery', async (context) => {
  const { app, base } = await makeApp(context);
  app.startTask = async () => { throw new Error('boom'); };
  await seedAgent(app);
  await enable(base, { autoApproveWrites: 'all-agents' });
  const created = await post(base, '/api/tasks', {
    title: 'Write things', objective: 'Edit files', agentId: 'claude', accessMode: 'workspace-write'
  });
  assert.equal(created.status, 201);
  const state = await getState(base);
  const approval = state.approvals[0];
  assert.equal(approval.status, 'pending');
  assert.equal(approval.decidedBy, null);
  assert.equal(approval.reason, null);
  assert.equal(approval.decidedAt, null);
  assert.ok(state.audit.some((entry) => entry.type === 'autopilot.start-failed' && entry.detail === 'boom'));
  assert.ok(state.messages.some((entry) => entry.type === 'autopilot' && entry.content.includes('manual review')));
  const startedTasks = [];
  app.startTask = async (taskId) => { startedTasks.push(taskId); };
  const approved = await post(base, `/api/approvals/${approval.id}`, { decision: 'approved' });
  assert.equal(approved.status, 200);
  assert.deepEqual(startedTasks, [created.body.id]);
});

test('auto-accept reviews completes successful runs only when enabled and live', async (context) => {
  const { app, base } = await makeApp(context);
  const finish = async (status, exitCode) => {
    const taskId = id('task');
    const executionId = id('exec');
    await app.store.update((state) => {
      state.tasks.unshift({
        id: taskId, title: 'Reviewed task', objective: 'Work', agentId: 'claude', accessMode: 'read-only',
        status: 'active', dependencies: [], blocker: null, executionId, createdAt: now(), updatedAt: now()
      });
      state.executions.unshift({ id: executionId, taskId, agentId: null, kind: 'agent', status: 'running', output: '', startedAt: now(), finishedAt: null });
    });
    await app.onProcessEvent({
      type: 'execution.finished', executionId, taskId, agentId: null,
      exitCode, signal: null, status, finishedAt: now()
    });
    return (await getState(base)).tasks.find((entry) => entry.id === taskId);
  };

  await enable(base, { autoAcceptReviews: true });
  let task = await finish('completed', 0);
  assert.equal(task.status, 'completed');
  let state = await getState(base);
  assert.ok(state.audit.some((entry) => entry.type === 'task.auto-accepted' && entry.taskId === task.id));
  assert.ok(state.messages.some((entry) => entry.type === 'autopilot' && entry.content.includes('Autopilot accepted')));

  task = await finish('failed', 1);
  assert.equal(task.status, 'failed');

  await post(base, '/api/room/pause', {});
  task = await finish('completed', 0);
  assert.equal(task.status, 'review-required');
  await post(base, '/api/room/resume', {});

  await enable(base, { autoAcceptReviews: false });
  task = await finish('completed', 0);
  assert.equal(task.status, 'review-required');
});
