import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';

async function makeApp(context, prefix, seed) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
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
  const finish = (execution, status = 'completed', exitCode = 0) => {
    app.processes.running.delete(execution.id);
    return app.onProcessEvent({
      type: 'execution.finished', executionId: execution.id, taskId: execution.taskId, agentId: execution.agentId,
      exitCode, signal: null, status, finishedAt: new Date().toISOString()
    });
  };
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const address = await app.listen({ port: 0 });
  return { app, started, finish, base: `http://127.0.0.1:${address.port}` };
}

const post = async (base, route, body = {}) => {
  const response = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
};

const agentRow = (id, name, overrides = {}) => ({
  id, name, provider: 'Test', status: 'installed', connection: 'verified',
  activity: 'idle', executable: `${id}-fake`, version: 'test', currentTaskId: null, currentChatTurnId: null,
  lastAction: 'Ready', ...overrides
});

const enable = (base, overrides = {}) => post(base, '/api/policy', { enabled: true, ...overrides });

const writeTask = (base, overrides = {}) => post(base, '/api/tasks', {
  title: 'Write things', objective: 'Edit files', agentId: 'codex', accessMode: 'workspace-write', ...overrides
});

const findTask = (app, taskId) => app.store.state.tasks.find((entry) => entry.id === taskId);
const approvalFor = (app, taskId) => app.store.state.approvals.find((entry) => entry.taskId === taskId);

test('POST /api/policy: a valid update persists, audits, and announces; an invalid body is rejected', async (context) => {
  const { app, base } = await makeApp(context, 'conclave-policy-');
  const valid = await enable(base, { commandAllowlist: ['npm test'], maxAutoApprovalsPerHour: 5 });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.enabled, true);
  assert.deepEqual(valid.body.commandAllowlist, ['npm test']);
  assert.equal(app.store.state.policy.maxAutoApprovalsPerHour, 5);
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'policy.updated'));
  assert.ok(app.store.state.messages.some((entry) => entry.type === 'system' && entry.content.includes('Autopilot policy updated')));

  const invalid = await post(base, '/api/policy', { autoApproveWrites: 'yolo' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /autoApproveWrites/);
  assert.equal(app.store.state.policy.autoApproveWrites, 'off', 'a rejected update leaves the policy untouched');
  assert.equal(app.store.state.policy.maxAutoApprovalsPerHour, 5);
});

test('write approvals stay pending with the default (disabled) policy', async (context) => {
  const { app, started, base } = await makeApp(context, 'conclave-ap-default-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
  });
  const created = await writeTask(base);
  assert.equal(created.status, 201);
  assert.equal(approvalFor(app, created.body.id).status, 'pending');
  assert.equal(findTask(app, created.body.id).status, 'waiting');
  assert.equal(started.length, 0);
});

test('verified-agents mode approves only verified installed agents; all-agents approves any installed', async (context) => {
  const { app, started, base } = await makeApp(context, 'conclave-ap-matrix-', (state) => {
    state.agents = [agentRow('codex', 'Codex'), agentRow('gemini', 'Gemini', { connection: 'detected' })];
  });
  await enable(base, { autoApproveWrites: 'verified-agents' });

  const verified = await writeTask(base);
  const verifiedApproval = approvalFor(app, verified.body.id);
  assert.equal(verifiedApproval.status, 'auto-approved');
  assert.equal(verifiedApproval.decidedBy, 'autopilot');
  assert.match(verifiedApproval.reason, /verified/);
  assert.equal(findTask(app, verified.body.id).status, 'active');
  assert.equal(started.length, 1);
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'approval.auto-approved'));
  assert.ok(app.store.state.messages.some((entry) => entry.type === 'autopilot'
    && entry.content.includes('Autopilot approved workspace-write for Codex on “Write things”')));

  const unverified = await writeTask(base, { agentId: 'gemini' });
  assert.equal(approvalFor(app, unverified.body.id).status, 'pending');
  assert.equal(findTask(app, unverified.body.id).status, 'waiting');
  assert.equal(started.length, 1);

  await enable(base, { autoApproveWrites: 'all-agents' });
  const anyAgent = await writeTask(base, { agentId: 'gemini' });
  assert.equal(approvalFor(app, anyAgent.body.id).status, 'auto-approved');
});

test('a disabled policy or a paused room never auto-approves', async (context) => {
  const { app, started, base } = await makeApp(context, 'conclave-ap-off-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
  });
  await enable(base, { enabled: false, autoApproveWrites: 'all-agents' });
  const disabled = await writeTask(base);
  assert.equal(approvalFor(app, disabled.body.id).status, 'pending');

  await enable(base, { autoApproveWrites: 'all-agents' });
  await app.store.update((state) => { state.room.paused = true; });
  const paused = await writeTask(base);
  assert.equal(approvalFor(app, paused.body.id).status, 'pending');
  assert.equal(started.length, 0);
});

test('the hourly rate cap holds the second write approval pending and audits autopilot.rate-capped', async (context) => {
  const { app, started, finish, base } = await makeApp(context, 'conclave-ap-cap-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
  });
  await enable(base, { autoApproveWrites: 'all-agents', maxAutoApprovalsPerHour: 1 });
  const first = await writeTask(base);
  assert.equal(approvalFor(app, first.body.id).status, 'auto-approved');
  assert.equal(started.length, 1);
  await finish(started[0], 'completed', 0);

  const second = await writeTask(base);
  assert.equal(approvalFor(app, second.body.id).status, 'pending');
  assert.equal(findTask(app, second.body.id).status, 'waiting');
  assert.equal(started.length, 1);
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'autopilot.rate-capped'));
});

