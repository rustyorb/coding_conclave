import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp, promptForChat, promptForTask, SPECIALIST_ROLES } from '../src/server.js';

async function makeApp(prefix, seed) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  if (seed) await app.store.update(seed);
  const started = [];
  app.processes.start = ({ taskId, agentId, kind }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind, purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push(execution);
    app.processes.running.set(execution.id, { pid: 0 });
    return execution;
  };
  const address = await app.listen({ port: 0 });
  return { app, started, directory, base: `http://127.0.0.1:${address.port}` };
}

const post = (base, route, body = {}) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' }, body: JSON.stringify(body)
});

const agentRow = (id, name) => ({
  id, name, provider: 'Test', status: 'installed', connection: 'verified',
  activity: 'idle', executable: `${id}-fake`, version: 'test', currentTaskId: null, lastAction: 'Ready'
});

const finish = (app, execution) => app.onProcessEvent({
  type: 'execution.finished', executionId: execution.id, taskId: null, agentId: execution.agentId,
  exitCode: 0, signal: null, status: 'completed', finishedAt: new Date().toISOString()
});

test('US-041: roles endpoint assigns a coordinator and specialist roles with validation and audit', async (context) => {
  const { app, directory, base } = await makeApp('conclave-roles-', (state) => {
    state.agents = [agentRow('claude', 'Claude'), agentRow('codex', 'Codex')];
  });
  context.after(async () => { app.processes.running.clear(); await app.close(); await app.store.update(() => {}); await rm(directory, { recursive: true, force: true }); });

  const ok = await post(base, '/api/roles', {
    coordinatorId: 'claude',
    roles: { codex: ['implementer', 'reviewer'], claude: ['architect'] }
  });
  assert.equal(ok.status, 200);
  assert.equal(app.store.state.room.coordinatorId, 'claude');
  assert.deepEqual(app.store.state.room.roles.codex, ['implementer', 'reviewer']);
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'roles.updated'));
  assert.ok(app.store.state.messages.some((entry) => entry.content.includes('Claude is now Coordinator')));

  assert.equal((await post(base, '/api/roles', { coordinatorId: 'nobody' })).status, 400);
  assert.equal((await post(base, '/api/roles', { roles: { codex: ['emperor'] } })).status, 400);
  assert.equal(app.store.state.room.coordinatorId, 'claude', 'failed updates change nothing');

  const human = await post(base, '/api/roles', { coordinatorId: null, roles: {} });
  assert.equal(human.status, 200);
  assert.equal(app.store.state.room.coordinatorId, null);
});

