import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessManager } from '../src/lib/process-manager.js';

test('async process event failures are reported without becoming unhandled rejections', async () => {
  let report;
  const reported = new Promise((resolve) => { report = resolve; });
  const manager = new ProcessManager({
    onEvent: async () => { throw new Error('simulated persistence failure'); },
    onEventError: (error, event) => report({ error, event })
  });

  manager.emit({ type: 'execution.output' });
  const result = await reported;

  assert.equal(result.error.message, 'simulated persistence failure');
  assert.equal(result.event.type, 'execution.output');
});

test('new execution records persist a command preview, never the full prompt argv', async () => {
  const prompt = 'PROMPT-'.repeat(1_000); // 7,000 chars riding in argv
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const manager = new ProcessManager({
    onEvent: (event) => { if (event.type === 'execution.finished') finish(event); }
  });

  const execution = manager.start({
    agentId: 'claude',
    purpose: 'preview test',
    invocation: { command: process.execPath, args: ['-e', 'process.exit(0)', prompt] },
    cwd: process.cwd()
  });
  await finished;

  const fullLength = [process.execPath, '-e', 'process.exit(0)', prompt].join(' ').length;
  assert.equal(execution.command, `${[process.execPath, '-e', 'process.exit(0)', prompt].join(' ').slice(0, 200)}… [${fullLength} chars total]`);
  assert.ok(execution.command.length < 250, 'the record holds a preview, not the prompt');
  assert.ok(execution.command.startsWith(process.execPath), 'the preview still identifies the binary');
});
