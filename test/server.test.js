import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearAgentSummary, flushAgentSummary, summarizeAgentEvent } from '../src/lib/adapters.js';
import { ConclaveApp, promptForChat, promptForTask, transcriptLines } from '../src/server.js';

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('HTTP API persists chat and requires a decision before command execution', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-api-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const messageResponse = await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' }, body: JSON.stringify({ content: 'Human checkpoint' })
  });
  assert.equal(messageResponse.status, 201);
  assert.equal((await messageResponse.json()).tasksCreated, 0);

  const commandResponse = await fetch(`${base}/api/commands`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' },
    body: JSON.stringify({ command: 'node --version', purpose: 'Verify Node' })
  });
  assert.equal(commandResponse.status, 201);
  const approval = await commandResponse.json();
  assert.equal(app.processes.running.size, 0);
  assert.equal(approval.status, 'pending');

  const decisionResponse = await fetch(`${base}/api/approvals/${approval.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' }, body: JSON.stringify({ decision: 'denied' })
  });
  assert.equal(decisionResponse.status, 200);
  assert.equal((await decisionResponse.json()).status, 'denied');
  assert.equal(app.processes.running.size, 0);

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.ok(state.messages.some((message) => message.content === 'Human checkpoint'));
  assert.equal(state.approvals[0].status, 'denied');
});

test('FR-CHAT-004/FR-POL-009: recipient messages create chat turns, never tasks, and write access requests are ignored', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-recipients-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  await app.store.update((state) => {
    state.agents = [{
      id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified',
      activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready'
    }];
  });
  const started = [];
  app.processes.start = ({ taskId, agentId, kind, invocation }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind, purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push({ execution, accessMode: invocation.accessMode });
    return execution;
  };
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const response = await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' },
    body: JSON.stringify({ content: 'Review the composer flow', agentIds: ['codex'], accessMode: 'workspace-write' })
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.tasksCreated, 0);
  assert.equal(body.chatTurnsCreated, 1);
  assert.equal(app.store.state.tasks.length, 0);
  assert.equal(app.store.state.approvals.length, 0);
  await waitFor(() => started.length === 1, 'the asynchronous queue drainer should launch the reply');
  const turn = app.store.state.chatTurns[0];
  assert.equal(turn.agentId, 'codex');
  assert.equal(turn.status, 'active');
  assert.equal(started.length, 1);
});

test('process output broadcasts a lightweight change signal after persistence', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-events-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const payloads = [];
  app.clients.add({ write: (payload) => payloads.push(payload), end: () => {} });
  app.store.state.executions.push({ id: 'exec_test', output: '' });

  await app.onProcessEvent({
    type: 'execution.output', executionId: 'exec_test', taskId: 'task_test', agentId: 'codex',
    stream: 'stdout', line: 'large private output that clients do not need', createdAt: new Date().toISOString()
  });

  assert.equal(app.store.state.executions[0].output.includes('large private output'), true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].includes('large private output'), false);
  assert.equal(JSON.parse(payloads[0].slice(6)).type, 'state.changed');
});

test('output bursts batch behind one write while a message and all requested replies commit atomically', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-chat-admission-'));
  const app = new ConclaveApp({
    sessionToken: 'test-token', workspace: directory,
    storeFile: path.join(directory, '.state', 'state.json'),
    processOutputFlushMs: 60_000, summaryDebounceMs: 60_000
  });
  await app.initialize();
  await app.store.update((state) => {
    state.agents = ['codex', 'claude'].map((agentId) => ({
      id: agentId, name: agentId === 'codex' ? 'Codex' : 'Claude', provider: 'test',
      status: 'installed', connection: 'verified', activity: 'running',
      executable: `${agentId}-fake`, version: 'test', currentTaskId: `task_${agentId}`, lastAction: 'Busy'
    }));
    state.executions.unshift({
      id: 'exec_burst', kind: 'agent', taskId: 'task_codex', agentId: 'codex',
      purpose: '', command: '', cwd: directory, status: 'running', exitCode: null,
      output: '', startedAt: new Date().toISOString(), finishedAt: null
    });
  });
  const saves = [];
  app.store.save = async () => { saves.push(app.store.snapshot()); };
  let releaseDrain;
  const heldDrain = new Promise((resolve) => { releaseDrain = resolve; });
  let drainCalls = 0;
  app.startQueuedTasks = () => { drainCalls += 1; return heldDrain; };
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    releaseDrain();
    await app.flushProcessOutput();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const pendingOutput = Array.from({ length: 40 }, (_, index) => app.onProcessEvent({
    type: 'execution.output', executionId: 'exec_burst', taskId: 'task_codex', agentId: 'codex',
    stream: 'stdout', line: `line-${index}`, createdAt: new Date().toISOString()
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.length, 0, 'buffered output does not enqueue one durable write per line');

  const response = await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' },
    body: JSON.stringify({ content: 'Please both reply in recipient order.', agentIds: ['codex', 'claude'] })
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.chatTurnsCreated, 2);
  assert.equal(drainCalls, 1, 'the response is complete even while the drainer is still held');
  assert.equal(saves.length, 2, 'one output-batch write precedes one atomic message-admission write');
  assert.deepEqual(saves[1].chatTurns.slice(0, 2).map((turn) => turn.agentId), ['codex', 'claude']);
  assert.ok(saves[1].chatTurns.slice(0, 2).every((turn) => turn.messageId === body.message.id));
  const lastOutputSequence = Math.max(...saves[1].audit
    .filter((entry) => entry.type === 'execution.output')
    .map((entry) => entry.seq));
  assert.ok(lastOutputSequence < body.message.seq, 'pre-existing output remains ordered before the operator message');

  releaseDrain();
  await app.flushProcessOutput();
  await Promise.all(pendingOutput);
  assert.equal(saves.length, 2, 'the entire output burst required only one durable commit');
  assert.equal(
    app.store.state.executions.find((entry) => entry.id === 'exec_burst').output,
    `${Array.from({ length: 40 }, (_, index) => `line-${index}`).join('\n')}\n`,
    'line order survives batching'
  );
});

test('execution finish flushes every buffered output line before the lifecycle record', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-output-finish-'));
  const app = new ConclaveApp({
    sessionToken: 'test-token', workspace: directory,
    storeFile: path.join(directory, '.state', 'state.json'),
    processOutputFlushMs: 60_000, summaryDebounceMs: 60_000
  });
  await app.initialize();
  await app.store.update((state) => {
    state.executions.unshift({
      id: 'exec_finish_flush', kind: 'command', taskId: null, agentId: null,
      purpose: '', command: '', cwd: directory, status: 'running', exitCode: null,
      output: '', startedAt: new Date().toISOString(), finishedAt: null
    });
  });
  await app.listen({ port: 0 });
  context.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const pendingOutput = ['first', 'second', 'third'].map((line) => app.onProcessEvent({
    type: 'execution.output', executionId: 'exec_finish_flush', taskId: null, agentId: null,
    stream: 'stdout', line, createdAt: new Date().toISOString()
  }));
  await app.onProcessEvent({
    type: 'execution.finished', executionId: 'exec_finish_flush', taskId: null, agentId: null,
    exitCode: 0, signal: null, status: 'completed', finishedAt: new Date().toISOString()
  });
  await Promise.all(pendingOutput);

  const execution = app.store.state.executions.find((entry) => entry.id === 'exec_finish_flush');
  assert.equal(execution.output, 'first\nsecond\nthird\n');
  assert.equal(execution.status, 'completed');
  const events = app.store.state.audit.filter((entry) => entry.executionId === execution.id);
  assert.deepEqual(events.map((entry) => entry.type), [
    'execution.output', 'execution.output', 'execution.output', 'execution.finished'
  ]);
  assert.ok(events[2].seq < events[3].seq, 'the durable finish follows every output event');
});

test('cancelling a Grok execution discards buffered and late stream text', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-grok-cancel-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  context.after(async () => {
    clearAgentSummary('grok');
    await rm(directory, { recursive: true, force: true });
  });
  app.store.state.executions.push({
    id: 'exec_grok_cancel', kind: 'chat', taskId: null, agentId: 'grok', output: '', status: 'running'
  });

  clearAgentSummary('grok');
  summarizeAgentEvent('grok', JSON.stringify({ type: 'text', data: 'CANCELLED_PART|' }));
  await app.onProcessEvent({
    type: 'execution.cancelling', executionId: 'exec_grok_cancel', reason: 'user', createdAt: new Date().toISOString()
  });
  assert.equal(flushAgentSummary('grok'), null);

  // The child can still drain a final line after cancellation begins. The
  // cancelled finish must discard it rather than publishing or retaining it.
  summarizeAgentEvent('grok', JSON.stringify({ type: 'text', data: 'LATE_CANCELLED_PART|' }));
  await app.onProcessEvent({
    type: 'execution.finished', executionId: 'exec_grok_cancel', taskId: null, agentId: 'grok',
    exitCode: 1, signal: null, reason: 'user', status: 'cancelled', finishedAt: new Date().toISOString()
  });

  assert.equal(flushAgentSummary('grok'), null);
  assert.equal(app.store.state.messages.some((message) => message.content.includes('CANCELLED_PART')), false);
});

test('agent prompts share teammate status, room activity, and the coordination protocol', () => {
  const state = {
    room: { workspace: 'C:\\workspace' },
    agents: [
      { id: 'claude', name: 'Claude', status: 'installed', activity: 'idle', currentTaskId: null },
      { id: 'codex', name: 'Codex', status: 'installed', activity: 'running', currentTaskId: 'task_1' },
      { id: 'gemini', name: 'Gemini', status: 'unavailable', activity: 'idle', currentTaskId: null }
    ],
    tasks: [{ id: 'task_1', title: 'Refactor adapters' }],
    messages: [{ sourceName: 'Codex', content: 'Handoff: adapters refactored, npm test passes.' }]
  };
  const prompt = promptForTask({ title: 'T', objective: 'O', accessMode: 'workspace-write' }, state.agents[0], state);
  assert.match(prompt, /Codex: running on “Refactor adapters”/);
  assert.match(prompt, /Handoff: adapters refactored, npm test passes\./);
  assert.match(prompt, /COORDINATION\.md/);
  assert.doesNotMatch(prompt, /Gemini/);
  assert.ok(prompt.split('\n').includes('O'), 'a distinct objective is included');

  const duplicated = promptForTask({ title: 'SAME', objective: 'SAME', accessMode: 'read-only' }, state.agents[0], state);
  assert.ok(!duplicated.split('\n').includes('SAME'), 'objective identical to the title is not repeated');
  assert.match(duplicated, /Task: SAME/);
});

test('chat prompts carry deep budgeted room history with type labels', () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `msg_${index}`, sourceName: `Agent${index}`, type: index === 20 ? 'blocker' : 'message',
    content: `note ${index} ${'x'.repeat(120)}`
  }));
  const state = {
    room: { workspace: 'C:\\workspace' },
    agents: [{ id: 'claude', name: 'Claude', status: 'installed' }],
    tasks: [],
    messages
  };
  const prompt = promptForChat({ id: 'msg_39', content: 'latest' }, state.agents[0], state);
  assert.match(prompt, /note 15 /, 'history reaches deeper than the old 11-message window');
  assert.match(prompt, /- Agent20 \[blocker\]:/, 'non-chat messages are labeled with their type');
  assert.doesNotMatch(prompt, /- Agent39/, 'the message being answered is not duplicated into history');
  assert.doesNotMatch(prompt, /pruned to fit the context budget/, 'no pruning marker when everything fits');

  const flooded = { ...state, messages: messages.map((entry) => ({ ...entry, content: 'y'.repeat(5_000) })) };
  const lines = transcriptLines(flooded, { limit: 30, clamp: 600, budget: 9_000 });
  assert.ok(lines.length >= 1, 'at least one line survives even when every message is huge');
  assert.ok(lines.join('\n').length <= 9_800, `history respects the budget (got ${lines.join('\n').length})`);
});

test('task prompts budget their room-activity history', () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `msg_${index}`, sourceName: `Agent${index}`, type: 'message', content: 'y'.repeat(5_000)
  }));
  const state = {
    room: { workspace: 'C:\\workspace' },
    agents: [{ id: 'claude', name: 'Claude', status: 'installed', activity: 'idle', currentTaskId: null }],
    tasks: [], messages
  };
  const prompt = promptForTask({ title: 'T', objective: 'O', accessMode: 'read-only' }, state.agents[0], state);
  const history = prompt.slice(prompt.indexOf('Recent room activity'), prompt.indexOf('Coordinate through the workspace'));
  assert.ok(history.length <= 5_800, `history stays near the 5K budget (got ${history.length})`);
  assert.match(prompt, /- Agent39/, 'the newest message is always included');
  assert.doesNotMatch(prompt, /- Agent20:/, 'messages beyond the budget are dropped');
  assert.match(prompt, /- \[\d+ earlier messages pruned to fit the context budget\]/, 'pruned history is disclosed');
});

test('chat turns run read-only, resolve on completion, and never touch the task board', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-chat-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  await app.store.update((state) => {
    state.agents = [{
      id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified',
      activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready'
    }];
  });
  const started = [];
  app.processes.start = ({ taskId, agentId, kind }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind, purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push(execution);
    return execution;
  };
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const response = await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' },
    body: JSON.stringify({ content: 'are you alive? just checking in on the room today.', agentIds: ['codex'] })
  });
  assert.equal(response.status, 201);
  assert.equal(app.store.state.tasks.length, 0);
  await waitFor(() => started.length === 1, 'the asynchronous queue drainer should launch the reply');
  const turn = app.store.state.chatTurns[0];
  assert.equal(turn.status, 'active');
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, 'chat');
  assert.equal(started[0].taskId, null);

  await app.onProcessEvent({
    type: 'execution.finished', executionId: started[0].id, taskId: null, agentId: 'codex',
    exitCode: 0, signal: null, status: 'completed', finishedAt: new Date().toISOString()
  });
  const finished = app.store.state.chatTurns.find((entry) => entry.id === turn.id);
  assert.equal(finished.status, 'completed');
  assert.equal(app.store.state.tasks.length, 0);
  assert.equal(app.store.state.agents[0].activity, 'idle');
});

test('one run per agent: a second task for a busy agent queues and starts after the first finishes', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-agent-lock-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await app.store.update((state) => {
    state.agents = [{
      id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified',
      activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready'
    }];
  });
  const started = [];
  app.processes.start = ({ taskId, agentId }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind: 'agent', purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push(execution);
    return execution;
  };

  const first = await app.createTask({ title: 'Inspect A', objective: 'obj A', agentId: 'codex', accessMode: 'read-only' });
  const second = await app.createTask({ title: 'Inspect B', objective: 'obj B', agentId: 'codex', accessMode: 'read-only' });

  assert.equal(started.length, 1);
  assert.equal(app.store.state.tasks.find((entry) => entry.id === first.id).status, 'active');
  assert.equal(app.store.state.tasks.find((entry) => entry.id === second.id).status, 'ready');
  assert.ok(app.store.state.messages.some((message) => message.content.includes('Queued “Inspect B” until Codex finishes “Inspect A”')));

  await app.onProcessEvent({
    type: 'execution.finished', executionId: started[0].id, taskId: first.id, agentId: 'codex',
    exitCode: 0, signal: null, status: 'completed', finishedAt: new Date().toISOString()
  });

  assert.equal(started.length, 2);
  assert.equal(started[1].taskId, second.id);
  assert.equal(app.store.state.tasks.find((entry) => entry.id === second.id).status, 'active');
});

test('queued chats keep FIFO order and run before an older task re-enters through auto-retry', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-chat-fairness-'));
  const app = new ConclaveApp({
    sessionToken: 'test-token', workspace: directory,
    storeFile: path.join(directory, '.state', 'state.json'), summaryDebounceMs: 60_000
  });
  await app.initialize();
  const taskCreatedAt = '2026-01-01T00:00:00.000Z';
  const firstChatAt = '2026-01-01T00:01:00.000Z';
  const secondChatAt = '2026-01-01T00:02:00.000Z';
  await app.store.update((state) => {
    state.policy.enabled = true;
    state.policy.autoRetry = { enabled: true, maxAttempts: 2 };
    state.agents = [{
      id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified',
      activity: 'running', executable: 'codex-fake', version: 'test', currentTaskId: 'task_retry', lastAction: 'Running old task'
    }];
    state.tasks.unshift({
      id: 'task_retry', title: 'Old retrying task', objective: 'Eventually retry', agentId: 'codex',
      accessMode: 'read-only', priority: 'high', origin: 'operator', source: null, archivedAt: null,
      status: 'active', dependencies: [], attempts: 0, blocker: null, executionId: 'exec_retry',
      createdAt: taskCreatedAt, updatedAt: taskCreatedAt
    });
    state.executions.unshift({
      id: 'exec_retry', kind: 'agent', taskId: 'task_retry', agentId: 'codex', purpose: '',
      command: '', cwd: directory, status: 'running', exitCode: null, output: '',
      startedAt: taskCreatedAt, finishedAt: null
    });
    state.messages.push(
      { id: 'msg_first', source: 'user', sourceName: 'You', type: 'message', content: 'first queued chat', createdAt: firstChatAt },
      { id: 'msg_second', source: 'user', sourceName: 'You', type: 'message', content: 'second queued chat', createdAt: secondChatAt }
    );
    // Newest-first storage order intentionally disagrees with FIFO.
    state.chatTurns.unshift(
      { id: 'chat_second', messageId: 'msg_second', agentId: 'codex', status: 'queued', blocker: null, executionId: null, retryOf: null, recipientIndex: 0, createdAt: secondChatAt, updatedAt: secondChatAt },
      { id: 'chat_first', messageId: 'msg_first', agentId: 'codex', status: 'queued', blocker: null, executionId: null, retryOf: null, recipientIndex: 0, createdAt: firstChatAt, updatedAt: firstChatAt }
    );
  });
  const started = [];
  app.processes.start = (input) => {
    const execution = {
      id: `exec_started_${started.length}`, taskId: input.taskId, agentId: input.agentId, kind: input.kind || 'agent',
      purpose: input.purpose, command: '', cwd: directory, status: 'running', exitCode: null,
      output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push({ input, execution });
    return execution;
  };
  await app.listen({ port: 0 });
  context.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  await app.onProcessEvent({
    type: 'execution.finished', executionId: 'exec_retry', taskId: 'task_retry', agentId: 'codex',
    exitCode: 1, signal: null, status: 'failed', finishedAt: '2026-01-01T00:03:00.000Z'
  });
  assert.equal(started[0].execution.kind, 'chat');
  assert.equal(started[0].input.purpose, 'first queued chat');
  assert.equal(app.store.state.tasks.find((entry) => entry.id === 'task_retry').status, 'ready');

  await app.onProcessEvent({
    type: 'execution.finished', executionId: started[0].execution.id, taskId: null, agentId: 'codex',
    exitCode: 0, signal: null, status: 'completed', finishedAt: '2026-01-01T00:04:00.000Z'
  });
  assert.equal(started[1].execution.kind, 'chat');
  assert.equal(started[1].input.purpose, 'second queued chat');

  await app.onProcessEvent({
    type: 'execution.finished', executionId: started[1].execution.id, taskId: null, agentId: 'codex',
    exitCode: 0, signal: null, status: 'completed', finishedAt: '2026-01-01T00:05:00.000Z'
  });
  assert.equal(started[2].execution.kind, 'agent');
  assert.equal(started[2].input.taskId, 'task_retry');
});

test('blocked tasks can be requeued through the API and start again', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-requeue-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  await app.store.update((state) => {
    state.agents = [{
      id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified',
      activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready'
    }];
    state.tasks.unshift({
      id: 'task_blocked', title: 'Revive me', objective: 'obj', agentId: 'codex', accessMode: 'read-only',
      origin: 'operator', status: 'blocked', blocker: 'Conclave restarted while this task was queued.',
      dependencies: [], executionId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
  });
  const started = [];
  app.processes.start = ({ taskId, agentId }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind: 'agent', purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push(execution);
    return execution;
  };
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const response = await fetch(`${base}/api/tasks/task_blocked/requeue`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' }, body: '{}'
  });
  assert.equal(response.status, 200);
  const task = app.store.state.tasks.find((entry) => entry.id === 'task_blocked');
  assert.equal(task.status, 'active');
  assert.equal(task.blocker, null);
  assert.equal(started.length, 1);
  assert.equal(started[0].taskId, 'task_blocked');

  const rejected = await fetch(`${base}/api/tasks/task_blocked/requeue`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' }, body: '{}'
  });
  assert.equal(rejected.status, 400);
});

test('workspace-write runs are serialized: second writer queues and starts after the first finishes', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-lock-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await app.store.update((state) => {
    state.agents = [
      { id: 'claude', name: 'Claude', status: 'installed', connection: 'verified', activity: 'idle', executable: 'claude-fake', currentTaskId: null },
      { id: 'codex', name: 'Codex', status: 'installed', connection: 'verified', activity: 'idle', executable: 'codex-fake', currentTaskId: null }
    ];
  });
  const started = [];
  app.processes.start = ({ taskId, agentId }) => {
    const execution = {
      id: `exec_fake_${started.length}`, taskId, agentId, kind: 'agent', purpose: '', command: '', cwd: directory,
      status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null
    };
    started.push(execution);
    return execution;
  };

  const first = await app.createTask({ title: 'Write A', objective: 'obj A', agentId: 'claude', accessMode: 'workspace-write' });
  const second = await app.createTask({ title: 'Write B', objective: 'obj B', agentId: 'codex', accessMode: 'workspace-write' });
  await app.decideApproval(app.store.state.approvals.find((entry) => entry.taskId === first.id).id, 'approved');
  await app.decideApproval(app.store.state.approvals.find((entry) => entry.taskId === second.id).id, 'approved');

  assert.equal(started.length, 1);
  assert.equal(app.store.state.tasks.find((entry) => entry.id === first.id).status, 'active');
  assert.equal(app.store.state.tasks.find((entry) => entry.id === second.id).status, 'ready');
  assert.ok(app.store.state.messages.some((message) => message.content.includes('Queued “Write B”')));

  await app.onProcessEvent({
    type: 'execution.finished', executionId: started[0].id, taskId: first.id, agentId: 'claude',
    exitCode: 0, signal: null, status: 'completed', finishedAt: new Date().toISOString()
  });

  assert.equal(started.length, 2);
  assert.equal(started[1].taskId, second.id);
  assert.equal(app.store.state.tasks.find((entry) => entry.id === second.id).status, 'active');
});