test('prompts carry roles: coordinator gets assignment authority and live availability, teammates see role labels', () => {
  const state = {
    room: { workspace: 'C:\\ws', trust: 'gated', coordinatorId: 'claude', roles: { codex: ['implementer'] } },
    agents: [
      { ...agentRow('claude', 'Claude') },
      { ...agentRow('codex', 'Codex') }
    ],
    tasks: [],
    messages: []
  };
  const coordinatorPrompt = promptForChat({ id: 'm1', content: 'plan the work' }, state.agents[0], state);
  assert.match(coordinatorPrompt, /You are this room’s Coordinator\./);
  assert.match(coordinatorPrompt, /```conclave-plan/);
  assert.match(coordinatorPrompt, /Available agents: claude \(idle\), codex \(idle\)/);
  assert.match(coordinatorPrompt, /Read-only tasks run when their assignees are idle/);
  assert.doesNotMatch(coordinatorPrompt, /advisory|nothing runs until the operator approves/i);

  const workerPrompt = promptForChat({ id: 'm1', content: 'hi' }, state.agents[1], state);
  assert.match(workerPrompt, /Your roles in this room: implementer\./);
  assert.match(workerPrompt, /Room coordinator: Claude\./);
  assert.doesNotMatch(workerPrompt, /conclave-plan/);

  const taskPrompt = promptForTask({ title: 'T', objective: 'O', accessMode: 'read-only' }, state.agents[1], state);
  assert.match(taskPrompt, /Claude \(coordinator\)/, 'teammate list labels the coordinator');
});

test('US-042: a coordinator plan assigns idle agents immediately while write access remains gated', async (context) => {
  const { app, started, directory } = await makeApp('conclave-plan-', (state) => {
    state.agents = [agentRow('claude', 'Claude'), agentRow('codex', 'Codex')];
    state.room.coordinatorId = 'claude';
  });
  context.after(async () => { app.processes.running.clear(); await app.close(); await app.store.update(() => {}); await rm(directory, { recursive: true, force: true }); });

  const message = { id: 'msg_ask', source: 'user', sourceName: 'You', type: 'message', content: 'plan it', createdAt: new Date().toISOString() };
  await app.store.update((state) => state.messages.push(message));
  const turn = await app.createChatTurn(message, app.store.state.agents[0]);
  assert.equal(started.length, 1);

  const plan = JSON.stringify([
    { title: 'Diagnose the flaky test', objective: 'Find the root cause', agentId: 'codex', accessMode: 'read-only', priority: 'high', dependsOn: [] },
    { title: 'Fix the flaky test', objective: 'Smallest fix with evidence', agentId: 'codex', accessMode: 'workspace-write', priority: 'high', dependsOn: [0] },
    { title: 'Bad entry', agentId: 'ghost' },
    { agentId: 'codex' }
  ]);
  await app.store.update((state) => state.messages.push({
    id: 'msg_plan', source: 'claude', sourceName: 'Claude', type: 'message', chatTurnId: turn.id,
    content: `Here is my plan:\n\`\`\`conclave-plan\n${plan}\n\`\`\`\nThoughts?`, createdAt: new Date().toISOString()
  }));
  await finish(app, started[0]);

  assert.equal(app.store.state.tasks.length, 2, 'two valid entries assigned; invalid agent and missing title skipped');
  const diagnose = app.store.state.tasks.find((task) => task.title === 'Diagnose the flaky test');
  const fix = app.store.state.tasks.find((task) => task.title === 'Fix the flaky test');
  assert.equal(diagnose.origin, 'coordinator');
  assert.equal(diagnose.proposedBy, 'claude');
  assert.deepEqual(fix.dependencies, [diagnose.id], 'dependsOn index resolved to the created task id');
  assert.equal(diagnose.status, 'active', 'read-only assignment starts on the idle assignee');
  assert.equal(fix.status, 'waiting', 'write assignment waits for authority');
  assert.equal(started.length, 2, 'the chat run and idle agent task both launched');
  assert.equal(app.store.state.approvals.filter((entry) => entry.taskId === fix.id && entry.status === 'pending').length, 1);
  const planMessage = app.store.state.messages.find((entry) => entry.id === 'msg_plan');
  assert.match(planMessage.content, /\[Assigned 2 tasks to the Board\]/);
  assert.ok(app.store.state.messages.some((entry) => entry.source === 'system' && entry.content.includes('Skipped')));
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'plan.dispatched'));
});

test('plan blocks from a non-coordinator agent are inert text', async (context) => {
  const { app, started, directory } = await makeApp('conclave-plan-inert-', (state) => {
    state.agents = [agentRow('claude', 'Claude'), agentRow('codex', 'Codex')];
    state.room.coordinatorId = 'claude';
  });
  context.after(async () => { app.processes.running.clear(); await app.close(); await app.store.update(() => {}); await rm(directory, { recursive: true, force: true }); });

  const message = { id: 'msg_ask', source: 'user', sourceName: 'You', type: 'message', content: 'plan it', createdAt: new Date().toISOString() };
  await app.store.update((state) => state.messages.push(message));
  const turn = await app.createChatTurn(message, app.store.state.agents[1]); // codex, not the coordinator
  await app.store.update((state) => state.messages.push({
    id: 'msg_sneak', source: 'codex', sourceName: 'Codex', type: 'message', chatTurnId: turn.id,
    content: '```conclave-plan\n[{"title": "Sneaky task", "agentId": "codex"}]\n```', createdAt: new Date().toISOString()
  }));
  await finish(app, started[0]);

  assert.equal(app.store.state.tasks.length, 0, 'no tasks from a non-coordinator plan block');
  assert.match(app.store.state.messages.find((entry) => entry.id === 'msg_sneak').content, /conclave-plan/, 'message left untouched');
});

