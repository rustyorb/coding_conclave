import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';

test('FR item 10: mutating routes require the session token; reads and the tokened cookie flow work', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-auth-'));
  const app = new ConclaveApp({ sessionToken: 'secret-token', workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  // Reads stay open on loopback.
  assert.equal((await fetch(`${base}/api/state`)).status, 200);

  // A local process without the token cannot mutate — the exact escalation both
  // reviews flagged (policy, approvals, roles, messages).
  for (const route of ['/api/messages', '/api/policy', '/api/roles', '/api/room/pause']) {
    const blocked = await fetch(`${base}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(blocked.status, 403, `${route} must refuse without a token`);
    assert.match((await blocked.json()).error, /Session token/);
  }
  assert.equal(app.store.state.room.paused, false);

  // The wrong token is refused; the right header is accepted.
  const wrong = await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'guess' },
    body: JSON.stringify({ content: 'nope' })
  });
  assert.equal(wrong.status, 403);
  const right = await fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-conclave-token': 'secret-token' },
    body: JSON.stringify({ content: 'hello with header' })
  });
  assert.equal(right.status, 201);

  // Browser flow: visiting the tokened URL sets the HttpOnly cookie…
  const page = await fetch(`${base}/?token=secret-token`);
  const cookie = page.headers.get('set-cookie');
  assert.ok(cookie?.includes('conclave_token=secret-token'), 'tokened visit binds the session');
  assert.ok(cookie.includes('HttpOnly'));
  // …a wrong token sets nothing…
  const badPage = await fetch(`${base}/?token=guess`);
  assert.equal(badPage.headers.get('set-cookie'), null);
  // …and the cookie then authorizes same-origin mutations.
  const viaCookie = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'conclave_token=secret-token' },
    body: JSON.stringify({ content: 'hello with cookie' })
  });
  assert.equal(viaCookie.status, 201);
  assert.equal(app.store.state.messages.filter((entry) => entry.source === 'user').length, 2);
});
