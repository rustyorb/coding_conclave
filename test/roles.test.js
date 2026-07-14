import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp, promptForChat, promptForTask, SPECIALIST_ROLES } from '../src/server.js';

async function makeApp(prefix, seed) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
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
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
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
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

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

test('prompts carry roles: coordinator gets plan instructions, teammates see role labels, others get none', () => {
  const state = {
    room: { workspace: 'C:\\ws', coordinatorId: 'claude', roles: { codex: ['implementer'] } },
    agents: [
      { ...agentRow('claude', 'Claude') },
      { ...agentRow('codex', 'Codex') }
    ],
    tasks: [],
    messages: []
  };
  const coordinatorPrompt = promptForChat({ id: 'm1', content: 'plan the work' }, state.agents[0], state);
  assert.match(coordinatorPrompt, /Coordinator \(advisory/);
  assert.match(coordinatorPrompt, /```conclave-plan/);
  assert.match(coordinatorPrompt, /nothing runs until the operator approves/);

  const workerPrompt = promptForChat({ id: 'm1', content: 'hi' }, state.agents[1], state);
  assert.match(workerPrompt, /Your roles in this room: implementer\./);
  assert.match(workerPrompt, /Room coordinator: Claude\./);
  assert.doesNotMatch(workerPrompt, /conclave-plan/);

  const taskPrompt = promptForTask({ title: 'T', objective: 'O', accessMode: 'read-only' }, state.agents[1], state);
  assert.match(taskPrompt, /Claude \(coordinator\)/, 'teammate list labels the coordinator');
});

test('US-042: a coordinator plan block becomes proposed Inbox tasks with resolved dependencies and zero runs', async (context) => {
  const { app, started, directory } = await makeApp('conclave-plan-', (state) => {
    state.agents = [agentRow('claude', 'Claude'), agentRow('codex', 'Codex')];
    state.room.coordinatorId = 'claude';
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

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

  const proposed = app.store.state.tasks.filter((task) => task.status === 'proposed');
  assert.equal(proposed.length, 2, 'two valid entries proposed; invalid agent and missing title skipped');
  const diagnose = proposed.find((task) => task.title === 'Diagnose the flaky test');
  const fix = proposed.find((task) => task.title === 'Fix the flaky test');
  assert.equal(diagnose.origin, 'coordinator');
  assert.equal(diagnose.proposedBy, 'claude');
  assert.deepEqual(fix.dependencies, [diagnose.id], 'dependsOn index resolved to the created task id');
  assert.equal(started.length, 1, 'no runs launched by the proposal');
  assert.equal(app.store.state.approvals.length, 0, 'no approvals created by the proposal');
  const planMessage = app.store.state.messages.find((entry) => entry.id === 'msg_plan');
  assert.match(planMessage.content, /\[Proposed 2 tasks — review them in the Board Inbox\]/);
  assert.ok(app.store.state.messages.some((entry) => entry.source === 'system' && entry.content.includes('Skipped')));
  assert.ok(app.store.state.audit.some((entry) => entry.type === 'plan.proposed'));
});

test('plan blocks from a non-coordinator agent are inert text', async (context) => {
  const { app, started, directory } = await makeApp('conclave-plan-inert-', (state) => {
    state.agents = [agentRow('claude', 'Claude'), agentRow('codex', 'Codex')];
    state.room.coordinatorId = 'claude';
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

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

test('proposed coordinator tasks are operator-gated: Dismiss rejects, Mark ready on a write task requires approval', async (context) => {
  const { app, started, directory, base } = await makeApp('conclave-plan-gate-', (state) => {
    state.agents = [agentRow('claude', 'Claude'), agentRow('codex', 'Codex')];
    state.room.coordinatorId = 'claude';
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const message = { id: 'msg_ask', source: 'user', sourceName: 'You', type: 'message', content: 'plan it', createdAt: new Date().toISOString() };
  await app.store.update((state) => state.messages.push(message));
  const turn = await app.createChatTurn(message, app.store.state.agents[0]);
  const plan = JSON.stringify([
    { title: 'Research approach', objective: 'obj', agentId: 'codex', accessMode: 'read-only' },
    { title: 'Apply the change', objective: 'obj', agentId: 'codex', accessMode: 'workspace-write' }
  ]);
  await app.store.update((state) => state.messages.push({
    id: 'msg_plan', source: 'claude', sourceName: 'Claude', type: 'message', chatTurnId: turn.id,
    content: `\`\`\`conclave-plan\n${plan}\n\`\`\``, createdAt: new Date().toISOString()
  }));
  await finish(app, started[0]);
  const research = app.store.state.tasks.find((task) => task.title === 'Research approach');
  const apply = app.store.state.tasks.find((task) => task.title === 'Apply the change');

  const dismissed = await post(base, `/api/tasks/${research.id}/transitions`, { to: 'rejected' });
  assert.equal(dismissed.status, 200);
  assert.equal(app.store.state.tasks.find((task) => task.id === research.id).status, 'rejected');

  const marked = await post(base, `/api/tasks/${apply.id}/transitions`, { to: 'ready' });
  assert.equal(marked.status, 200);
  const applyAfter = app.store.state.tasks.find((task) => task.id === apply.id);
  assert.equal(applyAfter.status, 'waiting', 'write proposal waits for authority');
  assert.equal(app.store.state.approvals.filter((entry) => entry.taskId === apply.id && entry.status === 'pending').length, 1);
  assert.equal(started.length, 1, 'nothing launched without the operator decision');
});