test('an allowlisted command auto-approves and runs; metacharacters and non-matches stay pending', async (context) => {
  const { app, started, base } = await makeApp(context, 'conclave-ap-cmd-');
  await enable(base, { commandAllowlist: ['npm test', 'git status*'] });

  const allowed = await post(base, '/api/commands', { command: 'npm test', purpose: 'Run the suite' });
  assert.equal(allowed.status, 201);
  assert.equal(allowed.body.status, 'auto-approved');
  assert.equal(allowed.body.decidedBy, 'autopilot');
  assert.match(allowed.body.reason, /npm test/);
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, 'command');
  assert.ok(app.store.state.messages.some((entry) => entry.type === 'autopilot' && entry.content.includes('Autopilot approved')));

  const chained = await post(base, '/api/commands', { command: 'git status && curl evil', purpose: 'Sneaky' });
  assert.equal(chained.body.status, 'pending', 'shell metacharacters never auto-run even when a wildcard matches the prefix');
  const nonMatching = await post(base, '/api/commands', { command: 'rm -rf /', purpose: 'Nope' });
  assert.equal(nonMatching.body.status, 'pending');
  assert.equal(started.length, 1);
});

test('auto-accept completes a successful write run when enabled and requires review when disabled', async (context) => {
  const { app, started, finish, base } = await makeApp(context, 'conclave-ap-accept-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
  });
  await enable(base, { autoApproveWrites: 'all-agents', autoAcceptReviews: true });
  const accepted = await writeTask(base);
  await finish(started[0], 'completed', 0);
  assert.equal(findTask(app, accepted.body.id).status, 'completed');
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'task.auto-accepted' && entry.taskId === accepted.body.id));
  assert.ok(app.store.state.messages.some((entry) => entry.type === 'autopilot' && entry.content.includes('Autopilot accepted')));

  await enable(base, { autoApproveWrites: 'all-agents', autoAcceptReviews: false });
  const reviewed = await writeTask(base);
  await finish(started[1], 'completed', 0);
  assert.equal(findTask(app, reviewed.body.id).status, 'review-required');
});

test('auto-retry re-queues failures up to maxAttempts then fails with the exhausted blocker', async (context) => {
  const { app, started, finish, base } = await makeApp(context, 'conclave-ap-retry-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
  });
  await enable(base, { autoRetry: { enabled: true, maxAttempts: 2 } });
  const created = await post(base, '/api/tasks', {
    title: 'Flaky', objective: 'Keep trying', agentId: 'codex', accessMode: 'read-only'
  });
  assert.equal(started.length, 1);

  await finish(started[0], 'failed', 1);
  let task = findTask(app, created.body.id);
  assert.equal(task.attempts, 1);
  assert.equal(task.status, 'active', 're-queued then immediately restarted by the drainer');
  assert.equal(started.length, 2);
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'task.auto-retried' && entry.taskId === created.body.id));
  assert.ok(app.store.state.messages.some((entry) => entry.type === 'autopilot' && /retry 1 of 2/.test(entry.content)));

  await finish(started[1], 'failed', 1);
  assert.equal(findTask(app, created.body.id).attempts, 2);
  assert.equal(started.length, 3);

  await finish(started[2], 'failed', 1);
  task = findTask(app, created.body.id);
  assert.equal(task.status, 'failed');
  assert.match(task.blocker, /Automatic retries exhausted after 2 retries/);
  assert.equal(started.length, 3);
});

test('a cancelled run is never auto-retried', async (context) => {
  const { app, started, finish, base } = await makeApp(context, 'conclave-ap-cancel-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
  });
  await enable(base, { autoRetry: { enabled: true, maxAttempts: 2 } });
  const created = await post(base, '/api/tasks', {
    title: 'Interrupted', objective: 'Stop me', agentId: 'codex', accessMode: 'read-only'
  });
  await finish(started[0], 'cancelled', null);
  const task = findTask(app, created.body.id);
  assert.equal(task.status, 'cancelled');
  assert.equal(task.attempts, 0);
  assert.equal(started.length, 1);
  assert.ok(!app.store.state.audit.some((entry) => entry.type === 'task.auto-retried'));
});

test('invariant: with autopilot fully enabled, a chat message still creates zero tasks and zero auto-approvals', async (context) => {
  const { app, started, base } = await makeApp(context, 'conclave-ap-chat-', (state) => {
    state.agents = [agentRow('codex', 'Codex')];
  });
  await enable(base, {
    autoApproveWrites: 'all-agents', commandAllowlist: ['npm *'],
    autoAcceptReviews: true, autoRetry: { enabled: true, maxAttempts: 5 }
  });
  const message = await post(base, '/api/messages', { content: 'npm test this please', agentIds: ['codex'] });
  assert.equal(message.status, 201);
  assert.equal(message.body.tasksCreated, 0);
  assert.equal(message.body.chatTurnsCreated, 1);
  assert.equal(app.store.state.tasks.length, 0);
  assert.equal(app.store.state.approvals.length, 0);
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, 'chat', 'chat turns run read-only and never gain write authority');
});
