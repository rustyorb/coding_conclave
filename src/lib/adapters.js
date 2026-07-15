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

export const AGENT_DEFINITIONS = [
  {
    id: 'codex',
    name: 'Codex',
    provider: 'OpenAI',
    command: 'codex',
    versionArgs: ['--version'],
    capabilities: ['repository inspection', 'code generation', 'file editing', 'command execution', 'testing', 'code review'],
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
    capabilities: ['repository inspection', 'code generation', 'file editing', 'command execution', 'testing', 'code review', 'long-context analysis'],
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
    capabilities: ['repository inspection', 'code generation', 'file editing', 'command execution', 'web research', 'testing'],
    build({ executable, prompt, accessMode, elevated }) {
      // Antigravity CLI (agy): a real agentic CLI, replacing the API-only
      // gemini-adapter.js wrapper that could talk but never touch files.
      const mode = accessMode === 'read-only' ? 'plan' : 'accept-edits';
      const args = ['-p', prompt, '--mode', mode, '--print-timeout', '10m'];
      if (elevated && accessMode !== 'read-only') args.push('--dangerously-skip-permissions');
      return { ...invocation(executable, args), format: 'text' };
    }
  },
  {
    id: 'grok',
    name: 'Grok',
    provider: 'xAI',
    command: 'grok',
    versionArgs: ['--version'],
    capabilities: ['repository inspection', 'code generation', 'file editing', 'command execution', 'testing', 'code review', 'web research'],
    build({ executable, prompt, accessMode, elevated }) {
      // Grok mirrors Claude's permission-mode surface; team to verify the
      // bypassPermissions flag name against the installed grok CLI.
      const permissionMode = accessMode === 'read-only' ? 'plan' : elevated ? 'bypassPermissions' : 'acceptEdits';
      const args = ['-p', prompt, '--output-format', 'streaming-json', '--permission-mode', permissionMode];
      return { ...invocation(executable, args), format: 'jsonl' };
    }
  }
];

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
    const executable = await resolveExecutable(
      definition.command,
      process.env,
      definition.extraDirectories ? definition.extraDirectories(process.env) : []
    );
    return {
      id: definition.id,
      name: definition.name,
      provider: definition.provider,
      status: executable ? 'installed' : 'unavailable',
      connection: executable ? 'unverified' : 'unavailable',
      activity: 'idle',
      executable,
      version: executable ? await getVersion(executable, definition.versionArgs) : null,
      capabilities: definition.capabilities,
      currentTaskId: null,
      lastAction: executable ? 'Detected on PATH' : 'CLI not found on PATH'
    };
  }));
}

export function buildAgentInvocation(agentId, options, definitions = AGENT_DEFINITIONS) {
  const definition = definitions.find((candidate) => candidate.id === agentId);
  if (!definition) throw new Error(`Unsupported agent: ${agentId}`);
  if (!options.executable) throw new Error(`${definition.name} is not installed or could not be located`);
  if (!['read-only', 'workspace-write'].includes(options.accessMode)) throw new Error('Invalid access mode');
  return definition.build(options);
}

const textAccumulators = { gemini: '', grok: '' };

// End-of-execution flush for agents that buffer text across events (gemini
// accumulates its whole plain-text run; grok buffers until an `end` event).
// Returning any leftover text here both surfaces partial output from runs
// that died or were cancelled mid-stream and prevents that text from leaking
// into the agent's next execution. Returns null for other agents.
export function flushAgentSummary(agentId) {
  if (!(agentId in textAccumulators)) return null;
  const text = textAccumulators[agentId].trim();
  textAccumulators[agentId] = '';
  return text || null;
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
