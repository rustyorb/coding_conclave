import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com', '.ps1', ''];

export async function resolveExecutable(command, env = process.env) {
  const pathEntries = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? WINDOWS_EXTENSIONS : [''];
  for (const directory of pathEntries) {
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

const DEFINITIONS = [
  {
    id: 'codex',
    name: 'Codex',
    provider: 'OpenAI',
    command: 'codex',
    versionArgs: ['--version'],
    capabilities: ['repository inspection', 'code generation', 'file editing', 'command execution', 'testing', 'code review'],
    build({ executable, prompt, workspace, accessMode }) {
      const args = ['exec', '--json', '--color', 'never', '--sandbox', accessMode, '--cd', workspace, '--skip-git-repo-check', '-'];
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
    build({ executable, prompt, accessMode }) {
      const permissionMode = accessMode === 'read-only' ? 'plan' : 'acceptEdits';
      const args = ['--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', permissionMode, prompt];
      return { ...invocation(executable, args), format: 'jsonl' };
    }
  },
  {
    id: 'gemini',
    name: 'Gemini',
    provider: 'Google',
    command: 'gemini',
    versionArgs: ['--version'],
    capabilities: ['repository inspection', 'code generation', 'file editing', 'command execution', 'web research', 'testing'],
    build({ executable, prompt, accessMode }) {
      const approvalMode = accessMode === 'read-only' ? 'plan' : 'auto_edit';
      const args = ['--prompt', prompt, '--output-format', 'stream-json', '--approval-mode', approvalMode, '--skip-trust'];
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
  return Promise.all(DEFINITIONS.map(async (definition) => {
    const executable = await resolveExecutable(definition.command);
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

export function buildAgentInvocation(agentId, options, definitions = DEFINITIONS) {
  const definition = definitions.find((candidate) => candidate.id === agentId);
  if (!definition) throw new Error(`Unsupported agent: ${agentId}`);
  if (!options.executable) throw new Error(`${definition.name} is not installed or could not be located`);
  if (!['read-only', 'workspace-write'].includes(options.accessMode)) throw new Error('Invalid access mode');
  return definition.build(options);
}

export function summarizeAgentEvent(agentId, line) {
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
    if (agentId === 'gemini') {
      if (event.type === 'message' && event.role === 'assistant') return event.content || null;
      if (event.type === 'result') return event.result || null;
    }
  } catch { /* raw, non-JSON output remains visible in the execution log */ }
  return null;
}
