import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_DEFINITIONS, buildAgentInvocation, resolveExecutable, summarizeAgentEvent } from '../src/lib/adapters.js';

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

test('Gemini agent definition launches the gemini-adapter wrapper via Node', () => {
  const gemini = AGENT_DEFINITIONS.find((definition) => definition.id === 'gemini');
  assert.equal(gemini.command, 'node');
  const run = buildAgentInvocation('gemini', {
    executable: process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node',
    prompt: 'Check this', workspace: process.cwd(), accessMode: 'read-only'
  });
  assert.ok(run.args[0].endsWith('gemini-adapter.js'));
  assert.ok(run.args.includes('--prompt'));
  assert.ok(run.args.includes('Check this'));
});

test('resolveExecutable falls back to extra directories when the CLI is off PATH', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'conclave-agy-'));
  try {
    const executable = path.join(directory, process.platform === 'win32' ? 'agy.exe' : 'agy');
    await writeFile(executable, '');
    assert.equal(await resolveExecutable('agy', { PATH: '' }, [directory]), executable);
    assert.equal(await resolveExecutable('agy', { PATH: '' }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Grok adapter uses streaming-json output and correct permissions', () => {
  const run = buildAgentInvocation('grok', {
    executable: process.platform === 'win32' ? 'C:\\tools\\grok.exe' : '/tools/grok',
    prompt: 'Check this out', workspace: process.cwd(), accessMode: 'workspace-write'
  });
  assert.ok(run.args.includes('-p'));
  assert.equal(run.args[run.args.indexOf('-p') + 1], 'Check this out');
  assert.equal(run.args[run.args.indexOf('--output-format') + 1], 'streaming-json');
  assert.equal(run.args[run.args.indexOf('--permission-mode') + 1], 'acceptEdits');
});

test('structured agent messages are extracted for the room feed', () => {
  const codex = summarizeAgentEvent('codex', JSON.stringify({
    type: 'item.completed', item: { type: 'agent_message', text: 'Evidence found.' }
  }));
  const claude = summarizeAgentEvent('claude', JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: 'Review complete.' }] }
  }));
  const grokText1 = summarizeAgentEvent('grok', JSON.stringify({ type: 'text', data: 'Part 1' }));
  const grokText2 = summarizeAgentEvent('grok', JSON.stringify({ type: 'text', data: ' Part 2' }));
  const grokEnd = summarizeAgentEvent('grok', JSON.stringify({ type: 'end', stopReason: 'EndTurn' }));
  assert.equal(codex, 'Evidence found.');
  assert.equal(claude, 'Review complete.');
  assert.equal(grokText1, null);
  assert.equal(grokText2, null);
  assert.equal(grokEnd, 'Part 1 Part 2');
});
