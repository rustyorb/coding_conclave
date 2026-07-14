import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { validateIdentity, IDENTITY_BLOCK } from '../src/lib/identity.js';
import { ConclaveApp, promptForChat } from '../src/server.js';

test('validateIdentity clamps and rejects', () => {
  const full = validateIdentity({ emoji: ' 🦉 ', color: '#8DE5D6', tagline: '  I test what you fear to run.  ' });
  assert.deepEqual(full, { emoji: '🦉', color: '#8de5d6', tagline: 'I test what you fear to run.' });

  assert.deepEqual(Object.keys(validateIdentity({ tagline: 'just words' })), ['tagline']);
  assert.equal(validateIdentity({ tagline: 'x'.repeat(200) }).tagline.length, 80);
  assert.equal(validateIdentity({ emoji: '🧙‍♂️🦉⚙️✨🌊🔥🌙⭐' }).emoji.length > 0, true);
  assert.equal(Array.from(validateIdentity({ emoji: 'ABCDEFGHIJKL' }).emoji).length, 8);

  for (const color of ['red', '#fff', '#12345', 'javascript:alert(1)', '#8de5d6; background:url(x)']) {
    assert.throws(() => validateIdentity({ color }), /6-digit hex/);
  }
  for (const input of [null, [], 'emoji', 42]) {
    assert.throws(() => validateIdentity(input), /JSON object/);
  }
  assert.throws(() => validateIdentity({}), /at least one/);
  assert.throws(() => validateIdentity({ emoji: '   ', tagline: '' }), /at least one/);
});

async function appWithChatReply(replyContent) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-identity-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  await app.store.update((state) => {
    state.agents = [
      { id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified', activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready' },
      { id: 'grok', name: 'Grok', provider: 'xAI', status: 'installed', connection: 'verified', activity: 'idle', executable: 'grok-fake', version: 'test', currentTaskId: null, lastAction: 'Ready' }
    ];
    state.chatTurns.unshift({ id: 'turn_1', agentId: 'codex', status: 'completed', executionId: 'exec_1' });
    state.messages.push({ id: 'msg_reply', source: 'codex', sourceName: 'Codex', type: 'message', chatTurnId: 'turn_1', content: replyContent, createdAt: new Date().toISOString() });
    app.applyIdentityBlock(state, state.chatTurns[0]);
  });
  return app;
}

test('an agent identity block restyles only that agent and is replaced in the reply', async () => {
  const reply = 'Happy to be here!\n```conclave-identity\n{"emoji": "🦉", "color": "#f7bc66", "tagline": "Night shift reviewer."}\n```';
  const app = await appWithChatReply(reply);
  const { identities, messages, audit } = app.store.state;
  assert.deepEqual(Object.keys(identities), ['codex']);
  assert.equal(identities.codex.emoji, '🦉');
  assert.equal(identities.codex.color, '#f7bc66');
  assert.equal(identities.codex.source, 'agent');
  const replyMessage = messages.find((entry) => entry.id === 'msg_reply');
  assert.doesNotMatch(replyMessage.content, IDENTITY_BLOCK);
  assert.match(replyMessage.content, /\[Updated their participant card\]/);
  assert.ok(audit.some((entry) => entry.type === 'identity.updated' && entry.agentId === 'codex'));
  assert.ok(messages.some((entry) => entry.source === 'system' && /refreshed their participant card/.test(entry.content)));
});

test('invalid identity blocks are rejected with an audited reason and no identity change', async () => {
  const reply = 'Try this.\n```conclave-identity\n{"color": "red"}\n```';
  const app = await appWithChatReply(reply);
  const { identities, audit, messages } = app.store.state;
  assert.deepEqual(identities, {});
  assert.ok(audit.some((entry) => entry.type === 'identity.invalid' && /6-digit hex/.test(entry.detail)));
  assert.ok(messages.some((entry) => /card update could not be read/.test(entry.content)));
});

test('operator identity route updates and resets; unknown agents are rejected', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-identity-http-'));
  const app = new ConclaveApp({ sessionToken: 'test-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  await app.store.update((state) => {
    state.agents = [{ id: 'codex', name: 'Codex', provider: 'OpenAI', status: 'installed', connection: 'verified', activity: 'idle', executable: 'codex-fake', version: 'test', currentTaskId: null, lastAction: 'Ready' }];
  });
  const address = await app.listen({ port: 0 });
  context.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const post = (route, body) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'test-token' }, body: JSON.stringify(body)
  });

  const set = await post('/api/agents/codex/identity', { emoji: '⚡', color: '#ffaa00', tagline: 'Operator-styled.' });
  assert.equal(set.status, 200);
  assert.equal((await set.json()).identity.source, 'operator');
  assert.equal(app.store.state.identities.codex.emoji, '⚡');

  const reset = await post('/api/agents/codex/identity', { reset: true });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).identity, null);
  assert.equal(app.store.state.identities.codex, undefined);

  const unknown = await post('/api/agents/nobody/identity', { emoji: '⚡' });
  assert.equal(unknown.status, 400);

  const untokened = await fetch(`${base}/api/agents/codex/identity`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emoji: '⚡' })
  });
  assert.equal(untokened.status, 403);
});

test('chat prompts tell agents how to restyle their card', () => {
  const state = {
    room: { workspace: 'C:\\workspace' },
    agents: [{ id: 'codex', name: 'Codex', status: 'installed' }],
    tasks: [], messages: []
  };
  const prompt = promptForChat({ id: 'm1', content: 'hello' }, state.agents[0], state);
  assert.match(prompt, /conclave-identity/);
  assert.match(prompt, /6-digit hex/);
});
