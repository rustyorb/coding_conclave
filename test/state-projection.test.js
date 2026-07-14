import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConclaveApp } from '../src/server.js';

async function makeApp(prefix, seed) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const app = new ConclaveApp({ workspace: directory, storeFile: path.join(directory, '.state', 'state.json') });
  await app.initialize();
  if (seed) await app.store.update(seed);
  app.processes.start = () => { throw new Error('no real processes in this test'); };
  const address = await app.listen({ port: 0 });
  return { app, directory, base: `http://127.0.0.1:${address.port}` };
}

const executionRow = (id, output, status = 'completed') => ({
  id, taskId: null, agentId: 'codex', kind: 'agent', purpose: 'test run', command: 'codex-fake', cwd: 'C:\\ws',
  status, exitCode: status === 'running' ? null : 0, signal: null, output,
  startedAt: new Date().toISOString(), finishedAt: status === 'running' ? null : new Date().toISOString()
});

test('GET /api/state projects executions without output, with outputSize and a 500-char tail', async (context) => {
  const bigOutput = 'x'.repeat(4_500) + 'TAIL-'.repeat(100); // 5,000 chars; last 500 are TAIL-…
  const { app, directory, base } = await makeApp('conclave-projection-', (state) => {
    state.executions.unshift(executionRow('exec_big', bigOutput));
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const state = await (await fetch(`${base}/api/state`)).json();
  const projected = state.executions.find((entry) => entry.id === 'exec_big');
  assert.ok(projected, 'execution is listed');
  assert.equal('output' in projected, false, 'full output is stripped from /api/state');
  assert.equal(projected.outputSize, 5_000);
  assert.equal(projected.outputTail, bigOutput.slice(-500));
  assert.equal(projected.outputTail.length, 500);
  assert.equal(projected.status, 'completed');
  assert.equal(projected.agentId, 'codex');
  assert.equal(projected.command, 'codex-fake');
  assert.equal(state.executionsTotal, 1);
  assert.equal(
    app.store.state.executions.find((entry) => entry.id === 'exec_big').output,
    bigOutput,
    'the internal store keeps the full output'
  );
});

test('GET /api/executions/:id/output returns the full stored output; unknown ids error', async (context) => {
  const bigOutput = 'line\n'.repeat(2_000);
  const { app, directory, base } = await makeApp('conclave-output-route-', (state) => {
    state.executions.unshift(executionRow('exec_full', bigOutput, 'running'));
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const response = await fetch(`${base}/api/executions/exec_full/output`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { id: 'exec_full', status: 'running', outputSize: bigOutput.length, output: bigOutput });

  const missing = await fetch(`${base}/api/executions/exec_nope/output`);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, 'Execution not found');
});

test('GET /api/state caps the projection at the 200 most recent executions', async (context) => {
  const { app, directory, base } = await makeApp('conclave-cap-', (state) => {
    for (let index = 0; index <= 204; index += 1) {
      state.executions.unshift(executionRow(`exec_${index}`, `output ${index}`));
    }
  });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.executions.length, 200);
  assert.equal(state.executionsTotal, 205);
  assert.equal(state.executions[0].id, 'exec_204', 'the newest execution stays first');
  assert.equal(state.executions.at(-1).id, 'exec_5', 'the oldest five fall off the projection');
  assert.equal(app.store.state.executions.length, 205, 'the internal store keeps every execution');
});
