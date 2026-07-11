import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 15_000, windowsHide: true, maxBuffer: 5_000_000 });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    const diagnostic = `${error.message || ''}\n${String(error.stderr || '')}`.toLowerCase();
    if (diagnostic.includes('not a git repository')) return '';
    throw error;
  }
}

export function isInsideWorkspace(workspace, candidate) {
  const root = path.resolve(workspace).toLowerCase();
  const resolved = path.resolve(candidate).toLowerCase();
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export async function inspectWorkspace(workspace) {
  const insideWorkTree = await git(['rev-parse', '--is-inside-work-tree'], workspace);
  if (insideWorkTree.trim() !== 'true') {
    return { status: [], diff: '', refreshedAt: new Date().toISOString() };
  }
  const statusText = await git(['status', '--short', '--untracked-files=all'], workspace);
  const diff = await git(['diff', '--no-ext-diff', '--'], workspace);
  const stagedDiff = await git(['diff', '--cached', '--no-ext-diff', '--'], workspace);
  return {
    status: statusText.split(/\r?\n/).filter(Boolean),
    diff: [diff, stagedDiff && `\n# Staged changes\n${stagedDiff}`].filter(Boolean).join('\n'),
    refreshedAt: new Date().toISOString()
  };
}
