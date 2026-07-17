import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com', '.ps1', ''];

export async function resolveExecutable(command, env = process.env, extraDirectories = []) {
  const pathEntries = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? WINDOWS_EXTENSIONS : [''];
  for (const directory of [...pathEntries, ...extraDirectories]) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), `${command}${extension}`);
      try {
        await access(candidate);
        return candidate;
      } catch { /* continue */ }
    }
  }
  return null;
}

function invocation(executable, args) {
  if (process.platform === 'win32' && executable.toLowerCase().endsWith('.ps1')) {
    return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args] };
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', executable, ...args] };
  }
  return { command: executable, args };
}

/** Bump when build()/probe matrix changes (capabilityProfile.adapterVersion). */
export const ADAPTER_PROFILE_VERSION = 1;

/** Default TTL for verified probe results before they become stale. */
export const CAPABILITY_TTL_HOURS = 72;

/** P-stream prompt token — model must echo this exactly for pass. */
export const STREAM_PROBE_TOKEN = 'PROBE_OK';
export const STREAM_PROBE_PROMPT = `Reply with exactly: ${STREAM_PROBE_TOKEN}`;

/**
 * Shared Phase-1 probe ids. Later phases add P-*-write / MCP list / cancel, etc.
 * @typedef {'P-detect' | 'P-stream' | 'P-agy-mcp'} Phase1ProbeId
 */

const SHARED_PROBE_SUPPORT = {
  'P-detect': true,
  'P-stream': true,
  'P-agy-mcp': false
};

/** Stable keys (docs/capability-broker-design.md §5.1) with optional UI labels. */
function cap(key, label) {
  return label ? { key, label } : { key };
}

