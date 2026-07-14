import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { id, now } from './utils.js';
import { redactSecrets } from './redact.js';

export class ProcessManager {
  constructor({ onEvent, onEventError, timeoutMinutes = 20 } = {}) {
    this.running = new Map();
    this.onEvent = onEvent || (() => {});
    this.onEventError = onEventError || ((error, event) => {
      console.error(`Process event handler failed for ${event.type}: ${error.message}`);
    });
    this.timeoutMinutes = timeoutMinutes;
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
      command: [invocation.command, ...invocation.args].join(' '),
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
      this.emit({
        type: 'execution.finished', executionId, taskId, agentId,
        exitCode, signal, status: signal ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed', finishedAt: now()
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