test('gated coordinator assignments honor operator-authored write autopilot policy', async (context) => {
  const { app, started, directory } = await makeApp('conclave-plan-policy-', (state) => {
    state.agents = [agentRow('claude', 'Claude'), agentRow('codex', 'Codex')];
    state.room.coordinatorId = 'claude';
    state.policy.enabled = true;
    state.policy.autoApproveWrites = 'verified-agents';
  });
  context.after(async () => { app.processes.running.clear(); await app.close(); await app.store.update(() => {}); await rm(directory, { recursive: true, force: true }); });

  const message = { id: 'msg_ask', source: 'user', sourceName: 'You', type: 'message', content: 'plan it', createdAt: new Date().toISOString() };
  await app.store.update((state) => state.messages.push(message));
  const turn = await app.createChatTurn(message, app.store.state.agents[0]);
  const plan = JSON.stringify([
    { title: 'Apply the change', objective: 'obj', agentId: 'codex', accessMode: 'workspace-write' }
  ]);
  await app.store.update((state) => state.messages.push({
    id: 'msg_plan', source: 'claude', sourceName: 'Claude', type: 'message', chatTurnId: turn.id,
    content: `\`\`\`conclave-plan\n${plan}\n\`\`\``, createdAt: new Date().toISOString()
  }));
  await finish(app, started[0]);
  const apply = app.store.state.tasks.find((task) => task.title === 'Apply the change');
  assert.equal(apply.status, 'active', 'standing room policy lets the assignment enter the run queue');
  assert.equal(app.store.state.approvals.filter((entry) => entry.taskId === apply.id && entry.status === 'auto-approved').length, 1);
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'approval.auto-approved' && entry.taskId === apply.id));
  assert.equal(started.length, 2, 'the policy-approved write launches on the idle verified agent');
});

test('plan edge cases are surfaced: truncated blocks reject loudly, dropped dependencies are named', async (context) => {
  const { app, started, directory } = await makeApp('conclave-plan-edges-', (state) => {
    state.agents = [agentRow('claude', 'Claude'), agentRow('codex', 'Codex')];
    state.room.coordinatorId = 'claude';
  });
  context.after(async () => { app.processes.running.clear(); await app.close(); await app.store.update(() => {}); await rm(directory, { recursive: true, force: true }); });

  // Truncated plan block: opening fence, no closing fence (as after a 20k clamp).
  const askOne = { id: 'msg_ask1', source: 'user', sourceName: 'You', type: 'message', content: 'plan', createdAt: new Date().toISOString() };
  await app.store.update((state) => state.messages.push(askOne));
  const turnOne = await app.createChatTurn(askOne, app.store.state.agents[0]);
  await app.store.update((state) => state.messages.push({
    id: 'msg_truncated', source: 'claude', sourceName: 'Claude', type: 'message', chatTurnId: turnOne.id,
    content: '```conclave-plan\n[{"title": "Lost task", "agentId": "codex"…[truncated]', createdAt: new Date().toISOString()
  }));
  await finish(app, started[0]);
  assert.equal(app.store.state.tasks.length, 0);
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'plan.invalid' && /closing fence/.test(entry.detail)));
  assert.ok(app.store.state.messages.some((entry) => entry.source === 'system' && /could not be read/.test(entry.content)));

  // Dependency on a skipped entry is dropped WITH a named note, never silently.
  const askTwo = { id: 'msg_ask2', source: 'user', sourceName: 'You', type: 'message', content: 'plan again', createdAt: new Date().toISOString() };
  await app.store.update((state) => state.messages.push(askTwo));
  const turnTwo = await app.createChatTurn(askTwo, app.store.state.agents[0]);
  const plan = JSON.stringify([
    { title: 'Skipped prerequisite', agentId: 'ghost' },
    { title: 'Dependent task', objective: 'obj', agentId: 'codex', dependsOn: [0] }
  ]);
  await app.store.update((state) => state.messages.push({
    id: 'msg_dropdep', source: 'claude', sourceName: 'Claude', type: 'message', chatTurnId: turnTwo.id,
    content: `\`\`\`conclave-plan\n${plan}\n\`\`\``, createdAt: new Date().toISOString()
  }));
  await finish(app, started[1]);
  const dependent = app.store.state.tasks.find((task) => task.title === 'Dependent task');
  assert.ok(dependent, 'valid entry still assigned');
  assert.deepEqual(dependent.dependencies, []);
  assert.ok(app.store.state.messages.some((entry) =>
    entry.source === 'system' && entry.content.includes('dropped dependency on invalid or skipped entry #1')));
  const dispatchedAudit = app.store.state.audit.find((entry) => entry.type === 'plan.dispatched');
  assert.match(dispatchedAudit.detail, /raw plan: /, 'audit preserves the raw assignment block');
});
