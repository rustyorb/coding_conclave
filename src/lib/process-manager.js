import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { id, now, previewCommand } from './utils.js';
import { redactSecrets } from './redact.js';

export class ProcessManager {
  constructor({ onEvent, onEventError, timeoutMinutes = 20 } = {}) {
    this.running = new Map();
    this.reserved = 0;
    this.cancelled = new Map(); // executionId → cancel reason, recorded before the kill lands
    this.onEvent = onEvent || (() => {});
    this.onEventError = onEventError || ((error, event) => {
      console.error(`Process event handler failed for ${event.type}: ${error.message}`);
    });
    this.timeoutMinutes = timeoutMinutes;
  }

  // Slots that are committed to but not yet spawned. Counted alongside running
  // children so concurrent start attempts cannot both pass a capacity check.
  get load() {
    return this.running.size + this.reserved;
  }

  reserve() {
    this.reserved += 1;
  }

  release() {
    if (this.reserved > 0) this.reserved -= 1;
  }

  emit(event) {
    try {
      Promise.resolve(this.onEvent(event)).catch((error) => this.onEventError(error, event));
    } catch (error) {
      this.onEventError(error, event);
    }
  }

  start({ taskId = null, agentId = null, kind = 'agent', invocation, cwd, purpose }) {
    const executionId = id('exec');
    const startedAt = now();
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const execution = {
      id: executionId,
      taskId,
      agentId,
      kind,
      purpose,
      // argv carries the full task prompt for some CLIs — persist only a preview
      // (redact before truncating so a secret cannot be split past the pattern).
      command: previewCommand(redactSecrets([invocation.command, ...invocation.args].join(' '))),
      cwd,
      status: 'running',
      exitCode: null,
      output: '',
      startedAt,
      finishedAt: null
    };
    this.running.set(executionId, child);
    this.emit({ type: 'execution.started', execution });

    const emitLine = (stream, line) => {
      const clean = redactSecrets(line);
      this.emit({ type: 'execution.output', executionId, taskId, agentId, stream, line: clean, createdAt: now() });
    };
    readline.createInterface({ input: child.stdout }).on('line', (line) => emitLine('stdout', line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => emitLine('stderr', line));

    child.on('error', (error) => emitLine('stderr', error.message));
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      this.running.delete(executionId);
      // A cancelled child does not always die by signal: taskkill on win32 and
      // CLIs that trap SIGTERM exit with a plain code (signal null), which must
      // not be classified 'failed' — a retry policy would resurrect the cancelled run.
      const cancelReason = this.cancelled.get(executionId) ?? null;
      this.cancelled.delete(executionId);
      this.emit({
        type: 'execution.finished', executionId, taskId, agentId,
        exitCode, signal, reason: cancelReason,
        status: signal || cancelReason ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed', finishedAt: now()
      });
    });

    if (invocation.stdin) child.stdin.end(invocation.stdin);
    else child.stdin.end();

    const timer = setTimeout(() => this.cancel(executionId, 'timeout'), this.timeoutMinutes * 60_000);
    timer.unref();
    return execution;
  }

  cancel(executionId, reason = 'user') {
    const child = this.running.get(executionId);
    if (!child) return false;
    this.cancelled.set(executionId, reason);
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
    this.emit({ type: 'execution.cancelling', executionId, reason, createdAt: now() });
    return true;
  }

  cancelAll(reason = 'room-paused') {
    for (const executionId of this.running.keys()) this.cancel(executionId, reason);
  }
}
