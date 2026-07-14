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
