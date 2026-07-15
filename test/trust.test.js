import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { ConclaveApp, promptForChat } from '../src/server.js';
import { evaluateAutoApproval } from '../src/lib/policy.js';
import { buildAgentInvocation } from '../src/lib/adapters.js';

function roomState(trust) {
  return {
    room: { paused: false, trust, limits: { maxConcurrentRuns: 3 } },
    agents: [{ id: 'codex', name: 'Codex', status: 'installed', connection: 'verified' }],
    approvals: [], audit: [], policy: { enabled: false, autoApproveWrites: 'off', commandAllowlist: [], maxAutoApprovalsPerHour: 20 }
  };
}

test('unleashed auto-approves writes and any command without policy or allowlist', () => {
  const gated = roomState('gated');
  assert.equal(evaluateAutoApproval(gated, { type: 'agent-write', agentId: 'codex' }, { running: 0 }).allow, false);
  assert.equal(evaluateAutoApproval(gated, { type: 'command', command: 'rm -rf x' }, { running: 0 }).allow, false);

  const unleashed = roomState('unleashed');
  assert.equal(evaluateAutoApproval(unleashed, { type: 'agent-write', agentId: 'codex' }, { running: 0 }).allow, true);
  assert.equal(evaluateAutoApproval(unleashed, { type: 'command', command: 'anything && piped | stuff' }, { running: 0 }).allow, true);

  // Non-negotiable guards still hold even when unleashed.
  const paused = roomState('unleashed'); paused.room.paused = true;
  assert.equal(evaluateAutoApproval(paused, { type: 'command', command: 'x' }, { running: 0 }).allow, false);
  assert.equal(evaluateAutoApproval(roomState('unleashed'), { type: 'command', command: 'x' }, { running: 3 }).allow, false);
});

test('elevated permissions only flow to write runs in unleashed rooms', () => {
  const base = { executable: 'x', prompt: 'p', workspace: '/w' };
  const claudeGated = buildAgentInvocation('claude', { ...base, accessMode: 'workspace-write', elevated: false });
  assert.ok(claudeGated.args.includes('acceptEdits'));
  assert.ok(!claudeGated.args.includes('bypassPermissions'));
  const claudeUnleashed = buildAgentInvocation('claude', { ...base, accessMode: 'workspace-write', elevated: true });
  assert.ok(claudeUnleashed.args.includes('bypassPermissions'));
  // Read-only stays 'plan' regardless of trust — no elevation.
  const readOnly = buildAgentInvocation('claude', { ...base, accessMode: 'read-only', elevated: true });
  assert.ok(readOnly.args.includes('plan'));
  assert.ok(!readOnly.args.includes('bypassPermissions'));

  const codexUnleashed = buildAgentInvocation('codex', { ...base, accessMode: 'workspace-write', elevated: true });
  assert.ok(codexUnleashed.args.includes('danger-full-access'));
});

test('unleashed chat prompts invite every agent to dispatch plans', () => {
  const state = {
    room: { workspace: '/w', trust: 'unleashed', coordinatorId: null },
    agents: [{ id: 'grok', name: 'Grok', status: 'installed' }], tasks: [], messages: []
  };
  const prompt = promptForChat({ id: 'm1', content: 'build the thing' }, state.agents[0], state);
  assert.match(prompt, /UNLEASHED room/);
  assert.match(prompt, /conclave-plan/);
});

test('a non-coordinator plan dispatches and auto-approves writes in an unleashed room', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-trust-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  await app.store.update((state) => {
    state.room.trust = 'unleashed';
    state.room.coordinatorId = null; // grok is NOT coordinator
    state.agents = [{ id: 'grok', name: 'Grok', provider: 'xAI', status: 'installed', connection: 'verified', activity: 'idle', executable: 'grok-fake', version: 'test', currentTaskId: null, lastAction: 'Ready' }];
    state.chatTurns.unshift({ id: 'turn_1', agentId: 'grok', status: 'completed', executionId: 'exec_1' });
    const plan = '```conclave-plan\n[{"title": "Refactor the parser", "objective": "Split it into modules", "agentId": "grok", "accessMode": "workspace-write", "priority": "high"}]\n```';
    state.messages.push({ id: 'msg_plan', source: 'grok', sourceName: 'Grok', type: 'message', chatTurnId: 'turn_1', content: plan, createdAt: new Date().toISOString() });
    app.applyCoordinatorPlan(state, state.chatTurns[0]);
  });
  const { tasks, approvals, audit } = app.store.state;
  const task = tasks.find((entry) => entry.title === 'Refactor the parser');
  assert.ok(task, 'the plan created a task even though grok is not the coordinator');
  assert.equal(task.status, 'ready', 'dispatched straight to ready, not parked in the inbox');
  const approval = approvals.find((entry) => entry.taskId === task.id);
  assert.equal(approval.status, 'auto-approved', 'its write access is auto-approved up front');
  assert.ok(audit.some((entry) => entry.type === 'plan.dispatched'));
  assert.ok(audit.some((entry) => entry.type === 'approval.auto-approved' && entry.taskId === task.id));
});

test('a gated room still parks non-coordinator plans as inert text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-gated-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  await app.store.update((state) => {
    state.room.trust = 'gated';
    state.room.coordinatorId = null;
    state.agents = [{ id: 'grok', name: 'Grok', provider: 'xAI', status: 'installed', connection: 'verified', activity: 'idle', executable: 'grok-fake', version: 'test', currentTaskId: null, lastAction: 'Ready' }];
    state.chatTurns.unshift({ id: 'turn_1', agentId: 'grok', status: 'completed', executionId: 'exec_1' });
    const plan = '```conclave-plan\n[{"title": "Sneaky task", "agentId": "grok", "accessMode": "workspace-write"}]\n```';
    state.messages.push({ id: 'msg_plan', source: 'grok', sourceName: 'Grok', type: 'message', chatTurnId: 'turn_1', content: plan, createdAt: new Date().toISOString() });
    app.applyCoordinatorPlan(state, state.chatTurns[0]);
  });
  assert.equal(app.store.state.tasks.some((entry) => entry.title === 'Sneaky task'), false);
});
