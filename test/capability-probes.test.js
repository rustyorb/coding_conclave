import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTER_PROFILE_VERSION,
  AGENT_DEFINITIONS,
  STREAM_PROBE_TOKEN,
  applyProbeResult,
  buildDeclaredCapabilityProfile,
  buildPStreamInvocation,
  capabilityLabelsFor,
  runLocalCapabilityProbes,
  runPAgyMcp,
  runPDetect,
  scorePStream
} from '../src/lib/adapters.js';

test('declared capability profiles use structured keys at confidence declared', () => {
  for (const definition of AGENT_DEFINITIONS) {
    const profile = buildDeclaredCapabilityProfile(definition, { cliVersion: 'test-1' });
    assert.equal(profile.adapterVersion, ADAPTER_PROFILE_VERSION);
    assert.equal(profile.cliVersion, 'test-1');
    assert.equal(profile.probedAt, null);
    assert.ok(profile.capabilities['conversation.stream']);
    assert.equal(profile.capabilities['conversation.stream'].confidence, 'declared');
    // Legacy labels remain available without claiming verification.
    assert.ok(capabilityLabelsFor(definition).length >= 4);
    assert.equal(definition.probeSupport['P-detect'], true);
    assert.equal(definition.probeSupport['P-stream'], true);
  }
});

test('gemini declares MCP unsupported without a live probe', () => {
  const gemini = AGENT_DEFINITIONS.find((entry) => entry.id === 'gemini');
  const profile = buildDeclaredCapabilityProfile(gemini);
  assert.equal(profile.capabilities['mcp.inventory'].confidence, 'unsupported');
  assert.equal(profile.capabilities['mcp.configured'].confidence, 'unsupported');
  assert.equal(profile.capabilities['structured.output'].confidence, 'unsupported');
  assert.equal(gemini.probeSupport['P-agy-mcp'], true);
  // Codex/Claude/Grok keep MCP as declared until inventory probes run (phase 2).
  const codex = buildDeclaredCapabilityProfile(AGENT_DEFINITIONS.find((entry) => entry.id === 'codex'));
  assert.equal(codex.capabilities['mcp.inventory'].confidence, 'declared');
});

test('P-detect reports missing CLI and installed executable', async () => {
  const definition = AGENT_DEFINITIONS.find((entry) => entry.id === 'codex');
  const missing = await runPDetect(definition, {
    resolve: async () => null
  });
  assert.equal(missing.probeId, 'P-detect');
  assert.equal(missing.pass, false);
  assert.equal(missing.code, 'PROBE_DETECT_NOT_FOUND');

  const found = await runPDetect(definition, {
    resolve: async () => '/tools/codex',
    getVersionFn: async () => 'codex-cli 9.9.9'
  });
  assert.equal(found.pass, true);
  assert.equal(found.executable, '/tools/codex');
  assert.equal(found.version, 'codex-cli 9.9.9');
});

test('P-stream scores JSONL agents when PROBE_OK appears in summarized text', () => {
  const codexLines = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: STREAM_PROBE_TOKEN } })
  ];
  const codex = scorePStream('codex', codexLines);
  assert.equal(codex.probeId, 'P-stream');
  assert.equal(codex.pass, true);
  assert.equal(codex.keys['conversation.stream'].confidence, 'verified');
  assert.equal(codex.keys['structured.output'].confidence, 'verified');

  const claudeLines = [
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `here is ${STREAM_PROBE_TOKEN}` }] }
    })
  ];
  const claude = scorePStream('claude', claudeLines);
  assert.equal(claude.pass, true);
  assert.equal(claude.keys['conversation.stream'].confidence, 'verified');

  const grokLines = [
    JSON.stringify({ type: 'text', data: 'PROBE_' }),
    JSON.stringify({ type: 'text', data: 'OK' }),
    JSON.stringify({ type: 'end', stopReason: 'EndTurn' })
  ];
  const grok = scorePStream('grok', grokLines);
  assert.equal(grok.pass, true);
  assert.equal(grok.keys['conversation.stream'].confidence, 'verified');
});

test('P-stream fails when the token is absent and never upgrades declared write keys', () => {
  const failed = scorePStream('codex', [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } })
  ]);
  assert.equal(failed.pass, false);
  assert.equal(failed.keys['conversation.stream'].confidence, 'failed');
  assert.equal(failed.keys['conversation.stream'].code, 'PROBE_STREAM_MISSING_TOKEN');
  assert.equal(failed.keys['filesystem.write'], undefined);

  const profile = buildDeclaredCapabilityProfile(AGENT_DEFINITIONS.find((entry) => entry.id === 'codex'));
  applyProbeResult(profile, failed);
  assert.equal(profile.capabilities['conversation.stream'].confidence, 'failed');
  assert.equal(profile.capabilities['filesystem.write'].confidence, 'declared');
});

