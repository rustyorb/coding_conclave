import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AGENT_DEFINITIONS,
  buildAgentInvocation,
  buildDeclaredCapabilityProfile,
  capabilityLabelsFor,
  flushAgentSummary,
  resolveExecutable,
  summarizeAgentEvent
} from '../src/lib/adapters.js';

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

test('Gemini agent definition launches the Antigravity CLI with mode mapped from access', () => {
  const gemini = AGENT_DEFINITIONS.find((definition) => definition.id === 'gemini');
  assert.equal(gemini.command, 'agy');
  const readOnly = buildAgentInvocation('gemini', {
    executable: 'agy', prompt: 'Check this', workspace: process.cwd(), accessMode: 'read-only'
  });
  assert.ok(readOnly.args.includes('-p'));
  assert.ok(readOnly.args.includes('Check this'));
  assert.deepEqual(readOnly.args.slice(readOnly.args.indexOf('--mode'), readOnly.args.indexOf('--mode') + 2), ['--mode', 'plan']);
  const write = buildAgentInvocation('gemini', {
    executable: 'agy', prompt: 'Fix it', workspace: process.cwd(), accessMode: 'workspace-write'
  });
  assert.ok(write.args.includes('accept-edits'));
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

test('a cancelled Grok stream cannot contaminate the next reply', () => {
  const options = {
    executable: process.platform === 'win32' ? 'C:\\tools\\grok.exe' : '/tools/grok',
    workspace: process.cwd(), accessMode: 'read-only'
  };
  buildAgentInvocation('grok', { ...options, prompt: 'Cancelled run' });
  assert.equal(summarizeAgentEvent('grok', JSON.stringify({ type: 'text', data: 'CANCELLED_PART|' })), null);

  // Cancellation means the first run never emits `end`. Building the next run
  // must discard its abandoned partial text before new stream events arrive.
  buildAgentInvocation('grok', { ...options, prompt: 'Next run' });
  assert.equal(summarizeAgentEvent('grok', JSON.stringify({ type: 'text', data: 'NEXT_REPLY' })), null);
  const nextReply = summarizeAgentEvent('grok', JSON.stringify({ type: 'end', stopReason: 'EndTurn' }));

  assert.equal(nextReply, 'NEXT_REPLY');
  assert.doesNotMatch(nextReply, /CANCELLED_PART/);
});

test('building a Grok approval preview does not reset an active stream', () => {
  const options = {
    executable: process.platform === 'win32' ? 'C:\\tools\\grok.exe' : '/tools/grok',
    workspace: process.cwd(), accessMode: 'workspace-write'
  };
  buildAgentInvocation('grok', { ...options, prompt: 'Active run' });
  summarizeAgentEvent('grok', JSON.stringify({ type: 'text', data: 'ACTIVE_PART' }));

  buildAgentInvocation('grok', { ...options, prompt: 'Approval preview', resetSummary: false });

  assert.equal(flushAgentSummary('grok'), 'ACTIVE_PART');
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

test('agent definitions expose structured declaredCapabilities without removing legacy labels', () => {
  for (const definition of AGENT_DEFINITIONS) {
    assert.ok(Array.isArray(definition.declaredCapabilities));
    assert.ok(definition.declaredCapabilities.some((entry) => entry.key === 'conversation.stream'));
    assert.ok(definition.probeSupport['P-detect']);
    assert.ok(definition.probeSupport['P-stream']);
    const labels = capabilityLabelsFor(definition);
    assert.ok(labels.includes('repository inspection'));
    const profile = buildDeclaredCapabilityProfile(definition);
    assert.equal(profile.capabilities['conversation.stream'].confidence, 'declared');
  }
  const gemini = AGENT_DEFINITIONS.find((definition) => definition.id === 'gemini');
  assert.equal(gemini.probeSupport['P-agy-mcp'], true);
  assert.equal(gemini.command, 'agy');
});