export const AGENT_DEFINITIONS = [
  {
    id: 'codex',
    name: 'Codex',
    provider: 'OpenAI',
    command: 'codex',
    versionArgs: ['--version'],
    declaredCapabilities: [
      cap('conversation.stream'),
      cap('structured.output'),
      cap('repository.read', 'repository inspection'),
      cap('filesystem.write', 'file editing'),
      cap('command.execute', 'command execution'),
      cap('test.run', 'testing'),
      cap('code.review', 'code review'),
      cap('sandbox.enforced'),
      cap('mcp.inventory'),
      cap('mcp.configured'),
      cap('usage.report')
    ],
    // Soft/legacy display labels kept for consumers that still want a string list.
    capabilityLabels: ['repository inspection', 'code generation', 'file editing', 'command execution', 'testing', 'code review'],
    probeSupport: { ...SHARED_PROBE_SUPPORT },
    build({ executable, prompt, workspace, accessMode, elevated }) {
      const sandbox = accessMode === 'read-only' ? 'read-only'
        : elevated ? 'danger-full-access' : 'workspace-write';
      const args = ['exec', '--json', '--color', 'never', '--sandbox', sandbox, '--cd', workspace, '--skip-git-repo-check', '-'];
      return { ...invocation(executable, args), stdin: prompt, format: 'jsonl' };
    }
  },
  {
    id: 'claude',
    name: 'Claude',
    provider: 'Anthropic',
    command: 'claude',
    versionArgs: ['--version'],
    declaredCapabilities: [
      cap('conversation.stream'),
      cap('structured.output'),
      cap('repository.read', 'repository inspection'),
      cap('filesystem.write', 'file editing'),
      cap('command.execute', 'command execution'),
      cap('test.run', 'testing'),
      cap('code.review', 'code review'),
      cap('sandbox.enforced'),
      cap('tool.allowlist'),
      cap('mcp.inventory'),
      cap('mcp.configured')
    ],
    capabilityLabels: ['repository inspection', 'code generation', 'file editing', 'command execution', 'testing', 'code review', 'long-context analysis'],
    probeSupport: { ...SHARED_PROBE_SUPPORT },
    build({ executable, prompt, accessMode, elevated }) {
      // Unleashed rooms use bypassPermissions so a headless write run can run
      // commands without a prompt no one is there to answer.
      const permissionMode = accessMode === 'read-only' ? 'plan' : elevated ? 'bypassPermissions' : 'acceptEdits';
      const args = ['--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', permissionMode, prompt];
      return { ...invocation(executable, args), format: 'jsonl' };
    }
  },
  {
    id: 'gemini',
    name: 'Gemini',
    provider: 'Google',
    command: 'agy',
    versionArgs: ['--version'],
    declaredCapabilities: [
      cap('conversation.stream'),
      cap('repository.read', 'repository inspection'),
      cap('filesystem.write', 'file editing'),
      cap('command.execute', 'command execution'),
      cap('web.search', 'web research'),
      cap('test.run', 'testing'),
      cap('sandbox.enforced')
      // mcp.* intentionally absent — marked unsupported by P-agy-mcp
    ],
    capabilityLabels: ['repository inspection', 'code generation', 'file editing', 'command execution', 'web research', 'testing'],
    probeSupport: { ...SHARED_PROBE_SUPPORT, 'P-agy-mcp': true },
    build({ executable, prompt, accessMode }) {
      // Antigravity CLI (agy): a real agentic CLI, replacing the API-only
      // gemini-adapter.js wrapper that could talk but never touch files.
      const mode = accessMode === 'read-only' ? 'plan' : 'accept-edits';
      // Headless agy auto-denies every tool prompt — even read_file in plan
      // mode — so the bypass flag must always be present. This makes read-only
      // advisory for agy: --mode plan asks it not to write, nothing enforces it.
      const args = ['-p', prompt, '--mode', mode, '--print-timeout', '10m', '--dangerously-skip-permissions'];
      return { ...invocation(executable, args), format: 'text' };
    }
  },
  {
    id: 'grok',
    name: 'Grok',
    provider: 'xAI',
    command: 'grok',
    versionArgs: ['--version'],
    declaredCapabilities: [
      cap('conversation.stream'),
      cap('structured.output'),
      cap('repository.read', 'repository inspection'),
      cap('filesystem.write', 'file editing'),
      cap('command.execute', 'command execution'),
      cap('test.run', 'testing'),
      cap('code.review', 'code review'),
      cap('web.search', 'web research'),
      cap('sandbox.enforced'),
      cap('tool.allowlist'),
      cap('mcp.inventory'),
      cap('mcp.configured')
    ],
    capabilityLabels: ['repository inspection', 'code generation', 'file editing', 'command execution', 'testing', 'code review', 'web research'],
    probeSupport: { ...SHARED_PROBE_SUPPORT },
    build({ executable, prompt, accessMode, elevated }) {
      // Grok mirrors Claude's permission-mode surface; team to verify the
      // bypassPermissions flag name against the installed grok CLI.
      const permissionMode = accessMode === 'read-only' ? 'plan' : elevated ? 'bypassPermissions' : 'acceptEdits';
      const args = ['-p', prompt, '--output-format', 'streaming-json', '--permission-mode', permissionMode];
      return { ...invocation(executable, args), format: 'jsonl' };
    }
  }
];

/** Legacy string list for UI / older consumers (labels only — not proof). */
export function capabilityLabelsFor(definition) {
  if (Array.isArray(definition.capabilityLabels)) return [...definition.capabilityLabels];
  return (definition.declaredCapabilities || [])
    .map((entry) => entry.label || entry.key)
    .filter(Boolean);
}

/**
 * Build a capabilityProfile with every declared key at confidence `declared`.
 * Does not claim verified; probes must upgrade entries.
 */
export function buildDeclaredCapabilityProfile(definition, {
  cliVersion = null,
  adapterVersion = ADAPTER_PROFILE_VERSION,
  ttlHours = CAPABILITY_TTL_HOURS,
  probedAt = null
} = {}) {
  const capabilities = {};
  for (const entry of definition.declaredCapabilities || []) {
    capabilities[entry.key] = {
      confidence: 'declared',
      ...(entry.label ? { label: entry.label } : {})
    };
  }
  // agy has no MCP surface — seed unsupported even before P-agy-mcp runs so
  // badges never green-light mcp from a missing key alone.
  if (definition.id === 'gemini') {
    capabilities['mcp.inventory'] = {
      confidence: 'unsupported',
      reason: 'agy has no mcp subcommand'
    };
    capabilities['mcp.configured'] = {
      confidence: 'unsupported',
      reason: 'agy has no mcp subcommand'
    };
    capabilities['structured.output'] = {
      confidence: 'unsupported',
      reason: 'agy emits plain text, not JSONL'
    };
  }
  return {
    adapterVersion,
    cliVersion,
    probedAt,
    ttlHours,
    capabilities,
    probes: {}
  };
}

