import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { id, now } from './utils.js';
import { defaultPolicy } from './policy.js';

export function initialState(workspace) {
  const createdAt = now();
  return {
    version: 2,
    room: {
      id: id('room'),
      name: 'Engineering room',
      workspace,
      mode: 'general-chat',
      paused: false,
      createdAt,
      limits: { maxTurnsPerAgent: 12, maxConcurrentRuns: 3, timeoutMinutes: 20 }
    },
    agents: [],
    tasks: [],
    chatTurns: [],
    messages: [{
      id: id('msg'),
      source: 'system',
      sourceName: 'Conclave',
      type: 'system',
      content: 'Room created. Agent availability is determined from installed CLIs on this machine.',
      createdAt
    }],
    approvals: [],
    policy: defaultPolicy(),
    executions: [],
    workspace: { status: [], diff: '', refreshedAt: createdAt },
    audit: []
  };
}

export class JsonStore {
  constructor(file, workspace) {
    this.file = file;
    this.workspace = workspace;
    this.state = initialState(workspace);
    this.queue = Promise.resolve();
  }

  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const persisted = JSON.parse(await readFile(this.file, 'utf8'));
      const defaults = initialState(this.workspace);
      this.state = {
        ...defaults,
        ...persisted,
        version: defaults.version,
        room: {
          ...defaults.room,
          ...persisted.room,
          mode: 'general-chat',
          limits: { ...defaults.room.limits, ...persisted.room?.limits }
        },
        policy: { ...defaults.policy, ...persisted.policy,
          autoRetry: { ...defaults.policy.autoRetry, ...(persisted.policy?.autoRetry ?? {}) } },
        chatTurns: Array.isArray(persisted.chatTurns) ? persisted.chatTurns : []
      };
      this.state.room.workspace = this.workspace;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }
    return this.state;
  }

  async save() {
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await rename(temp, this.file);
  }

  update(mutator) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const result = await mutator(this.state);
      await this.save();
      return result;
    });
    // Keep the queue alive after a failed update, but surface the failure —
    // persistent save errors (e.g. disk full) must not vanish silently.
    this.queue = operation.catch((error) => console.error('store update failed:', error?.message || error));
    return operation;
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
