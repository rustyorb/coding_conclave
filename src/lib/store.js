import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { id, now } from './utils.js';

export function initialState(workspace) {
  const createdAt = now();
  return {
    version: 1,
    room: {
      id: id('room'),
      name: 'Engineering room',
      workspace,
      mode: 'operator-directed',
      paused: false,
      createdAt,
      limits: { maxTurnsPerAgent: 12, maxConcurrentRuns: 3, timeoutMinutes: 20 }
    },
    agents: [],
    tasks: [],
    messages: [{
      id: id('msg'),
      source: 'system',
      sourceName: 'Conclave',
      type: 'system',
      content: 'Room created. Agent availability is determined from installed CLIs on this machine.',
      createdAt
    }],
    approvals: [],
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
      this.state = { ...initialState(this.workspace), ...persisted };
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
    this.queue = this.queue.then(async () => {
      const result = await mutator(this.state);
      await this.save();
      return result;
    });
    return this.queue;
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