/** Apply one probe result onto a profile (mutates and returns profile). */
export function applyProbeResult(profile, probeResult) {
  if (!profile || !probeResult) return profile;
  profile.probes = profile.probes || {};
  profile.probes[probeResult.probeId] = {
    pass: probeResult.pass,
    at: probeResult.at || new Date().toISOString(),
    ...(probeResult.code ? { code: probeResult.code } : {}),
    ...(probeResult.detail ? { detail: probeResult.detail } : {})
  };
  if (probeResult.cliVersion != null) profile.cliVersion = probeResult.cliVersion;
  if (probeResult.at) profile.probedAt = probeResult.at;
  for (const [key, entry] of Object.entries(probeResult.keys || {})) {
    profile.capabilities[key] = {
      ...(profile.capabilities[key] || {}),
      ...entry
    };
  }
  return profile;
}

/**
 * P-detect: resolveExecutable + versionArgs.
 * Pass = executable found and version string obtained (or soft version-fail still installed).
 */
export async function runPDetect(definition, {
  env = process.env,
  resolve = resolveExecutable,
  getVersionFn = getVersion
} = {}) {
  const at = new Date().toISOString();
  const extra = definition.extraDirectories ? definition.extraDirectories(env) : [];
  const executable = await resolve(definition.command, env, extra);
  if (!executable) {
    return {
      probeId: 'P-detect',
      pass: false,
      at,
      executable: null,
      version: null,
      code: 'PROBE_DETECT_NOT_FOUND',
      keys: {}
    };
  }
  const version = await getVersionFn(executable, definition.versionArgs);
  return {
    probeId: 'P-detect',
    pass: true,
    at,
    executable,
    version,
    cliVersion: version,
    keys: {}
  };
}

/**
 * Build a read-only stream probe invocation (does not spawn).
 * Server / ProcessManager should run this as kind: 'probe', purpose: 'P-stream'.
 */
export function buildPStreamInvocation(agentId, {
  executable,
  workspace = process.cwd(),
  definitions = AGENT_DEFINITIONS
} = {}) {
  return buildAgentInvocation(agentId, {
    executable,
    prompt: STREAM_PROBE_PROMPT,
    workspace,
    accessMode: 'read-only',
    elevated: false
  }, definitions);
}

/**
 * Score P-stream from captured stdout lines (fixture-friendly; no live CLI).
 * Pass when summarized/flushed text contains PROBE_OK.
 * structured.output verified only for JSONL agents that parse cleanly.
 */
export function scorePStream(agentId, lines = []) {
  const at = new Date().toISOString();
  clearAgentSummary(agentId);
  const collected = [];
  let parseErrors = 0;
  let jsonLines = 0;

  for (const line of lines) {
    const text = String(line ?? '');
    if (agentId === 'gemini') {
      summarizeAgentEvent(agentId, text);
      continue;
    }
    // Non-empty non-JSON noise counts against structured.output, not stream text.
    const trimmed = text.trim();
    if (!trimmed) continue;
    try {
      JSON.parse(trimmed);
      jsonLines += 1;
    } catch {
      parseErrors += 1;
    }
    const summary = summarizeAgentEvent(agentId, text);
    if (summary) collected.push(summary);
  }

  const flushed = flushAgentSummary(agentId);
  if (flushed) collected.push(flushed);
  const combined = collected.join('\n');
  const hasToken = combined.includes(STREAM_PROBE_TOKEN);

  const keys = {
    'conversation.stream': hasToken
      ? { confidence: 'verified', probeId: 'P-stream' }
      : { confidence: 'failed', probeId: 'P-stream', code: 'PROBE_STREAM_MISSING_TOKEN' }
  };

  if (agentId === 'gemini') {
    keys['structured.output'] = {
      confidence: 'unsupported',
      reason: 'agy emits plain text, not JSONL',
      probeId: 'P-stream'
    };
  } else if (hasToken && parseErrors === 0 && jsonLines > 0) {
    keys['structured.output'] = { confidence: 'verified', probeId: 'P-stream' };
  } else if (hasToken) {
    keys['structured.output'] = {
      confidence: 'failed',
      probeId: 'P-stream',
      code: 'PROBE_STRUCTURED_PARSE',
      detail: `parseErrors=${parseErrors}`
    };
  } else {
    keys['structured.output'] = {
      confidence: 'failed',
      probeId: 'P-stream',
      code: 'PROBE_STREAM_MISSING_TOKEN'
    };
  }

  return {
    probeId: 'P-stream',
    pass: hasToken,
    at,
    code: hasToken ? undefined : 'PROBE_STREAM_MISSING_TOKEN',
    keys,
    detail: hasToken ? undefined : 'output did not contain PROBE_OK'
  };
}