test('P-stream treats gemini plain text as stream-capable and structured.output unsupported', () => {
  const ok = scorePStream('gemini', ['noise', STREAM_PROBE_TOKEN, 'more']);
  assert.equal(ok.pass, true);
  assert.equal(ok.keys['conversation.stream'].confidence, 'verified');
  assert.equal(ok.keys['structured.output'].confidence, 'unsupported');
});

test('buildPStreamInvocation uses the probe prompt in read-only mode', () => {
  const run = buildPStreamInvocation('grok', {
    executable: process.platform === 'win32' ? 'C:\\tools\\grok.exe' : '/tools/grok',
    workspace: process.cwd()
  });
  assert.ok(run.args.includes('Reply with exactly: PROBE_OK') || run.stdin === 'Reply with exactly: PROBE_OK'
    || run.args.includes(`Reply with exactly: ${STREAM_PROBE_TOKEN}`));
  // Grok puts prompt after -p.
  const promptIndex = run.args.indexOf('-p');
  if (promptIndex >= 0) {
    assert.equal(run.args[promptIndex + 1], `Reply with exactly: ${STREAM_PROBE_TOKEN}`);
  }
  assert.equal(run.args[run.args.indexOf('--permission-mode') + 1], 'plan');
});

test('P-agy-mcp marks inventory unsupported when the subcommand fails', async () => {
  const result = await runPAgyMcp('/tools/agy', {
    execFileFn: async () => {
      const error = new Error('Command failed');
      error.stderr = 'error: unknown command \'mcp\'';
      throw error;
    }
  });
  assert.equal(result.probeId, 'P-agy-mcp');
  assert.equal(result.pass, true);
  assert.equal(result.keys['mcp.inventory'].confidence, 'unsupported');
  assert.equal(result.keys['mcp.configured'].confidence, 'unsupported');
});

test('P-agy-mcp classifies unknown-help text as unsupported', async () => {
  const result = await runPAgyMcp('/tools/agy', {
    execFileFn: async () => ({
      stdout: 'Usage: agy [options] [command]',
      stderr: "error: unknown command 'mcp'"
    })
  });
  assert.equal(result.keys['mcp.inventory'].confidence, 'unsupported');
});

test('runLocalCapabilityProbes wires P-detect and P-agy-mcp into a profile', async () => {
  const gemini = AGENT_DEFINITIONS.find((entry) => entry.id === 'gemini');
  const { detect, profile } = await runLocalCapabilityProbes(gemini, {
    resolve: async () => '/tools/agy',
    getVersionFn: async () => '1.1.2',
    execFileFn: async () => {
      const error = new Error('fail');
      error.stderr = 'unknown command';
      throw error;
    }
  });
  assert.equal(detect.pass, true);
  assert.equal(profile.cliVersion, '1.1.2');
  assert.equal(profile.probes['P-detect'].pass, true);
  assert.equal(profile.probes['P-agy-mcp'].pass, true);
  assert.equal(profile.capabilities['mcp.inventory'].confidence, 'unsupported');
  assert.equal(profile.capabilities['conversation.stream'].confidence, 'declared');
  // Stream remains declared until scorePStream runs after a live/stub execution.
  assert.equal(profile.probes['P-stream'], undefined);
});

test('capability profiles stay small for /api/state budgets', () => {
  const agents = AGENT_DEFINITIONS.map((definition) => {
    const profile = buildDeclaredCapabilityProfile(definition, { cliVersion: 'x'.repeat(40) });
    applyProbeResult(profile, {
      probeId: 'P-stream',
      pass: true,
      at: new Date().toISOString(),
      keys: {
        'conversation.stream': { confidence: 'verified', probeId: 'P-stream' },
        'structured.output': definition.id === 'gemini'
          ? { confidence: 'unsupported', reason: 'agy emits plain text, not JSONL' }
          : { confidence: 'verified', probeId: 'P-stream' }
      }
    });
    if (definition.id === 'gemini') {
      applyProbeResult(profile, {
        probeId: 'P-agy-mcp',
        pass: true,
        at: new Date().toISOString(),
        keys: {
          'mcp.inventory': { confidence: 'unsupported', reason: 'agy has no mcp subcommand' },
          'mcp.configured': { confidence: 'unsupported', reason: 'agy has no mcp subcommand' }
        }
      });
    }
    return { id: definition.id, capabilityProfile: profile };
  });
  const bytes = Buffer.byteLength(JSON.stringify(agents), 'utf8');
  // Design: four fully probed profiles well under ~50 KB total.
  assert.ok(bytes < 20_000, `profiles JSON was ${bytes} bytes`);
});
