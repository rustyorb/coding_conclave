import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const GIT_OPTIONS = { timeout: 15_000, windowsHide: true, maxBuffer: 5_000_000 };
const TRUNCATION_NOTE = '\n# [diff truncated: capture exceeded the 5,000,000-byte limit]\n';
// Bound the per-inspection cost of diffing untracked files: at most this many
// git spawns and roughly this many characters of untracked content per pass.
const UNTRACKED_FILE_CAP = 20;
const UNTRACKED_CHAR_CAP = 100_000;

async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, ...GIT_OPTIONS });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    // A capture larger than maxBuffer must not poison the whole inspection (it
    // would leave execution.diff null and the workspace snapshot permanently
    // stale) — keep what was captured and mark the truncation instead.
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return `${String(error.stdout || '')}${TRUNCATION_NOTE}`;
    const diagnostic = `${error.message || ''}\n${String(error.stderr || '')}`.toLowerCase();
    if (diagnostic.includes('not a git repository')) return '';
    throw error;
  }
}

// `git status --short` C-quotes paths with special characters.
function unquoteStatusPath(name) {
  if (!name.startsWith('"') || !name.endsWith('"')) return name;
  try { return JSON.parse(name); } catch { return name.slice(1, -1); }
}

// `git diff` never includes untracked files, so a run whose entire output is new
// files would otherwise store an empty diff ("no diff available" in review).
// Diff each one against /dev/null; --no-index exits 1 when the files differ,
// which is the expected case here, so treat that as success.
async function untrackedDiff(file, cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', file], { cwd, ...GIT_OPTIONS });
    return stdout;
  } catch (error) {
    if (error.code === 1 && typeof error.stdout === 'string') return error.stdout;
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return `${String(error.stdout || '')}${TRUNCATION_NOTE}`;
    return ''; // unreadable or vanished file — skip it rather than fail the inspection
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
    return { git: false, status: [], diff: '', refreshedAt: new Date().toISOString() };
  }
  const statusText = await git(['status', '--short', '--untracked-files=all'], workspace);
  const status = statusText.split(/\r?\n/).filter(Boolean);
  const diff = await git(['diff', '--no-ext-diff', '--'], workspace);
  const stagedDiff = await git(['diff', '--cached', '--no-ext-diff', '--'], workspace);
  const untrackedFiles = status.filter((line) => line.startsWith('??')).map((line) => unquoteStatusPath(line.slice(3)));
  const parts = [];
  let captured = 0;
  for (const file of untrackedFiles.slice(0, UNTRACKED_FILE_CAP)) {
    if (captured >= UNTRACKED_CHAR_CAP) break;
    const fragment = await untrackedDiff(file, workspace);
    captured += fragment.length;
    if (fragment) parts.push(fragment);
  }
  const skipped = untrackedFiles.length - Math.min(untrackedFiles.length, UNTRACKED_FILE_CAP);
  const untracked = parts.join('');
  return {
    git: true,
    status,
    diff: [
      diff,
      stagedDiff && `\n# Staged changes\n${stagedDiff}`,
      untracked && `\n# Untracked files\n${untracked}`,
      (skipped > 0 || captured > UNTRACKED_CHAR_CAP) && '\n# [additional untracked file contents omitted]\n'
    ].filter(Boolean).join('\n'),
    refreshedAt: new Date().toISOString()
  };
}