/**
 * P-agy-mcp: confirm Antigravity has no MCP inventory surface.
 * Expects confidence unsupported on current agy (1.x). If a future agy gains
 * `mcp`, this probe upgrades to probed with names only (no env/commands).
 */
export async function runPAgyMcp(executable, { execFileFn = execFileAsync } = {}) {
  const at = new Date().toISOString();
  if (!executable) {
    return {
      probeId: 'P-agy-mcp',
      pass: true,
      at,
      keys: {
        'mcp.inventory': {
          confidence: 'unsupported',
          reason: 'agy has no mcp subcommand',
          probeId: 'P-agy-mcp'
        },
        'mcp.configured': {
          confidence: 'unsupported',
          reason: 'agy has no mcp subcommand',
          probeId: 'P-agy-mcp'
        }
      }
    };
  }

  const unsupported = (detail) => ({
    probeId: 'P-agy-mcp',
    pass: true,
    at,
    detail,
    keys: {
      'mcp.inventory': {
        confidence: 'unsupported',
        reason: 'agy has no mcp subcommand',
        probeId: 'P-agy-mcp'
      },
      'mcp.configured': {
        confidence: 'unsupported',
        reason: 'agy has no mcp subcommand',
        probeId: 'P-agy-mcp'
      }
    }
  });

  try {
    const run = invocation(executable, ['mcp', '--help']);
    const { stdout, stderr } = await execFileFn(run.command, run.args, {
      timeout: 5_000,
      windowsHide: true
    });
    const text = `${stdout || ''}\n${stderr || ''}`.toLowerCase();
    // Success with help that looks like a real mcp subcommand.
    const looksLikeMcp = /\bmcp\b/.test(text)
      && (/\blist\b/.test(text) || /\badd\b/.test(text) || /\bserver\b/.test(text));
    const looksUnknown = /unknown|unrecognized|invalid|not found|no such|usage:/i.test(text)
      && !looksLikeMcp;
    if (looksUnknown || !looksLikeMcp) return unsupported('mcp --help did not expose an inventory surface');

    // Unexpected but honest: treat as inventory-capable until a names-only parser lands.
    return {
      probeId: 'P-agy-mcp',
      pass: true,
      at,
      detail: 'agy appears to expose mcp; names-only inventory not yet implemented',
      keys: {
        'mcp.inventory': {
          confidence: 'probed',
          probeId: 'P-agy-mcp',
          servers: [],
          note: 'parser pending'
        },
        'mcp.configured': {
          confidence: 'probed',
          probeId: 'P-agy-mcp',
          configured: false
        }
      }
    };
  } catch (error) {
    // Non-zero exit / missing subcommand is the expected path on agy 1.1.x.
    const message = String(error?.stderr || error?.message || error);
    return unsupported(message.slice(0, 200));
  }
}

/**
 * Run the Phase-1 local probes that do not need a full agent chat session:
 * P-detect always; P-agy-mcp for gemini. P-stream is scored separately after
 * ProcessManager finishes a probe execution (see scorePStream).
 */
export async function runLocalCapabilityProbes(definition, options = {}) {
  const detect = await runPDetect(definition, options);
  const profile = buildDeclaredCapabilityProfile(definition, {
    cliVersion: detect.version,
    probedAt: detect.at
  });
  applyProbeResult(profile, detect);

  if (definition.probeSupport?.['P-agy-mcp'] && detect.executable) {
    const mcp = await runPAgyMcp(detect.executable, options);
    applyProbeResult(profile, mcp);
  } else if (definition.id === 'gemini') {
    // Still stamp unsupported without an executable so UI never shows declared MCP.
    applyProbeResult(profile, {
      probeId: 'P-agy-mcp',
      pass: true,
      at: detect.at,
      keys: {
        'mcp.inventory': {
          confidence: 'unsupported',
          reason: 'agy has no mcp subcommand',
          probeId: 'P-agy-mcp'
        },
        'mcp.configured': {
          confidence: 'unsupported',
          reason: 'agy has no mcp subcommand',
          probeId: 'P-agy-mcp'
        }
      }
    });
  }

  return { detect, profile };
}

