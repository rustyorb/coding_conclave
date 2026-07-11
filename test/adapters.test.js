import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentInvocation, summarizeAgentEvent } from '../src/lib/adapters.js';

test('Codex adapter uses structured output and requested sandbox', () => {
  const run = buildAgentInvocation('codex', {
    executable: process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/tools/codex',
    prompt: 'Inspect only', workspace: process.cwd(), accessMode: 'read-only'
  });
  assert.ok(run.args.includes('--json'));
  assert.equal(run.args[run.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(run.args[run.args.indexOf('--cd') + 1], process.cwd());
  assert.equal(run.stdin, 'Inspect only');
});

test('Claude adapter maps access to permission mode without bypass flags', () => {
  const run = buildAgentInvocation('claude', {
    executable: process.platform === 'win32' ? 'C:\\tools\\claude.exe' : '/tools/claude',
    prompt: 'Review this', workspace: process.cwd(), accessMode: 'workspace-write'
  });
  assert.equal(run.args[run.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(run.args.includes('--dangerously-skip-permissions'), false);
  assert.equal(run.args[run.args.indexOf('--output-format') + 1], 'stream-json');
});

test('structured agent messages are extracted for the room feed', () => {
  const codex = summarizeAgentEvent('codex', JSON.stringify({
    type: 'item.completed', item: { type: 'agent_message', text: 'Evidence found.' }
  }));
  const claude = summarizeAgentEvent('claude', JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: 'Review complete.' }] }
  }));
  assert.equal(codex, 'Evidence found.');
  assert.equal(claude, 'Review complete.');
});