async function getVersion(executable, versionArgs) {
  try {
    const run = invocation(executable, versionArgs);
    const { stdout, stderr } = await execFileAsync(run.command, run.args, { timeout: 5_000, windowsHide: true });
    return String(stdout || stderr).trim().split(/\r?\n/)[0] || 'installed';
  } catch (error) {
    return `installed; version check failed: ${error.message}`;
  }
}

export async function detectAgents() {
  return Promise.all(AGENT_DEFINITIONS.map(async (definition) => {
    const { detect, profile } = await runLocalCapabilityProbes(definition);
    const executable = detect.executable;
    return {
      id: definition.id,
      name: definition.name,
      provider: definition.provider,
      status: executable ? 'installed' : 'unavailable',
      connection: executable ? 'unverified' : 'unavailable',
      activity: 'idle',
      executable,
      version: executable ? detect.version : null,
      // Legacy string badges — labels only, never proof of verified tools.
      capabilities: capabilityLabelsFor(definition),
      capabilityProfile: profile,
      currentTaskId: null,
      lastAction: executable ? 'Detected on PATH' : 'CLI not found on PATH'
    };
  }));
}

const textAccumulators = { gemini: '', grok: '' };

export function buildAgentInvocation(agentId, options, definitions = AGENT_DEFINITIONS) {
  const definition = definitions.find((candidate) => candidate.id === agentId);
  if (!definition) throw new Error(`Unsupported agent: ${agentId}`);
  if (!options.executable) throw new Error(`${definition.name} is not installed or could not be located`);
  if (!['read-only', 'workspace-write'].includes(options.accessMode)) throw new Error('Invalid access mode');
  // A cancelled Grok stream may never emit its `end` event, leaving partial
  // text behind. Every new invocation starts from a clean reply buffer so
  // late or abandoned output cannot be prepended to the next run.
  if (agentId === 'grok' && options.resetSummary !== false) clearAgentSummary(agentId);
  return definition.build(options);
}

// End-of-execution flush for agents that buffer text across events (gemini
// accumulates its whole plain-text run; grok buffers until an `end` event).
// Returning any leftover text here surfaces partial output from runs that died
// unexpectedly and prevents that text from leaking into the next execution.
// Cancelled runs are explicitly discarded by the server instead.
export function flushAgentSummary(agentId) {
  if (!(agentId in textAccumulators)) return null;
  const text = textAccumulators[agentId].trim();
  clearAgentSummary(agentId);
  return text || null;
}

export function clearAgentSummary(agentId) {
  if (agentId in textAccumulators) textAccumulators[agentId] = '';
}

export function summarizeAgentEvent(agentId, line) {
  // agy --print emits plain text, not JSONL: accumulate the whole run and flush
  // it as one message at execution end (flushAgentSummary), so multi-line
  // replies stay one message and fenced blocks survive intact. Safe because the
  // server runs at most one execution per agent at a time.
  if (agentId === 'gemini') {
    textAccumulators.gemini += `${line}\n`;
    return null;
  }
  try {
    const event = JSON.parse(line);
    if (agentId === 'codex') {
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') return event.item.text;
      if (event.type === 'turn.completed') return event.usage ? `Usage: ${JSON.stringify(event.usage)}` : null;
    }
    if (agentId === 'claude') {
      if (event.type === 'assistant') {
        return event.message?.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') || null;
      }
      if (event.type === 'result') return event.result || null;
    }
    if (agentId === 'grok') {
      if (event.type === 'text' && event.data) {
        textAccumulators.grok += event.data;
      }
      if (event.type === 'end') {
        const result = textAccumulators.grok;
        textAccumulators.grok = '';
        return result || null;
      }
    }
  } catch { /* raw, non-JSON output remains visible in the execution log */ }
  return null;
}
