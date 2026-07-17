import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { MemoryDb } from './lib/memory-db.js';
import { detectAgents, buildAgentInvocation, clearAgentSummary, flushAgentSummary, summarizeAgentEvent } from './lib/adapters.js';
import { IDENTITY_BLOCK, validateIdentity } from './lib/identity.js';
import { evaluateAutoApproval, validatePolicy } from './lib/policy.js';
import { ProcessManager } from './lib/process-manager.js';
import { failedDependencies, selectDependencyBlocked, unmetDependencies, validateDependencies } from './lib/scheduler.js';
import { applyIdleWatchdog, DEFAULT_IDLE_CHECK_MS, DEFAULT_IDLE_INTERVAL_MS } from './lib/idle-watchdog.js';
import { deleteBoardTask } from './lib/task-deletion.js';
import { JsonStore, queryHistory } from './lib/store.js';
import { advanceRoomSummary, projectSummaryForApi } from './lib/room-summary.js';
import { addMemorySource, createMemoryItem, ensureMemoryState, projectMemoryForApi, reviseMemoryItem, setMemoryItemPinned } from './lib/memory-ledger.js';
import { inspectWorkspace } from './lib/workspace.js';
import { clampText, id, now, previewCommand, publicError, readJsonBody } from './lib/utils.js';
import { assembleContext } from './lib/context-assembler.js';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(sourceDir, '..');
const publicDir = path.join(projectDir, 'public');
const dataFile = path.join(projectDir, '.conclave', 'state.json');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

// Loopback-only. Reject any other Host (e.g. an attacker's DNS-rebinding domain
// that resolves to 127.0.0.1) so the local API cannot be reached cross-host.
function isTrustedHost(host) {
  const hostname = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

// Block cross-site requests: browsers attach Origin to cross-origin writes, so a
// present-but-mismatched Origin is a CSRF attempt.
function isTrustedOrigin(origin, host) {
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

function timingSafeStringEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(right ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function readCookie(request, name) {
  const header = String(request.headers.cookie ?? '');
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return null;
}

function routeMatch(pathname, expression) {
  return pathname.match(expression);
}

// The API projection strips captured output from executions (each can hold up to
// 120k chars) so /api/state stays small; full output is served per-execution.
// `command` is also previewed here: records persisted before the creation-time
// preview still hold the full prompt-bearing argv. `purpose` is previewed too —
// it carries the full task objective or chat message text for agent runs.
// Agent-write approval `command` fields get the same preview: they hold the full
// prompt-bearing argv but are display-only (approval rebuilds the invocation via
// startTask). `command`-type approvals are NOT previewed — that string executes
// verbatim on approval, so the operator must see exactly what will run.
// Size cap: previewCommand keeps 200 chars + a length marker, so every previewed
// field projects to at most COMMAND_PREVIEW_CAP chars regardless of stored size.
const STATE_EXECUTION_LIMIT = 200;
const OUTPUT_TAIL_CHARS = 500;
export const COMMAND_PREVIEW_CAP = 240;

function projectStateForApi(state, { includeMemoryContent = true, memoryEngine = null } = {}) {
  const executionsTotal = state.executions.length;
  const executions = state.executions.slice(0, STATE_EXECUTION_LIMIT).map((execution) => {
    const { output, ...rest } = execution;
    const text = output || '';
    return { ...rest, command: previewCommand(rest.command), purpose: previewCommand(rest.purpose), outputSize: text.length, outputTail: text.slice(-OUTPUT_TAIL_CHARS) };
  });
  const approvals = state.approvals.map((approval) => approval.type === 'agent-write'
    ? { ...approval, command: previewCommand(approval.command) }
    : approval);
  // Rolling summary: project lean checkpoint metadata + full current rollup.
  const summary = projectSummaryForApi(state.summary);
  // Tier 3 ledger: items + provenance edges, without the revision history.
  const projectedMemory = projectMemoryForApi(state.memory);
  const memory = includeMemoryContent
    ? { ...projectedMemory, locked: false }
    : {
        version: projectedMemory.version,
        roomId: projectedMemory.roomId,
        itemsTotal: projectedMemory.itemsTotal,
        items: [],
        sources: [],
        locked: true
      };
  const safeSummary = includeMemoryContent || !summary?.rollup
    ? summary
    : { ...summary, rollup: { ...summary.rollup, content: null, locked: true } };
  return { ...state, executions, executionsTotal, approvals, summary: safeSummary, memory, memoryEngine };
}

function memoryWorkspaceId(workspace) {
  if (!workspace) return null;
  let canonical = path.resolve(String(workspace));
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function displayInvocation(invocation) {
  const quote = (value) => /\s/.test(String(value)) ? JSON.stringify(String(value)) : String(value);
  return [invocation.command, ...invocation.args].map(quote).join(' ');
}

export const SPECIALIST_ROLES = ['architect', 'implementer', 'researcher', 'reviewer', 'tester', 'security', 'docs', 'critic'];
const PLAN_BLOCK = /```conclave-plan\s*\n([\s\S]*?)```/;
const PLAN_TASK_CAP = 10;

function agentRoles(state, agentId) {
  return state.room.roles?.[agentId] ?? [];
}

function roleSuffix(state, agentId) {
  const parts = [...(state.room.coordinatorId === agentId ? ['coordinator'] : []), ...agentRoles(state, agentId)];
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function identityLines(state, agent) {
  const lines = [];
  const roles = agentRoles(state, agent.id);
  if (state.room.coordinatorId === agent.id) {
    lines.push('You are this room’s Coordinator. You can decompose work, assign tasks, and keep the room moving within its trust and access policy.');
  }
  if (roles.length) lines.push(`Your roles in this room: ${roles.join(', ')}.`);
  if (state.room.coordinatorId && state.room.coordinatorId !== agent.id) {
    const coordinator = state.agents.find((entry) => entry.id === state.room.coordinatorId);
    lines.push(`Room coordinator: ${coordinator?.name ?? state.room.coordinatorId}.`);
  }
  return lines;
}

function coordinatorPlanLines(state) {
  const installed = state.agents.filter((entry) => entry.status === 'installed').map((entry) => {
    const current = entry.currentTaskId && state.tasks.find((task) => task.id === entry.currentTaskId);
    const availability = entry.activity === 'running'
      ? `busy${current ? ` on “${current.title}”` : ''}`
      : 'idle';
    return `${entry.id} (${availability})`;
  });
  const unleashed = state.room.trust === 'unleashed';
  return [
    '',
    'When the operator asks you to plan, organize, or delegate work, coordinate it by ending your reply with one fenced plan block in exactly this format:',
    '```conclave-plan',
    '[{"title": "Short imperative title", "objective": "What done means and what evidence is required", "agentId": "codex", "accessMode": "read-only", "priority": "high", "dependsOn": []}]',
    '```',
    `Available agents: ${installed.join(', ') || 'none available'}. Prefer an idle agent when skills fit. accessMode is "read-only" or "workspace-write". priority is critical, high, medium, low, or none. dependsOn lists zero-based indexes of earlier tasks in the same plan. Assign at most ${PLAN_TASK_CAP} tasks.`,
    unleashed
      ? 'The block dispatches assigned Board tasks immediately under Unleashed room policy, including auto-approved workspace-write access.'
      : 'The block creates assigned Board tasks immediately. Read-only tasks run when their assignees are idle; workspace-write tasks follow the room’s approval and autopilot policy.',
    'Do not grant access, accept reviews, or change room settings. Report assignments as dispatched only after Conclave confirms the plan block.'
  ];
}

// Room history for prompts: the store's Tier 1 verbatim-history query walks
// newest-first under a character (or token) budget; lines return oldest-first
// for reading, prefixed with an explicit marker when older messages were pruned
// so the prompt never implies complete coverage (docs/memory.md §7.3). Budgets
// keep the combined prompt (history + 12K operator message + scaffolding) near
// ~22K worst case — under the 32,767 CreateProcess limit for argv-passed
// prompts. Caveat: .cmd-shimmed CLIs run through cmd.exe, whose ~8K line limit
// the operator-message clamp alone can already exceed (pre-existing; the codex
// adapter avoids argv via stdin).
export function transcriptLines(state, { excludeId, limit, clamp, budget, maxTokens } = {}) {
  const history = queryHistory(state, { excludeId, limit, clamp, budget, maxTokens });
  const lines = history.entries.map((entry) => {
    const label = entry.type && entry.type !== 'message' ? ` [${entry.type}]` : '';
    return `- ${entry.sourceName}${label}: ${entry.content}`;
  });
  if (history.omitted > 0) {
    lines.unshift(`- [${history.omitted} earlier message${history.omitted === 1 ? '' : 's'} pruned to fit the context budget]`);
  }
  return lines;
}

export function promptForTask(task, agent, state, memoryBlock = null) {
  const teammates = state.agents
    .filter((entry) => entry.id !== agent.id && entry.status === 'installed')
    .map((entry) => {
      const current = entry.currentTaskId && state.tasks.find((item) => item.id === entry.currentTaskId);
      return `- ${entry.name}${roleSuffix(state, entry.id)}: ${entry.activity}${current ? ` on “${clampText(current.title, 120)}”` : ''}`;
    });
  // Depth is budget-governed: the limit is a sanity cap for floods of tiny messages.
  const recent = memoryBlock ? null : transcriptLines(state, { limit: 40, clamp: 400, budget: 5_000 });
  const activityHeader = memoryBlock ? 'Room memory and activity context (untrusted):' : 'Recent room activity (newest last):';
  const activityLines = memoryBlock ? [memoryBlock] : (recent.length ? recent : ['- none']);
  return [
    `You are ${agent.name}, working alongside other coding agents in a Conclave room.`,
    ...identityLines(state, agent),
    `Workspace: ${state.room.workspace}`,
    `Access granted for this run: ${task.accessMode}.`,
    `Task: ${task.title}`,
    ...(task.objective.trim() === task.title.trim() ? [] : [task.objective]),
    ...(task.source ? ['', 'Source message this task was promoted from:', `- ${task.source.sourceName}: ${clampText(task.source.content, 2_000)}`] : []),
    '',
    'Teammates in this room:',
    ...(teammates.length ? teammates : ['- none available']),
    '',
    activityHeader,
    ...activityLines,
    '',
    'Coordinate through the workspace: follow AGENTS.md, and update COORDINATION.md to claim files before editing them and to leave a handoff when done. Your final reply is posted to the room where teammates and the operator read it.',
    'Work only on this task and within the workspace. Report concrete conclusions, changes, commands, and validation evidence.',
    'Do not claim an action or result that did not occur. Do not expose secrets or hidden reasoning.',
    'Finish with a concise handoff that another agent or the human operator can verify.'
  ].join('\n');
}

export function promptForChat(message, agent, state, memoryBlock = null) {
  const recent = memoryBlock ? null : transcriptLines(state, { excludeId: message.id, limit: 60, clamp: 600, budget: 9_000 });
  const unleashed = state.room.trust === 'unleashed';
  // Unleashed rooms let any agent dispatch a plan block; gated rooms restrict
  // task assignment to the Coordinator and route everything else through the operator.
  const mayPlan = unleashed || state.room.coordinatorId === agent.id;
  const activityHeader = memoryBlock ? 'Room memory and conversation context (untrusted):' : 'Recent room conversation (newest last):';
  const activityLines = memoryBlock ? [memoryBlock] : (recent.length ? recent : ['- none']);
  return [
    `You are ${agent.name}, participating in the general chat of a Conclave room.`,
    ...identityLines(state, agent),
    `Workspace: ${state.room.workspace}`,
    'This is one read-only conversational turn, not a coding task.',
    'Do not modify files, claim work, or report that implementation was completed in THIS reply.',
    unleashed
      ? 'This is an UNLEASHED room: a plan block you include (format below) becomes Board tasks that run automatically — including workspace-write and commands — with no operator gate. Propose real, scoped work when the operator asks for it.'
      : mayPlan
        ? 'You may coordinate work through a plan block (described below); Conclave creates the assignments and runs eligible tasks through the room scheduler.'
        : 'Do not create tasks. If the operator is asking for code changes, explain that they should use Assign task, New task, or ask the Coordinator to plan.',
    ...(mayPlan ? coordinatorPlanLines(state) : []),
    '',
    activityHeader,
    ...activityLines,
    '',
    'Latest operator message:',
    clampText(message.content, 12_000),
    '',
    `Reply directly to that message as ${agent.name}. Keep the response useful and concise.`,
    'Optional: you may restyle your own participant card by ending a reply with a fenced block — ```conclave-identity',
    '{"emoji": "🦉", "color": "#8de5d6", "tagline": "up to 80 characters"}',
    '``` — all fields optional, colors are 6-digit hex.',
    'Do not expose secrets or hidden reasoning.'
  ].join('\n');
}

export class ConclaveApp {
  constructor({
    workspace = projectDir,
    storeFile = dataFile,
    memoryDbPath,
    sessionToken,
    openAccess = false,
    summaryOptions = {},
    summaryDebounceMs = 500,
    sqliteMemory = false,
    idleWatchdogIntervalMs,
    idleWatchdogCheckMs,
    processOutputFlushMs = 40
  } = {}) {
    this.sqliteMemoryEnabled = sqliteMemory || (process.env.CONCLAVE_SQLITE_MEMORY === '1') || false;
    // Per-boot session secret for mutating routes (PRD 23.4): agents launched as
    // child processes never learn it, so a local process cannot decide approvals,
    // author policy, or assign roles. CONCLAVE_TOKEN pins it across restarts.
    // openAccess (CONCLAVE_OPEN_ACCESS) drops the token check entirely for
    // trusted single-operator LANs — the Host/Origin CSRF guards still apply.
    this.sessionToken = sessionToken || crypto.randomBytes(24).toString('base64url');
    this.openAccess = openAccess;
    this.clients = new Set();
    this.store = new JsonStore(storeFile, path.resolve(workspace));
    this.processes = new ProcessManager({ onEvent: (event) => this.onProcessEvent(event) });
    this.server = http.createServer((request, response) => this.handle(request, response));
    // Rolling room summary (Tier 2 JSON bridge): deterministic producer, debounced.
    this.summaryOptions = summaryOptions;
    this.summaryDebounceMs = summaryDebounceMs;
    this._summaryTimer = null;
    this._summaryRefreshChain = Promise.resolve();
    this._closed = false;
    this.memoryDb = null;
    this.memorySyncHealthy = false;
    // The sidecar follows CONCLAVE_STATE instead of the mutable workspace. This
    // keeps the JSON source of truth and its rebuildable index together.
    this.memoryDbPath = memoryDbPath || path.join(path.dirname(path.resolve(storeFile)), 'memory.db');
    // Idle watchdog: periodic Board wake when nothing has run/queued recently.
    // CONCLAVE_IDLE_INTERVAL_MS=0 disables. Defaults follow OpenClaw-style cadence.
    const envInterval = Number(process.env.CONCLAVE_IDLE_INTERVAL_MS);
    const envCheck = Number(process.env.CONCLAVE_IDLE_CHECK_MS);
    this.idleWatchdogIntervalMs = idleWatchdogIntervalMs ?? (Number.isFinite(envInterval) ? envInterval : DEFAULT_IDLE_INTERVAL_MS);
    this.idleWatchdogCheckMs = idleWatchdogCheckMs ?? (Number.isFinite(envCheck) ? envCheck : DEFAULT_IDLE_CHECK_MS);
    this._idleWatchdogTimer = null;
    this._idleWatchdogChain = Promise.resolve();
    // Agent CLIs can emit hundreds of lines in a burst. Keep those lines in
    // arrival order, but persist them as one short batch so operator messages
    // do not queue behind one full-state rewrite per line.
    this.processOutputFlushMs = Math.max(0, Number(processOutputFlushMs) || 0);
    this._processOutputBatch = null;
    this._processOutputChain = Promise.resolve();
  }

  async initialize() {
    await this.store.load();
    if (this.sqliteMemoryEnabled) {
      const dbPath = this.memoryDbPath;
      try {
        if (dbPath !== ':memory:') {
          await mkdir(path.dirname(dbPath), { recursive: true });
        }
        this.memoryDb = new MemoryDb(dbPath);
        this.memoryDb.init();
        await this.syncStateToSqlite();
        const originalUpdate = this.store.update.bind(this.store);
        this.store.update = async (mutator) => {
          const result = await originalUpdate(mutator);
          try {
            await this.syncStateToSqlite();
          } catch (error) {
            this.memorySyncHealthy = false;
            console.error('SQLite memory sync failed; prompt recall remains disabled until a clean sync:', publicError(error));
          }
          return result;
        };
      } catch (error) {
        this.memorySyncHealthy = false;
        if (this.memoryDb) {
          try { this.memoryDb.close(); } catch {}
          this.memoryDb = null;
        }
        console.error('SQLite memory initialization failed; using JSON transcript fallback:', publicError(error));
      }
    }
    const verifiedAgents = new Set(this.store.state.executions
      .filter((execution) => ['agent', 'chat'].includes(execution.kind) && execution.status === 'completed')
      .map((execution) => execution.agentId));
    const agents = (await detectAgents()).map((agent) => verifiedAgents.has(agent.id)
      ? { ...agent, connection: 'verified', lastAction: 'Verified by a successful execution' }
      : agent);
    const workspace = await inspectWorkspace(this.store.state.room.workspace);
    await this.store.update((state) => {
      state.agents = agents;
      state.workspace = workspace;
      state.identities ??= {};
      state.executions.filter((entry) => entry.status === 'running').forEach((entry) => {
        entry.status = 'interrupted';
        entry.finishedAt = now();
      });
      state.tasks.forEach((task) => {
        task.dependencies ??= [];
        task.attempts ??= 0;
        if (task.status !== 'active' && task.status !== 'ready') return;
        task.blocker = task.status === 'active'
          ? 'Conclave restarted while this task was active.'
          : 'Conclave restarted while this task was queued.';
        task.status = 'blocked';
        task.updatedAt = now();
      });
      state.chatTurns.forEach((turn) => {
        if (turn.status !== 'active' && turn.status !== 'queued') return;
        const previousStatus = turn.status;
        turn.status = 'interrupted';
        turn.blocker = previousStatus === 'active'
          ? 'Conclave restarted while this chat turn was active.'
          : 'Conclave restarted while this chat turn was queued.';
        turn.updatedAt = now();
      });
      // Catch up rollup/checkpoints after restart without blocking load.
      advanceRoomSummary(state, this.summaryOptions);
    });
    this.startIdleWatchdog();
  }

  startIdleWatchdog() {
    this.stopIdleWatchdog();
    if (!(this.idleWatchdogIntervalMs > 0) || !(this.idleWatchdogCheckMs > 0)) return;
    this._idleWatchdogTimer = setInterval(() => {
      this._idleWatchdogChain = this._idleWatchdogChain
        .then(() => this.tickIdleWatchdog())
        .catch((error) => console.error('Idle watchdog failed:', publicError(error)));
    }, this.idleWatchdogCheckMs);
    if (typeof this._idleWatchdogTimer.unref === 'function') this._idleWatchdogTimer.unref();
  }

  stopIdleWatchdog() {
    if (this._idleWatchdogTimer) {
      clearInterval(this._idleWatchdogTimer);
      this._idleWatchdogTimer = null;
    }
  }

  // Detect Board silence, re-queue recoverable restart-blocked work, announce,
  // and kick the FIFO drainer. Safe to call from tests without waiting on the timer.
  async tickIdleWatchdog() {
    if (this._closed) return { acted: false, reason: 'closed' };
    const result = await this.store.update((state) => applyIdleWatchdog(state, {
      idleIntervalMs: this.idleWatchdogIntervalMs,
      nowMs: Date.now(),
      nowIso: now()
    }));
    if (!result?.acted) return result ?? { acted: false, reason: 'no-result' };
    this.broadcast({ type: 'state.changed', reason: 'idle-watchdog.fired', createdAt: now() });
    await this.startQueuedTasks();
    return result;
  }

  async syncStateToSqlite() {
    const state = this.store.snapshot();
    const db = this.memoryDb;
    if (!db) throw new Error('SQLite memory sidecar is unavailable');

    db.transaction(() => {
      // 1. Sync Workspace
      const wsPath = state.room?.workspace;
      const wsId = memoryWorkspaceId(wsPath) || 'default-ws';
      db.saveWorkspace({
        id: wsId,
        name: state.room?.name ? `${state.room.name} Workspace` : 'Room Workspace',
        path: wsPath || '',
        repositoryIdentity: state.workspace?.repositoryIdentity || 'repo-id'
      });

      // 2. Sync Room
      db.saveRoom({
        id: state.room?.id || 'room-id',
        name: state.room?.name || 'Engineering Room',
        workspaceId: wsId
      });

      // 3. Sync Messages
      const messages = Array.isArray(state.messages) ? state.messages : [];
      for (const msg of messages) {
        db.saveMessage({
          id: msg.id,
          roomId: state.room?.id || 'room-id',
          sequence: msg.seq,
          sourceType: msg.source === 'system' ? 'system' : msg.source === 'user' ? 'user' : 'agent',
          sourceId: msg.sourceId || msg.sourceName || 'actor',
          sourceNameSnapshot: msg.sourceName || msg.source,
          type: msg.type || 'message',
          content: msg.content,
          contentHash: msg.contentHash || crypto.createHash('sha256').update(msg.content).digest('hex'),
          revision: msg.revision || 1,
          parentMessageId: msg.parentMessageId || null,
          threadRootId: msg.threadRootId || null,
          taskId: msg.taskId || null,
          chatTurnId: msg.chatTurnId || null,
          executionId: msg.executionId || null,
          correlationId: msg.correlationId || null,
          causationId: msg.causationId || null,
          createdAt: msg.createdAt,
          timestampStatus: msg.timestampStatus || 'valid',
          finalizedAt: msg.finalizedAt || null,
          redactionState: msg.redactionState || 'none',
          deletedAt: msg.deletedAt || null
        });
      }

      // 4. Sync Summary Checkpoints and Rollups
      const summary = state.summary;
      if (summary) {
        if (Array.isArray(summary.checkpoints)) {
          for (const cp of summary.checkpoints) {
            db.saveCheckpoint({
              id: cp.id,
              roomId: state.room?.id || 'room-id',
              revision: cp.revision || 1,
              status: cp.status || 'current',
              fromSequenceExclusive: cp.fromIndexExclusive || 0,
              throughSequenceInclusive: cp.throughIndexInclusive || 0,
              sourceDigest: cp.sourceDigest || 'digest',
              content: cp.content || '',
              contentHash: cp.contentHash || crypto.createHash('sha256').update(cp.content || '').digest('hex'),
              producerType: cp.producerType || 'system',
              producerId: cp.producerId || 'conclave',
              generatedAt: cp.generatedAt || now(),
              staleReason: cp.staleReason || null
            });
          }
        }
        if (summary.rollup) {
          const rollup = summary.rollup;
          db.saveRollup({
            id: rollup.id,
            roomId: state.room?.id || 'room-id',
            revision: rollup.revision || 1,
            status: rollup.status || 'current',
            throughSequenceInclusive: rollup.throughSequenceInclusive || 0,
            structuredStateDigest: rollup.structuredStateDigest || 'state-dig',
            ledgerDigest: rollup.ledgerDigest || 'ledger-dig',
            content: rollup.content || '',
            contentHash: rollup.contentHash || crypto.createHash('sha256').update(rollup.content || '').digest('hex'),
            producerType: rollup.producerType || 'system',
            producerId: rollup.producerId || 'conclave',
            generatedAt: rollup.generatedAt || now(),
            staleReason: rollup.staleReason || null
          });
        }
      }

      // 5. Sync Curated Memory Items
      const memory = state.memory;
      if (memory) {
        const items = Array.isArray(memory.items) ? memory.items : [];
        const existingIds = new Set(items.map(item => item.id));

        // Purge items from SQLite that are deleted in state. A failure here is
        // privacy-significant, so it must disable recall instead of being hidden.
        const dbItemIds = db.db.prepare('SELECT id FROM memory_items WHERE roomId = ?').all(state.room?.id || 'room-id').map(row => row.id);
        for (const id of dbItemIds) {
          if (!existingIds.has(id)) {
            db.deleteNode(id);
          }
        }

        for (const item of items) {
          db.rememberNode({
            id: item.id,
            roomId: state.room?.id || 'room-id',
            workspaceId: item.workspaceId || wsId,
            kind: item.kind,
            title: item.title,
            statement: item.statement,
            status: item.status,
            scope: item.scope || 'room',
            pinned: item.pinned === true,
            applicability: item.applicability || null,
            authorType: item.authorType || 'operator',
            authorId: item.authorId || 'operator',
            ownerId: item.ownerId || null,
            confidenceLabel: item.confidenceLabel || null,
            supportState: item.supportState || 'available',
            verificationRuleId: item.verificationRuleId || null,
            validFrom: item.validFrom || null,
            reviewAfter: item.reviewAfter || null,
            expiresAt: item.expiresAt || null,
            supersedesItemId: item.supersedesItemId || null,
            supersededByItemId: item.supersededByItemId || null,
            version: item.version || 1,
            createdAt: item.createdAt || now(),
            updatedAt: item.updatedAt || now()
          });
        }

        const revisions = Array.isArray(memory.itemRevisions) ? memory.itemRevisions : [];
        for (const rev of revisions) {
          if (!existingIds.has(rev.itemId)) {
            continue;
          }
          const stmtCheck = db.db.prepare('SELECT id FROM memory_item_revisions WHERE itemId = ? AND version = ?');
          const exists = stmtCheck.get(rev.itemId, rev.version);
          if (!exists) {
            const stmtInsert = db.db.prepare(`
              INSERT INTO memory_item_revisions (itemId, version, title, statement, status, actorId, reason, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmtInsert.run(
              rev.itemId,
              rev.version,
              rev.title || '',
              rev.statement || '',
              rev.status || 'proposed',
              rev.actor || 'operator',
              rev.reason || 'synced',
              rev.createdAt || now()
            );
          }
        }

        const sources = Array.isArray(memory.sources) ? memory.sources : [];
        for (const src of sources) {
          const stmtCheck = db.db.prepare('SELECT id FROM memory_sources WHERE itemId = ? AND sourceId = ?');
          const exists = stmtCheck.get(src.itemId, src.messageId || src.sourceId);
          if (!exists) {
            db.addNodeSource({
              itemId: src.itemId,
              sourceType: src.type || 'message',
              sourceId: src.messageId || src.sourceId,
              sourceRevision: src.messageRevision || src.sourceRevision || 1,
              sourceHash: src.contentHash || src.sourceHash || '',
              excerpt: src.excerpt || '',
              supportRole: src.supportRole || 'required',
              supportState: src.supportState || 'available',
              supportChangedAt: src.supportChangedAt || now(),
              supportChangeReason: src.supportChangeReason || null
            });
          }
        }

        const connections = Array.isArray(memory.connections) ? memory.connections : [];
        for (const conn of connections) {
          db.connectNodes(conn.sourceId, conn.targetId, conn.relationship);
        }
      }
    });
    this.memorySyncHealthy = true;
  }

  /**
   * Schedule an incremental room-summary refresh. Message persistence never waits
   * on this work; failures leave lastError on state.summary and keep history usable.
   */
  scheduleSummaryRefresh(reason = 'activity') {
    if (this._closed) return;
    if (this._summaryTimer) clearTimeout(this._summaryTimer);
    const delay = Math.max(0, this.summaryDebounceMs);
    this._summaryTimer = setTimeout(() => {
      this._summaryTimer = null;
      if (this._closed) return;
      this._summaryRefreshChain = this._summaryRefreshChain
        .catch(() => {})
        .then(() => this.refreshRoomSummary(reason));
    }, delay);
    if (typeof this._summaryTimer.unref === 'function') this._summaryTimer.unref();
  }

  async refreshRoomSummary(reason = 'activity') {
    if (this._closed) return false;
    let changed = false;
    try {
      changed = await this.store.update((state) => advanceRoomSummary(state, this.summaryOptions));
    } catch (error) {
      // Store queue failures are already logged; never surface to message paths.
      // Skip noise when shutting down or the state file path vanished mid-write (tests/teardown).
      if (!this._closed && error?.code !== 'ENOENT') {
        console.error('room summary refresh failed:', error?.message || error);
      }
      return false;
    }
    if (this._closed) return false;
    if (changed) {
      this.broadcast({
        type: 'state.changed',
        reason: 'summary.updated',
        summaryReason: reason,
        createdAt: now()
      });
    }
    return changed;
  }

  broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  queueProcessOutput(event) {
    let batch = this._processOutputBatch;
    if (!batch) {
      let resolve;
      let reject;
      const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      batch = { events: [], promise, resolve, reject, timer: null };
      this._processOutputBatch = batch;
      batch.timer = setTimeout(() => this.startProcessOutputFlush(batch), this.processOutputFlushMs);
    }
    batch.events.push(event);
    return batch.promise;
  }

  startProcessOutputFlush(batch) {
    if (this._processOutputBatch === batch) this._processOutputBatch = null;
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = null;
    const operation = this._processOutputChain.then(() => this.persistProcessOutputs(batch.events));
    // A failed persistence attempt must reject the callers for this batch, but
    // it must not poison later batches (the JsonStore queue has the same rule).
    this._processOutputChain = operation.catch(() => {});
    operation.then(batch.resolve, batch.reject);
    return operation;
  }

  async flushProcessOutput() {
    const batch = this._processOutputBatch;
    if (batch) {
      this.startProcessOutputFlush(batch);
      await batch.promise;
      return;
    }
    await this._processOutputChain;
  }

  async persistProcessOutputs(events) {
    if (!events.length) return;
    await this.store.update((state) => {
      for (const event of events) {
        const execution = state.executions.find((entry) => entry.id === event.executionId);
        const chatTurn = state.chatTurns.find((entry) => entry.executionId === event.executionId);
        if (execution) execution.output = clampText(`${execution.output}${event.stream === 'stderr' ? '[stderr] ' : ''}${event.line}\n`, 120_000);
        if (event.agentId) {
          const summary = summarizeAgentEvent(event.agentId, event.line);
          if (summary && !(chatTurn && summary.startsWith('Usage: '))) {
            const agent = state.agents.find((candidate) => candidate.id === event.agentId);
            const content = clampText(summary);
            const previous = state.messages.at(-1);
            if (previous?.source !== event.agentId || previous?.taskId !== event.taskId
              || previous?.chatTurnId !== chatTurn?.id || previous?.content !== content) {
              state.messages.push({
                id: id('msg'), source: event.agentId, sourceName: agent?.name || event.agentId,
                type: chatTurn ? 'message' : 'progress', content, taskId: event.taskId,
                chatTurnId: chatTurn?.id, createdAt: event.createdAt
              });
            }
          }
        }
        state.audit.push({
          id: id('audit'), type: event.type, executionId: event.executionId,
          taskId: event.taskId, chatTurnId: chatTurn?.id, createdAt: now()
        });
      }
      if (state.audit.length > 2_000) state.audit.splice(0, state.audit.length - 2_000);
    });
    const last = events.at(-1);
    const executionIds = [...new Set(events.map((event) => event.executionId).filter(Boolean))];
    this.broadcast({
      type: 'state.changed', reason: 'execution.output', batchSize: events.length,
      executionId: executionIds.length === 1 ? executionIds[0] : undefined,
      executionIds, createdAt: last.createdAt || now()
    });
    this.scheduleSummaryRefresh('execution.output');
  }

  async onProcessEvent(event) {
    if (event.type === 'execution.output') return this.queueProcessOutput(event);
    // A lifecycle event must never overtake buffered output from the same child.
    // Draining the shared batch also preserves arrival order across concurrent runs.
    await this.flushProcessOutput();
    await this.store.update(async (state) => {
      if (event.type === 'execution.started') {
        state.executions.unshift(event.execution);
      }
      if (event.type === 'execution.cancelling') {
        const execution = state.executions.find((entry) => entry.id === event.executionId);
        if (execution?.agentId) clearAgentSummary(execution.agentId);
      }
      if (event.type === 'execution.finished') {
        const execution = state.executions.find((entry) => entry.id === event.executionId);
        const chatTurn = state.chatTurns.find((entry) => entry.executionId === event.executionId);
        // Plain-text agents (agy) buffer their whole run; land it as one
        // message here so fenced blocks parse and the feed gets one entry.
        // A cancelled Grok run is discarded instead: clear once when cancellation
        // starts and again here in case the dying child emitted late text.
        let flushedSummary = null;
        if (event.agentId) {
          if (event.status === 'cancelled') clearAgentSummary(event.agentId);
          else flushedSummary = flushAgentSummary(event.agentId);
        }
        if (flushedSummary) {
          const flushAgent = state.agents.find((entry) => entry.id === event.agentId);
          state.messages.push({
            id: id('msg'), source: event.agentId, sourceName: flushAgent?.name || event.agentId,
            type: chatTurn ? 'message' : 'progress', content: clampText(flushedSummary),
            taskId: event.taskId, chatTurnId: chatTurn?.id, createdAt: event.finishedAt || now()
          });
        }
        if (execution) Object.assign(execution, {
          status: event.status, exitCode: event.exitCode, signal: event.signal, finishedAt: event.finishedAt
        });
        if (event.taskId) {
          const task = state.tasks.find((entry) => entry.id === event.taskId);
          if (task) {
            // Autopilot governs tasks and commands only — never chat turns.
            // An unleashed room is always live and always auto-accepts.
            const unleashed = state.room.trust === 'unleashed';
            const live = (state.policy?.enabled || unleashed) && !state.room.paused;
            if (event.status === 'completed') {
              const autoResolve = task.origin === 'message' && task.accessMode === 'read-only';
              const autoAccept = !autoResolve && live && (unleashed || state.policy.autoAcceptReviews);
              task.status = autoResolve || autoAccept ? 'completed' : 'review-required';
              if (autoAccept) {
                state.audit.push({
                  id: id('audit'), type: 'task.auto-accepted', taskId: task.id, executionId: event.executionId,
                  decidedBy: 'autopilot', createdAt: now()
                });
                state.messages.push({
                  id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'autopilot',
                  content: clampText(`Autopilot accepted “${task.title}” after a successful run.`),
                  taskId: task.id, createdAt: event.finishedAt
                });
              }
            } else if (event.status === 'failed') {
              // Auto-retry applies to failed runs only, never to cancelled ones.
              // A retry reuses the task's original write approval by design:
              // approvals authorize the task, not one execution — the same
              // semantic as manual requeue — and retries are bounded by
              // maxAttempts and opt-in via policy.autoRetry.
              const gate = live && state.policy.autoRetry.enabled;
              if (gate && (task.attempts ?? 0) < state.policy.autoRetry.maxAttempts) {
                task.attempts = (task.attempts ?? 0) + 1;
                task.status = 'ready';
                task.blocker = null;
                state.audit.push({
                  id: id('audit'), type: 'task.auto-retried', taskId: task.id, executionId: event.executionId,
                  decidedBy: 'autopilot', detail: `retry ${task.attempts} of ${state.policy.autoRetry.maxAttempts}`, createdAt: now()
                });
                state.messages.push({
                  id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'autopilot',
                  content: clampText(`Autopilot re-queued “${task.title}” after a failed run (retry ${task.attempts} of ${state.policy.autoRetry.maxAttempts}).`),
                  taskId: task.id, createdAt: event.finishedAt
                });
              } else {
                task.status = 'failed';
                if (gate && (task.attempts ?? 0) >= state.policy.autoRetry.maxAttempts) {
                  task.blocker = `Automatic retries exhausted after ${task.attempts} retries.`;
                }
              }
            } else {
              task.status = event.status;
            }
            task.updatedAt = event.finishedAt;
            task.executionId = event.executionId;
          }
        }
        if (chatTurn) Object.assign(chatTurn, {
          status: event.status, blocker: event.status === 'completed' ? null : `Agent run ${event.status}.`,
          updatedAt: event.finishedAt, executionId: event.executionId
        });
        if (chatTurn && event.status === 'completed') {
          this.applyCoordinatorPlan(state, chatTurn);
          this.applyIdentityBlock(state, chatTurn);
        }
        if (event.agentId) {
          const agent = state.agents.find((entry) => entry.id === event.agentId);
          if (agent) Object.assign(agent, {
            activity: 'idle', currentTaskId: null, currentChatTurnId: null,
            connection: event.status === 'completed' ? 'verified' : event.status === 'cancelled' ? agent.connection : 'error',
            lastAction: chatTurn
              ? event.status === 'completed' ? 'Replied in general chat' : `Chat reply ${event.status}`
              : event.status === 'completed' ? 'Run finished; awaiting review' : `Run ${event.status}`
          });
        }
        if (chatTurn) {
          if (event.status !== 'completed') {
            const agent = state.agents.find((entry) => entry.id === event.agentId);
            state.messages.push({
              id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'blocker',
              content: `${agent?.name || event.agentId} could not reply because the chat run ${event.status}.`,
              chatTurnId: chatTurn.id, executionId: event.executionId, createdAt: event.finishedAt
            });
          }
        } else {
          state.messages.push({
            id: id('msg'), source: 'system', sourceName: 'Conclave', type: event.status === 'completed' ? 'review' : 'blocker',
            content: `Execution ${event.status}${event.exitCode === null ? '' : ` with exit code ${event.exitCode}`}.`,
            taskId: event.taskId, executionId: event.executionId, createdAt: event.finishedAt
          });
          try {
            state.workspace = await inspectWorkspace(state.room.workspace);
          } catch (error) {
            state.audit.push({ id: id('audit'), type: 'workspace.refresh-failed', detail: publicError(error), createdAt: now() });
          }
        }
      }
      const chatTurn = state.chatTurns.find((entry) => entry.executionId === event.executionId);
      state.audit.push({
        id: id('audit'), type: event.type, executionId: event.executionId,
        taskId: event.taskId, chatTurnId: chatTurn?.id, createdAt: now()
      });
      if (state.audit.length > 2_000) state.audit.splice(0, state.audit.length - 2_000);
    });
    const chatTurn = this.store.state.chatTurns.find((entry) => entry.executionId === event.executionId);
    this.broadcast({
      type: 'state.changed', reason: event.type,
      executionId: event.executionId || event.execution?.id,
      taskId: event.taskId || event.execution?.taskId,
      chatTurnId: chatTurn?.id,
      createdAt: event.createdAt || event.finishedAt || event.execution?.startedAt || now()
    });
    // Finish paths often append messages; refresh rollup asynchronously.
    if (event.type === 'execution.finished') this.scheduleSummaryRefresh(event.type);
    if (event.type === 'execution.finished') await this.startQueuedTasks();
  }

  // Mutation applied to a task whose dependencies can never complete. Runs
  // inside a store.update mutator. A blocked task can never be started from its
  // approval, so any pending gate expires (a requeue mints a fresh one).
  blockForDependencies(state, task, blocker) {
    Object.assign(task, { status: 'blocked', blocker, updatedAt: now() });
    state.approvals.filter((entry) => entry.taskId === task.id && entry.status === 'pending')
      .forEach((entry) => Object.assign(entry, { status: 'expired', decidedAt: now(), decidedBy: 'system', reason: blocker }));
    state.audit.push({ id: id('audit'), type: 'task.dependency-blocked', taskId: task.id, detail: blocker, createdAt: now() });
    state.messages.push({
      id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'blocker',
      content: clampText(`“${task.title}” is blocked: ${blocker}`), taskId: task.id, createdAt: now()
    });
  }

  // Blocks every ready/waiting task whose dependencies reached a terminal bad
  // status (failed/rejected/cancelled) or vanished. Idempotent.
  async applyDependencyBlocks() {
    if (!selectDependencyBlocked(this.store.state.tasks).length) return;
    const blocked = await this.store.update((state) => {
      const hits = selectDependencyBlocked(state.tasks);
      for (const hit of hits) {
        this.blockForDependencies(state, state.tasks.find((entry) => entry.id === hit.id), hit.blocker);
      }
      return hits.map((entry) => entry.id);
    });
    for (const taskId of blocked) this.broadcast({ type: 'state.changed', reason: 'task.dependency-blocked', taskId });
  }

  async startQueuedTasks() {
    await this.applyDependencyBlocks();
    const attempted = new Set();
    while (true) {
      const state = this.store.state;
      if (state.room.paused) return;
      if (this.processes.load >= state.room.limits.maxConcurrentRuns) return;
      const busyAgents = new Set(state.agents.filter((entry) => entry.activity === 'running').map((entry) => entry.id));
      const writerActive = state.tasks.some((entry) => entry.status === 'active' && entry.accessMode === 'workspace-write');
      const tasksById = new Map(state.tasks.map((entry) => [entry.id, entry]));
      const messageSequence = new Map(state.messages.map((entry, index) => [entry.id,
        Number.isSafeInteger(entry.seq) ? entry.seq : index + 1]));
      const taskFallbackOrder = new Map([...state.tasks].reverse().map((entry, index) => [entry.id, index]));
      const chatFallbackOrder = new Map([...state.chatTurns].reverse().map((entry, index) => [entry.id, index]));
      const candidates = [
        ...state.tasks.filter((entry) => entry.status === 'ready'
          && !attempted.has(`task:${entry.id}`)
          && !busyAgents.has(entry.agentId)
          && !(entry.accessMode === 'workspace-write' && writerActive)
          && unmetDependencies(tasksById, entry).length === 0)
          .map((entry) => ({ kind: 'task', entry })),
        ...state.chatTurns.filter((entry) => entry.status === 'queued'
          && !attempted.has(`chat:${entry.id}`)
          && !busyAgents.has(entry.agentId))
          .map((entry) => ({ kind: 'chat', entry }))
      ].sort((left, right) => {
        // `updatedAt` is the time an entry most recently joined the runnable
        // queue. A failed task retry therefore goes behind chats that were
        // already waiting, instead of monopolizing its agent via old createdAt.
        const queuedAt = String(left.entry.updatedAt || left.entry.createdAt || '')
          .localeCompare(String(right.entry.updatedAt || right.entry.createdAt || ''));
        if (queuedAt) return queuedAt;
        if (left.kind === 'chat' && right.kind === 'chat') {
          const messageOrder = (messageSequence.get(left.entry.messageId) ?? Number.MAX_SAFE_INTEGER)
            - (messageSequence.get(right.entry.messageId) ?? Number.MAX_SAFE_INTEGER);
          if (messageOrder) return messageOrder;
          const recipientOrder = (left.entry.recipientIndex ?? 0) - (right.entry.recipientIndex ?? 0);
          if (recipientOrder) return recipientOrder;
          return (chatFallbackOrder.get(left.entry.id) ?? 0) - (chatFallbackOrder.get(right.entry.id) ?? 0);
        }
        if (left.kind !== right.kind) return left.kind === 'chat' ? -1 : 1;
        return (taskFallbackOrder.get(left.entry.id) ?? 0) - (taskFallbackOrder.get(right.entry.id) ?? 0);
      });
      const queued = candidates[0];
      if (!queued) return;
      attempted.add(`${queued.kind}:${queued.entry.id}`);
      try {
        if (queued.kind === 'task') await this.startTask(queued.entry.id);
        else await this.startChatTurn(queued.entry.id);
      } catch (error) {
        await this.store.update((next) => {
          if (queued.kind === 'task') {
            const liveTask = next.tasks.find((entry) => entry.id === queued.entry.id);
            if (liveTask) Object.assign(liveTask, { status: 'blocked', blocker: publicError(error), updatedAt: now() });
          } else {
            const liveTurn = next.chatTurns.find((entry) => entry.id === queued.entry.id);
            if (liveTurn) Object.assign(liveTurn, { status: 'failed', blocker: publicError(error), updatedAt: now() });
          }
          next.audit.push({
            id: id('audit'), type: `${queued.kind}.queue-start-failed`,
            taskId: queued.kind === 'task' ? queued.entry.id : undefined,
            chatTurnId: queued.kind === 'chat' ? queued.entry.id : undefined,
            detail: publicError(error), createdAt: now()
          });
        });
        this.broadcast({
          type: 'state.changed', reason: `${queued.kind}.blocked`,
          taskId: queued.kind === 'task' ? queued.entry.id : undefined,
          chatTurnId: queued.kind === 'chat' ? queued.entry.id : undefined
        });
      }
    }
  }

  async startTask(taskId) {
    const state = this.store.snapshot();
    const task = state.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error('Task not found');
    const agent = state.agents.find((entry) => entry.id === task.agentId);
    if (!agent || agent.status !== 'installed') throw new Error('Assigned agent is unavailable');
    const activeWriter = task.accessMode === 'workspace-write'
      ? state.tasks.find((entry) =>
        entry.id !== task.id && entry.status === 'active' && entry.accessMode === 'workspace-write')
      : null;
    const agentBusyOn = state.tasks.find((entry) =>
      entry.id !== task.id && entry.status === 'active' && entry.agentId === task.agentId);
    const agentBusyChat = state.chatTurns.find((entry) => entry.status === 'active' && entry.agentId === task.agentId);
    const tasksById = new Map(state.tasks.map((entry) => [entry.id, entry]));
    const unmet = unmetDependencies(tasksById, task);
    const waitReason = state.room.paused ? 'the room resumes'
      : unmet.length ? `it is no longer waiting on “${tasksById.get(unmet[0])?.title ?? unmet[0]}”`
      : activeWriter ? `“${activeWriter.title}” releases the workspace; one agent writes at a time`
      : agentBusyOn ? `${agent.name} finishes “${agentBusyOn.title}”; one run per agent at a time`
      : agentBusyChat || agent.activity === 'running' ? `${agent.name} finishes the current chat reply; one run per agent at a time`
      : this.processes.load >= state.room.limits.maxConcurrentRuns ? 'a concurrent run slot frees up'
      : null;
    if (waitReason) {
      await this.store.update((next) => {
        const liveTask = next.tasks.find((entry) => entry.id === taskId);
        liveTask.status = 'ready';
        liveTask.updatedAt = now();
        next.messages.push({
          id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
          content: `Queued “${task.title}” until ${waitReason}.`,
          taskId, createdAt: now()
        });
      });
      this.broadcast({ type: 'state.changed', reason: 'task.queued', taskId });
      return null;
    }
    let memoryBlock = null;
    if (this.sqliteMemoryEnabled && this.memorySyncHealthy && this.memoryDb) {
      try {
        const workspaceId = memoryWorkspaceId(state.room?.workspace);
        const marker = '__CONCLAVE_MEMORY_CONTEXT__';
        const nonMemoryLength = promptForTask(task, agent, state, marker).length - marker.length;
        const res = assembleContext(this.memoryDb, {
          roomId: state.room.id,
          workspaceId,
          queryText: task.objective || task.title,
          maxCharacters: 24000,
          executionId: taskId,
          nonMemoryLength
        });
        memoryBlock = res.memoryBlock;
        this.memoryDb.saveContextReceipt(res.receipt, res.entries);
      } catch (err) {
        console.error("Context assembly failed, fallback to JSON verbatim:", err);
      }
    }
    const invocation = buildAgentInvocation(agent.id, {
      executable: agent.executable,
      prompt: promptForTask(task, agent, state, memoryBlock),
      workspace: state.room.workspace,
      accessMode: task.accessMode,
      elevated: state.room.trust === 'unleashed'
    });
    // Check-and-reserve atomically inside the serialized store queue: the earlier
    // waitReason pass ran on a snapshot, so a concurrent start (a second drainer,
    // an HTTP requeue/transition, a resume) could have won in the meantime. Only
    // the caller whose mutator still sees a startable task and free capacity
    // flips it to active; everyone else backs off without side effects.
    let reserved = false;
    const won = await this.store.update((next) => {
      const liveTask = next.tasks.find((entry) => entry.id === taskId);
      if (!liveTask || !['ready', 'waiting'].includes(liveTask.status)) return false;
      if (next.room.paused) return false;
      const liveAgent = next.agents.find((entry) => entry.id === task.agentId);
      if (!liveAgent || liveAgent.status !== 'installed' || liveAgent.activity === 'running') return false;
      if (liveTask.accessMode === 'workspace-write' && next.tasks.some((entry) =>
        entry.id !== taskId && entry.status === 'active' && entry.accessMode === 'workspace-write')) return false;
      if (this.processes.load >= next.room.limits.maxConcurrentRuns) return false;
      this.processes.reserve();
      reserved = true;
      liveTask.status = 'active';
      liveTask.updatedAt = now();
      liveAgent.activity = 'running';
      liveAgent.currentTaskId = taskId;
      liveAgent.currentChatTurnId = null;
      liveAgent.lastAction = task.title;
      next.messages.push({
        id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'delegation',
        content: `Assigned “${task.title}” to ${liveAgent.name} with ${task.accessMode} access.`, taskId, createdAt: now()
      });
      return true;
    }).catch((error) => {
      if (reserved) { this.processes.release(); reserved = false; }
      throw error;
    });
    if (!won) {
      // Lost the race after passing the snapshot checks. Leave the task drainable:
      // an approved write task must not strand in 'waiting', which the drainer skips.
      await this.store.update((next) => {
        const liveTask = next.tasks.find((entry) => entry.id === taskId);
        if (liveTask?.status === 'waiting') { liveTask.status = 'ready'; liveTask.updatedAt = now(); }
      });
      return null;
    }
    try {
      const execution = this.processes.start({
        taskId, agentId: agent.id, invocation, cwd: state.room.workspace, purpose: task.objective
      });
      await this.store.update((next) => {
        const liveTask = next.tasks.find((entry) => entry.id === taskId);
        liveTask.executionId = execution.id;
      });
      this.broadcast({ type: 'state.changed', reason: 'task.started', taskId });
      return execution;
    } finally {
      // The child is registered in processes.running synchronously by start(),
      // so the reservation has served its purpose either way.
      if (reserved) this.processes.release();
    }
  }

  async startChatTurn(chatTurnId) {
    const state = this.store.snapshot();
    const turn = state.chatTurns.find((entry) => entry.id === chatTurnId);
    if (!turn) throw new Error('Chat turn not found');
    const agent = state.agents.find((entry) => entry.id === turn.agentId);
    if (!agent || agent.status !== 'installed') throw new Error('Selected agent is unavailable');
    const waitReason = state.room.paused || agent.activity === 'running'
      || this.processes.load >= state.room.limits.maxConcurrentRuns;
    if (waitReason) return null;
    const message = state.messages.find((entry) => entry.id === turn.messageId);
    if (!message) throw new Error('Chat message not found');
    let memoryBlock = null;
    if (this.sqliteMemoryEnabled && this.memorySyncHealthy && this.memoryDb) {
      try {
        const workspaceId = memoryWorkspaceId(state.room?.workspace);
        const marker = '__CONCLAVE_MEMORY_CONTEXT__';
        const nonMemoryLength = promptForChat(message, agent, state, marker).length - marker.length;
        const res = assembleContext(this.memoryDb, {
          roomId: state.room.id,
          workspaceId,
          queryText: message.content,
          excludeMessageId: message.id,
          maxCharacters: 24000,
          executionId: chatTurnId,
          nonMemoryLength
        });
        memoryBlock = res.memoryBlock;
        this.memoryDb.saveContextReceipt(res.receipt, res.entries);
      } catch (err) {
        console.error("Context assembly failed, fallback to JSON verbatim:", err);
      }
    }
    const invocation = buildAgentInvocation(agent.id, {
      executable: agent.executable,
      prompt: promptForChat(message, agent, state, memoryBlock),
      workspace: state.room.workspace,
      accessMode: 'read-only'
    });
    // Same atomic check-and-reserve as startTask: re-validate on live state inside
    // the serialized store queue so concurrent drains cannot double-start a turn.
    let reserved = false;
    const won = await this.store.update((next) => {
      const liveTurn = next.chatTurns.find((entry) => entry.id === chatTurnId);
      if (!liveTurn || liveTurn.status !== 'queued') return false;
      if (next.room.paused) return false;
      const liveAgent = next.agents.find((entry) => entry.id === turn.agentId);
      if (!liveAgent || liveAgent.status !== 'installed' || liveAgent.activity === 'running') return false;
      if (this.processes.load >= next.room.limits.maxConcurrentRuns) return false;
      this.processes.reserve();
      reserved = true;
      liveTurn.status = 'active';
      liveTurn.blocker = null;
      liveTurn.updatedAt = now();
      liveAgent.activity = 'running';
      liveAgent.currentTaskId = null;
      liveAgent.currentChatTurnId = chatTurnId;
      liveAgent.lastAction = 'Replying in general chat';
      return true;
    }).catch((error) => {
      if (reserved) { this.processes.release(); reserved = false; }
      throw error;
    });
    if (!won) return null; // still queued; a later drain retries
    try {
      const execution = this.processes.start({
        taskId: null, agentId: agent.id, kind: 'chat', invocation,
        cwd: state.room.workspace, purpose: message.content
      });
      await this.store.update((next) => {
        const liveTurn = next.chatTurns.find((entry) => entry.id === chatTurnId);
        liveTurn.executionId = execution.id;
      });
      this.broadcast({ type: 'state.changed', reason: 'chat.started', chatTurnId });
      return execution;
    } finally {
      if (reserved) this.processes.release();
    }
  }

  async createChatTurn(message, agent, { retryOf = null } = {}) {
    const createdAt = now();
    const turn = {
      id: id('chat'), messageId: message.id, agentId: agent.id, status: 'queued',
      blocker: null, executionId: null, retryOf, recipientIndex: 0, createdAt, updatedAt: createdAt
    };
    await this.store.update((state) => {
      state.chatTurns.unshift(turn);
      state.audit.push({ id: id('audit'), type: 'chat.created', chatTurnId: turn.id, agentId: agent.id, createdAt });
    });
    this.broadcast({ type: 'state.changed', reason: 'chat.created', chatTurnId: turn.id });
    await this.startChatTurn(turn.id);
    return turn;
  }

  // Turns a completed chat turn's ```conclave-plan``` block into Board tasks.
  // Gated rooms: only the Coordinator may assign work. Read-only tasks land
  // 'ready'; write tasks request approval and follow the configured policy.
  // Unleashed rooms: ANY agent may propose, tasks land 'ready' (write tasks get
  // an auto-approved write approval) and the drainer runs them. Runs inside
  // store.update. Non-coordinator plan blocks in gated rooms are inert text.
  applyCoordinatorPlan(state, chatTurn) {
    const unleashed = state.room.trust === 'unleashed';
    if (!unleashed && (!state.room.coordinatorId || chatTurn.agentId !== state.room.coordinatorId)) return;
    const message = state.messages.find((entry) =>
      entry.chatTurnId === chatTurn.id && entry.source === chatTurn.agentId && entry.content.includes('```conclave-plan'));
    if (!message) return;
    const coordinator = state.agents.find((entry) => entry.id === chatTurn.agentId);
    const reject = (why) => {
      state.audit.push({ id: id('audit'), type: 'plan.invalid', chatTurnId: chatTurn.id, detail: clampText(why, 2_000), createdAt: now() });
      state.messages.push({
        id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
        content: clampText(`${coordinator?.name ?? chatTurn.agentId}'s plan block could not be read (${why}); no tasks were proposed.`, 2_000),
        chatTurnId: chatTurn.id, createdAt: now()
      });
    };
    const block = message.content.match(PLAN_BLOCK);
    // An opening fence without a closing one usually means the reply was clamped;
    // losing the plan silently would look like the feature simply failed.
    if (!block) return reject('the plan block has no closing fence — the reply may have been truncated');
    let entries;
    try { entries = JSON.parse(block[1]); } catch { return reject('invalid JSON'); }
    if (!Array.isArray(entries) || !entries.length) return reject('expected a non-empty JSON array');
    const skipped = [];
    if (entries.length > PLAN_TASK_CAP) skipped.push(`${entries.length - PLAN_TASK_CAP} beyond the ${PLAN_TASK_CAP}-task cap`);
    const accepted = []; // { task, originalIndex, dependsOn }
    entries.slice(0, PLAN_TASK_CAP).forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null) return skipped.push(`#${index + 1}: not an object`);
      const title = clampText(String(entry.title ?? ''), 160).trim();
      if (!title) return skipped.push(`#${index + 1}: missing title`);
      const agent = state.agents.find((candidate) => candidate.id === entry.agentId);
      if (!agent) return skipped.push(`“${title}”: unknown agent ${clampText(String(entry.agentId), 80)}`);
      const createdAt = now();
      accepted.push({
        originalIndex: index,
        dependsOn: Array.isArray(entry.dependsOn) ? entry.dependsOn : [],
        task: {
          id: id('task'), title,
          objective: clampText(String(entry.objective ?? title), 12_000).trim() || title,
          agentId: agent.id,
          accessMode: entry.accessMode === 'workspace-write' ? 'workspace-write' : 'read-only',
          priority: ['critical', 'high', 'medium', 'low', 'none'].includes(entry.priority) ? entry.priority : 'none',
          origin: 'coordinator', proposedBy: chatTurn.agentId,
          source: { messageId: message.id, sourceName: message.sourceName, content: clampText(message.content, 2_000), createdAt: message.createdAt },
          archivedAt: null,
          status: entry.accessMode === 'workspace-write' && !unleashed ? 'waiting' : 'ready',
          dependencies: [], attempts: 0,
          blocker: null, executionId: null, createdAt, updatedAt: createdAt
        }
      });
    });
    if (!accepted.length) return reject(skipped.join('; ') || 'no valid tasks');
    const byOriginalIndex = new Map(accepted.map((entry) => [entry.originalIndex, entry.task]));
    for (const entry of accepted) {
      const kept = [];
      for (const ref of new Set(entry.dependsOn)) {
        if (Number.isInteger(ref) && ref < entry.originalIndex && byOriginalIndex.has(ref)) {
          kept.push(byOriginalIndex.get(ref).id);
        } else {
          // A dependency on a skipped or invalid entry must not vanish silently:
          // the operator would otherwise approve a task missing its prerequisite.
          skipped.push(`“${entry.task.title}”: dropped dependency on invalid or skipped entry #${Number.isInteger(ref) ? ref + 1 : String(ref)}`);
        }
      }
      entry.task.dependencies = kept;
    }
    state.tasks.unshift(...accepted.map((entry) => entry.task).reverse());
    // Write assignments always carry an approval record. Unleashed rooms approve
    // it directly; gated rooms apply the operator-authored autopilot policy and
    // otherwise leave the task waiting for a human decision.
    for (const { task } of accepted) {
      if (task.accessMode !== 'workspace-write') continue;
      const agent = state.agents.find((entry) => entry.id === task.agentId);
      const approval = this.buildWriteApproval(state, task, agent);
      state.approvals.unshift(approval);
      if (unleashed) {
        this.recordAutoApproval(state, approval, {
          reason: 'unleashed room auto-approves plan write access', taskId: task.id, agentId: agent.id,
          subject: `workspace-write for ${agent.name} on “${task.title}”`
        });
        continue;
      }
      const verdict = evaluateAutoApproval(state, approval, { running: this.processes.running.size });
      if (verdict.code === 'rate-capped') {
        state.audit.push({ id: id('audit'), type: 'autopilot.rate-capped', approvalId: approval.id, createdAt: now() });
      }
      if (verdict.allow) {
        task.status = 'ready';
        this.recordAutoApproval(state, approval, {
          reason: verdict.reason, taskId: task.id, agentId: agent.id,
          subject: `workspace-write for ${agent.name} on “${task.title}”`
        });
      }
    }
    const proposer = coordinator?.name ?? chatTurn.agentId;
    const verb = unleashed ? 'Dispatched' : 'Assigned';
    message.content = message.content.replace(PLAN_BLOCK,
      `[${verb} ${accepted.length} task${accepted.length === 1 ? '' : 's'} to the Board]`);
    state.audit.push({
      id: id('audit'), type: 'plan.dispatched', chatTurnId: chatTurn.id, agentId: chatTurn.agentId,
      detail: clampText(`${verb.toLowerCase()} ${accepted.length}${skipped.length ? `; skipped: ${skipped.join('; ')}` : ''}; raw plan: ${block[0]}`, 8_000),
      createdAt: now()
    });
    state.messages.push({
      id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
      content: clampText(unleashed
        ? `${proposer} dispatched ${accepted.length} task${accepted.length === 1 ? '' : 's'} to the Board — they run automatically (unleashed room).${skipped.length ? ` Skipped: ${skipped.join('; ')}.` : ''}`
        : `${proposer} assigned ${accepted.length} task${accepted.length === 1 ? '' : 's'} to the Board. Eligible tasks run as assignees become idle; workspace-write tasks remain approval-gated unless room policy approved them.${skipped.length ? ` Skipped: ${skipped.join('; ')}.` : ''}`, 2_000),
      chatTurnId: chatTurn.id, createdAt: now()
    });
  }

  // Agents may restyle their own participant card by ending a chat reply with a
  // ```conclave-identity``` block. Cosmetic and self-scoped only: the block can
  // never name another agent, values are strictly validated, and everything is
  // rendered escaped on the client — an agent styles its card, nothing else.
  // Runs inside store.update.
  applyIdentityBlock(state, chatTurn) {
    const message = state.messages.find((entry) =>
      entry.chatTurnId === chatTurn.id && entry.source === chatTurn.agentId && entry.content.includes('```conclave-identity'));
    if (!message) return;
    const agent = state.agents.find((entry) => entry.id === chatTurn.agentId);
    const reject = (why) => {
      state.audit.push({ id: id('audit'), type: 'identity.invalid', chatTurnId: chatTurn.id, agentId: chatTurn.agentId, detail: clampText(why, 500), createdAt: now() });
      state.messages.push({
        id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
        content: clampText(`${agent?.name ?? chatTurn.agentId}'s card update could not be read (${why}).`, 500),
        chatTurnId: chatTurn.id, createdAt: now()
      });
    };
    const block = message.content.match(IDENTITY_BLOCK);
    if (!block) return reject('the identity block has no closing fence — the reply may have been truncated');
    let input;
    try { input = JSON.parse(block[1]); } catch { return reject('invalid JSON'); }
    let identity;
    try { identity = validateIdentity(input); } catch (error) { return reject(error.message); }
    state.identities ??= {};
    state.identities[chatTurn.agentId] = {
      ...state.identities[chatTurn.agentId], ...identity, updatedAt: now(), source: 'agent'
    };
    message.content = message.content.replace(IDENTITY_BLOCK, '[Updated their participant card]').trim();
    state.audit.push({
      id: id('audit'), type: 'identity.updated', agentId: chatTurn.agentId, chatTurnId: chatTurn.id,
      detail: clampText(JSON.stringify(identity), 300), createdAt: now()
    });
    state.messages.push({
      id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
      content: `${agent?.name ?? chatTurn.agentId} refreshed their participant card.`,
      chatTurnId: chatTurn.id, createdAt: now()
    });
  }

  // Fresh pending workspace-write approval for a task. Runs inside store.update.
  buildWriteApproval(state, task, agent) {
    // Approval previews deliberately exclude recalled memory. The live prompt is
    // assembled from the then-current snapshot only after approval, preventing a
    // second durable copy of recalled bodies in state.json approval history.
    const preview = buildAgentInvocation(agent.id, {
      executable: agent.executable,
      prompt: promptForTask(task, agent, state),
      workspace: state.room.workspace,
      accessMode: task.accessMode,
      // This only renders the approval command; an active Grok stream must keep
      // its accumulator until the real invocation starts or is cancelled.
      resetSummary: false
    });
    return {
      id: id('approval'), type: 'agent-write', status: 'pending', taskId: task.id, agentId: agent.id,
      title: `${agent.name} requests workspace-write access`,
      detail: task.objective, impact: `May create or modify files under ${state.room.workspace}. The agent sandbox remains scoped to the workspace.`,
      command: displayInvocation(preview), cwd: state.room.workspace, createdAt: now(), decidedAt: null, decidedBy: null, reason: null
    };
  }

  // Marks an approval as decided by the operator-authored policy. Runs inside
  // store.update. Agents never approve their own authority — the policy is the
  // operator's standing decision.
  recordAutoApproval(state, approval, { reason, taskId = null, agentId = null, subject }) {
    Object.assign(approval, { status: 'auto-approved', decidedAt: now(), decidedBy: 'autopilot', reason });
    state.audit.push({
      id: id('audit'), type: 'approval.auto-approved', approvalId: approval.id,
      taskId, agentId, decidedBy: 'autopilot', reason, createdAt: approval.decidedAt
    });
    state.messages.push({
      id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'autopilot',
      content: clampText(`Autopilot approved ${subject}: ${reason}.`), taskId, createdAt: approval.decidedAt
    });
  }

  // Rolls a decided approval back to pending after startTask throws, so the
  // request is recoverable from the Approval Center instead of being consumed.
  async revertFailedStart(taskId, approvalId, error, type) {
    const detail = publicError(error);
    await this.store.update((state) => {
      const approval = state.approvals.find((entry) => entry.id === approvalId);
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (approval && ['approved', 'auto-approved'].includes(approval.status)) {
        // A task deleted between the approval commit and the start can never be
        // started; re-pending its approval would resurrect an undecidable ghost.
        // Expire it (mirroring deleteBoardTask's expiry of pending gates) and
        // only re-pend for the genuine pause/agent-unavailable retry cases.
        if (task) Object.assign(approval, { status: 'pending', decidedAt: null, decidedBy: null, reason: null });
        else Object.assign(approval, { status: 'expired', decidedAt: now(), decidedBy: 'system', reason: 'Task deleted' });
      }
      if (task?.status === 'active' && !task.executionId) {
        Object.assign(task, { status: 'waiting', updatedAt: now() });
        const agent = state.agents.find((entry) => entry.id === task.agentId);
        if (agent?.currentTaskId === taskId) Object.assign(agent, { activity: 'idle', currentTaskId: null });
      }
      state.audit.push({ id: id('audit'), type, approvalId, taskId, detail, createdAt: now() });
      state.messages.push({
        id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'autopilot',
        content: clampText(task
          ? `Could not start the run (${detail}); the request was returned to the Approval Center for manual review.`
          : `Could not start the run (${detail}); the task was deleted, so its approval expired.`),
        taskId, createdAt: now()
      });
    });
    this.broadcast({ type: 'state.changed', reason: type, taskId });
  }

  async startTaskViaAutopilot(taskId, approvalId) {
    try { await this.startTask(taskId); }
    catch (error) { await this.revertFailedStart(taskId, approvalId, error, 'autopilot.start-failed'); }
  }

  async createTask(input) {
    const title = clampText(input.title || 'Untitled task', 160).trim();
    const objective = clampText(input.objective, 12_000).trim();
    const accessMode = input.accessMode === 'workspace-write' ? 'workspace-write' : 'read-only';
    if (!objective) throw new Error('Task objective is required');
    const agent = this.store.state.agents.find((entry) => entry.id === input.agentId);
    if (!agent) throw new Error('Select a supported agent');
    if (agent.status !== 'installed') throw new Error(`${agent.name} is unavailable`);
    const priority = ['critical', 'high', 'medium', 'low', 'none'].includes(input.priority) ? input.priority : 'none';
    const dependencies = validateDependencies(this.store.state.tasks, input.dependencies, null);
    const createdAt = now();
    const task = {
      id: id('task'), title, objective, agentId: agent.id, accessMode, priority,
      origin: ['message', 'promoted'].includes(input.origin) ? input.origin : 'operator',
      source: input.source || null, archivedAt: null,
      status: accessMode === 'workspace-write' ? 'waiting' : 'ready',
      dependencies, attempts: 0, blocker: null, executionId: null, createdAt, updatedAt: createdAt
    };
    const outcome = await this.store.update((state) => {
      state.tasks.unshift(task);
      state.audit.push({ id: id('audit'), type: 'task.created', taskId: task.id, agentId: agent.id, createdAt });
      const approval = accessMode === 'workspace-write' ? this.buildWriteApproval(state, task, agent) : null;
      if (approval) state.approvals.unshift(approval);
      const failed = failedDependencies(new Map(state.tasks.map((entry) => [entry.id, entry])), task);
      if (failed.length) {
        this.blockForDependencies(state, task, failed.join(' '));
        return { blocked: true, autoApprovedId: null };
      }
      if (approval) {
        const verdict = evaluateAutoApproval(state, approval, { running: this.processes.running.size });
        if (verdict.code === 'rate-capped') {
          state.audit.push({ id: id('audit'), type: 'autopilot.rate-capped', approvalId: approval.id, createdAt: now() });
        }
        if (verdict.allow) {
          this.recordAutoApproval(state, approval, {
            reason: verdict.reason, taskId: task.id, agentId: agent.id,
            subject: `workspace-write for ${agent.name} on “${task.title}”`
          });
          return { blocked: false, autoApprovedId: approval.id };
        }
      }
      return { blocked: false, autoApprovedId: null };
    });
    this.broadcast({ type: 'state.changed', reason: 'task.created', taskId: task.id });
    if (outcome.autoApprovedId) await this.startTaskViaAutopilot(task.id, outcome.autoApprovedId);
    else if (!outcome.blocked && accessMode === 'read-only') await this.startTask(task.id);
    return task;
  }

  async decideApproval(approvalId, decision) {
    if (!['approved', 'denied'].includes(decision)) throw new Error('Decision must be approved or denied');
    let approval;
    await this.store.update((state) => {
      approval = state.approvals.find((entry) => entry.id === approvalId);
      if (!approval) throw new Error('Approval request not found');
      if (approval.status !== 'pending') throw new Error('Approval request was already decided');
      approval.status = decision;
      approval.decidedAt = now();
      approval.decidedBy = 'user';
      state.audit.push({ id: id('audit'), type: `approval.${decision}`, approvalId, createdAt: approval.decidedAt });
      if (approval.taskId && decision === 'denied') {
        const task = state.tasks.find((entry) => entry.id === approval.taskId);
        if (task) Object.assign(task, { status: 'rejected', updatedAt: approval.decidedAt });
      }
    });
    if (decision === 'approved') {
      if (approval.type === 'agent-write') {
        try {
          await this.startTask(approval.taskId);
        } catch (error) {
          // Do not consume the approval on a failed start: return it to pending
          // so the request stays recoverable, then surface the failure.
          await this.revertFailedStart(approval.taskId, approval.id, error, 'approval.start-failed');
          throw error;
        }
      }
      if (approval.type === 'command') this.startCommand(approval);
    } else if (approval.taskId) {
      // A rejected task is a terminally-bad dependency: re-evaluate dependents.
      await this.startQueuedTasks();
    }
    this.broadcast({ type: 'state.changed', reason: `approval.${decision}`, approvalId });
    return approval;
  }

  startCommand(approval) {
    const invocation = process.platform === 'win32'
      ? { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', approval.command] }
      : { command: '/bin/sh', args: ['-lc', approval.command] };
    return this.processes.start({ kind: 'command', invocation, cwd: approval.cwd, purpose: approval.detail });
  }

  async handleApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/state') {
      return json(response, 200, projectStateForApi(this.store.snapshot(), {
        includeMemoryContent: this.hasExplicitSessionAuthority(request),
        memoryEngine: {
          sqliteEnabled: this.sqliteMemoryEnabled,
          recallHealthy: this.sqliteMemoryEnabled && this.memorySyncHealthy && Boolean(this.memoryDb),
          retrieval: this.sqliteMemoryEnabled ? 'lexical-only' : 'json-transcript-fallback',
          semanticEnabled: false,
          backupRestoreEnabled: false
        }
      }));
    }
    const outputMatch = routeMatch(url.pathname, /^\/api\/executions\/([^/]+)\/output$/);
    if (request.method === 'GET' && outputMatch) {
      const execution = this.store.state.executions.find((entry) => entry.id === outputMatch[1]);
      if (!execution) throw new Error('Execution not found');
      const output = execution.output || '';
      return json(response, 200, { id: execution.id, status: execution.status, outputSize: output.length, output });
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'
      });
      response.write(`data: ${JSON.stringify({ type: 'connected', createdAt: now() })}\n\n`);
      this.clients.add(response);
      request.on('close', () => this.clients.delete(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const task = await this.createTask(await readJsonBody(request));
      return json(response, 201, task);
    }
    if (request.method === 'POST' && url.pathname === '/api/messages') {
      const input = await readJsonBody(request);
      const content = clampText(input.content, 12_000).trim();
      if (!content) throw new Error('Message is required');
      const hasExplicitRecipients = Array.isArray(input.agentIds);
      const requestedIds = hasExplicitRecipients
        ? [...new Set(input.agentIds.filter((agentId) => typeof agentId === 'string'))]
        : this.store.state.agents
          .filter((agent) => new RegExp(`@${agent.id}\\b`, 'i').test(content))
          .map((agent) => agent.id);
      const recipients = requestedIds.map((agentId) => this.store.state.agents.find((agent) => agent.id === agentId));
      if (recipients.some((agent) => !agent)) throw new Error('Select a supported agent');
      if (recipients.some((agent) => agent.status !== 'installed')) throw new Error('A selected agent is unavailable');
      const createdAt = now();
      const message = { id: id('msg'), source: 'user', sourceName: 'You', type: 'message', content, createdAt };
      const turns = recipients.map((agent, recipientIndex) => ({
        id: id('chat'), messageId: message.id, agentId: agent.id, status: 'queued',
        blocker: null, executionId: null, retryOf: null, recipientIndex, createdAt, updatedAt: createdAt
      }));
      // Preserve room chronology: output that arrived before this request lands
      // first, but as at most one coalesced write rather than one write per line.
      await this.flushProcessOutput();
      // Admission is one serialized commit: an output burst can delay at most
      // this single write, and clients never observe a message without all of
      // its requested reply turns (or a partial recipient set).
      await this.store.update((state) => {
        const maxTurns = state.room.limits.maxTurnsPerAgent;
        for (const agent of recipients) {
          const liveAgent = state.agents.find((entry) => entry.id === agent.id);
          if (!liveAgent) throw new Error('Select a supported agent');
          if (liveAgent.status !== 'installed') throw new Error('A selected agent is unavailable');
          const pending = state.chatTurns.filter((turn) =>
            turn.agentId === agent.id && ['active', 'queued'].includes(turn.status)).length;
          if (pending >= maxTurns) throw new Error(`${liveAgent.name} already has ${maxTurns} chat replies pending`);
        }
        state.messages.push(message);
        state.chatTurns.unshift(...turns);
        for (const turn of turns) {
          state.audit.push({
            id: id('audit'), type: 'chat.created', chatTurnId: turn.id,
            agentId: turn.agentId, createdAt
          });
        }
      });
      this.scheduleSummaryRefresh('message.created');
      this.broadcast({
        type: 'state.changed', reason: 'message.created', messageId: message.id,
        chatTurnIds: turns.map((turn) => turn.id)
      });
      json(response, 201, { message, tasksCreated: 0, chatTurnsCreated: turns.length });
      // The durable 201 is independent of prompt construction and process
      // launch. The drainer still performs atomic capacity reservations.
      void this.startQueuedTasks().catch((error) => console.error('chat queue drain failed:', publicError(error)));
      return;
    }
    const promoteMatch = routeMatch(url.pathname, /^\/api\/messages\/([^/]+)\/promote$/);
    if (request.method === 'POST' && promoteMatch) {
      const message = this.store.state.messages.find((entry) => entry.id === promoteMatch[1]);
      if (!message) throw new Error('Message not found');
      const input = await readJsonBody(request);
      const task = await this.createTask({
        ...input,
        origin: 'promoted',
        source: {
          messageId: message.id, sourceName: message.sourceName,
          content: clampText(message.content, 12_000), createdAt: message.createdAt
        }
      });
      return json(response, 201, task);
    }
    const chatCancelMatch = routeMatch(url.pathname, /^\/api\/chat-turns\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && chatCancelMatch) {
      const turn = this.store.state.chatTurns.find((entry) => entry.id === chatCancelMatch[1]);
      if (!turn) throw new Error('Chat turn not found');
      if (turn.status === 'queued') {
        await this.store.update((state) => {
          const live = state.chatTurns.find((entry) => entry.id === turn.id);
          Object.assign(live, { status: 'cancelled', blocker: 'Cancelled by the operator before it started.', updatedAt: now() });
          state.audit.push({ id: id('audit'), type: 'chat.cancelled', chatTurnId: turn.id, createdAt: now() });
        });
        this.broadcast({ type: 'state.changed', reason: 'chat.cancelled', chatTurnId: turn.id });
        return json(response, 200, { status: 'cancelled' });
      }
      if (turn.status === 'active' && turn.executionId && this.processes.cancel(turn.executionId)) {
        return json(response, 202, { status: 'cancelling' });
      }
      throw new Error('Chat turn is not queued or running');
    }
    const chatRetryMatch = routeMatch(url.pathname, /^\/api\/chat-turns\/([^/]+)\/retry$/);
    if (request.method === 'POST' && chatRetryMatch) {
      const turn = this.store.state.chatTurns.find((entry) => entry.id === chatRetryMatch[1]);
      if (!turn) throw new Error('Chat turn not found');
      if (!['failed', 'interrupted', 'cancelled'].includes(turn.status)) {
        throw new Error('Only failed, interrupted, or cancelled chat replies can be retried');
      }
      const message = this.store.state.messages.find((entry) => entry.id === turn.messageId);
      if (!message) throw new Error('The original chat message no longer exists');
      const agent = this.store.state.agents.find((entry) => entry.id === turn.agentId);
      if (!agent || agent.status !== 'installed') throw new Error('The agent for this reply is unavailable');
      const retried = await this.createChatTurn(message, agent, { retryOf: turn.id });
      return json(response, 201, retried);
    }
    const identityMatch = routeMatch(url.pathname, /^\/api\/agents\/([^/]+)\/identity$/);
    if (request.method === 'POST' && identityMatch) {
      const agent = this.store.state.agents.find((entry) => entry.id === identityMatch[1]);
      if (!agent) throw new Error('Unknown agent');
      const input = await readJsonBody(request);
      const identity = input.reset === true ? null : validateIdentity(input);
      await this.store.update((state) => {
        state.identities ??= {};
        if (identity) {
          state.identities[agent.id] = { ...state.identities[agent.id], ...identity, updatedAt: now(), source: 'operator' };
        } else {
          delete state.identities[agent.id];
        }
        state.audit.push({
          id: id('audit'), type: identity ? 'identity.updated' : 'identity.reset',
          agentId: agent.id, decidedBy: 'user', createdAt: now()
        });
      });
      this.broadcast({ type: 'state.changed', reason: 'identity.updated', agentId: agent.id });
      return json(response, 200, { identity: this.store.state.identities[agent.id] ?? null });
    }
    // Tier 3 curated facts ledger (docs/memory.md §6, §9). Mutations are
    // operator-only via the session token gate above; concurrent edits are
    // rejected with 409 through the ledger's expectedVersion check.
    if (request.method === 'POST' && url.pathname === '/api/memory/items') {
      const input = await readJsonBody(request);
      let created;
      await this.store.update((state) => {
        created = createMemoryItem(state, input);
        state.audit.push({
          id: id('audit'), type: 'memory.proposed', memoryItemId: created.item.id,
          decidedBy: 'user', createdAt: now()
        });
      });
      this.broadcast({ type: 'state.changed', reason: 'memory.proposed', memoryItemId: created.item.id });
      return json(response, 201, created);
    }
    const memoryPinMatch = routeMatch(url.pathname, /^\/api\/memory\/items\/([^/]+)\/pin$/);
    const memorySourceMatch = routeMatch(url.pathname, /^\/api\/memory\/items\/([^/]+)\/sources$/);
    const memoryItemMatch = routeMatch(url.pathname, /^\/api\/memory\/items\/([^/]+)$/);
    if (request.method === 'POST' && (memoryPinMatch || memorySourceMatch || memoryItemMatch)) {
      const input = await readJsonBody(request);
      try {
        let result;
        let auditType;
        await this.store.update((state) => {
          if (memoryPinMatch) {
            const item = setMemoryItemPinned(state, memoryPinMatch[1], input);
            result = { item };
            auditType = 'memory.pinned';
            state.audit.push({
              id: id('audit'), type: auditType, memoryItemId: item.id, pinned: item.pinned,
              decidedBy: 'user', createdAt: now()
            });
          } else if (memorySourceMatch) {
            result = addMemorySource(state, memorySourceMatch[1], input);
            auditType = 'memory.source-added';
            state.audit.push({
              id: id('audit'), type: auditType, memoryItemId: result.item.id,
              memorySourceId: result.source.id, messageId: result.source.messageId,
              decidedBy: 'user', createdAt: now()
            });
          } else {
            const item = reviseMemoryItem(state, memoryItemMatch[1], input);
            result = { item };
            auditType = 'memory.revised';
            state.audit.push({
              id: id('audit'), type: auditType, memoryItemId: item.id, version: item.version,
              decidedBy: 'user', createdAt: now()
            });
          }
        });
        this.broadcast({ type: 'state.changed', reason: auditType, memoryItemId: result.item.id });
        return json(response, 200, result);
      } catch (error) {
        if (error.code === 'memory-version-conflict') return json(response, 409, { error: publicError(error) });
        throw error;
      }
    }
    if (request.method === 'DELETE' && memoryItemMatch) {
      let deleted = false;
      await this.store.update((state) => {
        const memory = ensureMemoryState(state);
        const index = memory.items.findIndex((item) => item.id === memoryItemMatch[1]);
        if (index !== -1) {
          memory.items.splice(index, 1);
          memory.sources = memory.sources.filter((edge) => edge.itemId !== memoryItemMatch[1]);
          memory.itemRevisions = memory.itemRevisions.filter((rev) => rev.itemId !== memoryItemMatch[1]);
          deleted = true;
          state.audit.push({
            id: id('audit'), type: 'memory.deleted', memoryItemId: memoryItemMatch[1],
            decidedBy: 'user', createdAt: now()
          });
        }
      });
      if (deleted) {
        this.broadcast({ type: 'state.changed', reason: 'memory.deleted', memoryItemId: memoryItemMatch[1] });
        return json(response, 200, { success: true });
      } else {
        return json(response, 404, { error: 'Memory item not found' });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/roles') {
      const input = await readJsonBody(request);
      const agentsById = new Map(this.store.state.agents.map((entry) => [entry.id, entry]));
      const coordinatorId = input.coordinatorId ? String(input.coordinatorId) : null;
      if (coordinatorId) {
        const agent = agentsById.get(coordinatorId);
        if (!agent) throw new Error('Coordinator must be a known agent');
        if (agent.status !== 'installed') throw new Error(`${agent.name} is not installed and cannot coordinate`);
      }
      const roles = {};
      if (input.roles !== undefined) {
        if (typeof input.roles !== 'object' || input.roles === null || Array.isArray(input.roles)) {
          throw new Error('roles must be an object mapping agent ids to role lists');
        }
        for (const [agentId, list] of Object.entries(input.roles)) {
          if (!agentsById.has(agentId)) throw new Error(`Unknown agent ${agentId}`);
          if (!Array.isArray(list) || list.some((role) => !SPECIALIST_ROLES.includes(role))) {
            throw new Error(`Roles must be among: ${SPECIALIST_ROLES.join(', ')}`);
          }
          if (list.length) roles[agentId] = [...new Set(list)];
        }
      }
      await this.store.update((state) => {
        state.room.coordinatorId = coordinatorId;
        state.room.roles = roles;
        const summary = [
          coordinatorId ? `${agentsById.get(coordinatorId).name} is now Coordinator` : 'The room is human-coordinated',
          ...Object.entries(roles).map(([agentId, list]) => `${agentsById.get(agentId).name}: ${list.join(', ')}`)
        ].join(' · ');
        state.audit.push({ id: id('audit'), type: 'roles.updated', detail: summary, createdAt: now() });
        state.messages.push({
          id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
          content: `Roles updated — ${summary}.`, createdAt: now()
        });
      });
      this.broadcast({ type: 'state.changed', reason: 'roles.updated' });
      return json(response, 200, { coordinatorId, roles });
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks/archive-legacy') {
      const terminal = ['completed', 'failed', 'cancelled', 'rejected'];
      const archivedIds = [];
      await this.store.update((state) => {
        state.tasks.forEach((task) => {
          if (task.origin !== 'message' || !terminal.includes(task.status) || task.archivedAt) return;
          task.archivedAt = now();
          task.updatedAt = now();
          archivedIds.push(task.id);
        });
        if (archivedIds.length) {
          state.audit.push({
            id: id('audit'), type: 'task.legacy-archived',
            detail: `archived ${archivedIds.length}: ${archivedIds.join(', ')}`, createdAt: now()
          });
        }
      });
      if (archivedIds.length) this.broadcast({ type: 'state.changed', reason: 'task.legacy-archived' });
      return json(response, 200, { archived: archivedIds.length });
    }
    const transitionMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/transitions$/);
    if (request.method === 'POST' && transitionMatch) {
      const input = await readJsonBody(request);
      const task = this.store.state.tasks.find((entry) => entry.id === transitionMatch[1]);
      if (!task) throw new Error('Task not found');
      if (task.status !== 'proposed' || !['ready', 'rejected'].includes(input.to)) {
        throw new Error(`Cannot transition '${task.status}' to '${String(input.to)}'; supported transitions are proposed → ready and proposed → rejected`);
      }
      if (input.to === 'rejected') {
        await this.store.update((state) => {
          const live = state.tasks.find((entry) => entry.id === task.id);
          Object.assign(live, { status: 'rejected', updatedAt: now() });
          state.audit.push({ id: id('audit'), type: 'task.transitioned', taskId: task.id, detail: 'proposed → rejected (dismissed)', createdAt: now() });
        });
        this.broadcast({ type: 'state.changed', reason: 'task.transitioned', taskId: task.id });
        await this.startQueuedTasks(); // a dismissed proposal is a terminally-bad dependency
        return json(response, 200, { ok: true });
      }
      if (!String(task.objective || '').trim()) throw new Error('Task needs a non-empty objective before it can be marked ready');
      const agent = this.store.state.agents.find((entry) => entry.id === task.agentId);
      if (!agent || agent.status !== 'installed') throw new Error('Assigned agent is unavailable');
      await this.store.update((state) => {
        const live = state.tasks.find((entry) => entry.id === task.id);
        const liveAgent = state.agents.find((entry) => entry.id === live.agentId);
        // A write task cannot enter the run queue on its own authority: it goes to
        // waiting with a pending approval, exactly like creation and requeue.
        const hasAuthority = live.accessMode !== 'workspace-write'
          || state.approvals.some((entry) => entry.taskId === live.id && ['approved', 'auto-approved'].includes(entry.status));
        if (!hasAuthority) {
          Object.assign(live, { status: 'waiting', blocker: null, updatedAt: now() });
          state.approvals.unshift(this.buildWriteApproval(state, live, liveAgent));
          state.audit.push({ id: id('audit'), type: 'task.transitioned', taskId: live.id, detail: 'proposed → waiting (approval required)', createdAt: now() });
          return;
        }
        Object.assign(live, { status: 'ready', blocker: null, updatedAt: now() });
        state.audit.push({ id: id('audit'), type: 'task.transitioned', taskId: live.id, detail: 'proposed → ready', createdAt: now() });
      });
      this.broadcast({ type: 'state.changed', reason: 'task.transitioned', taskId: task.id });
      await this.startQueuedTasks();
      return json(response, 200, { ok: true });
    }
    const deleteTaskMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)$/);
    if (request.method === 'DELETE' && deleteTaskMatch) {
      const input = await readJsonBody(request);
      let deletion;
      try {
        deletion = await this.store.update((state) => deleteBoardTask(state, deleteTaskMatch[1], {
          confirmTaskId: input.confirmTaskId,
          deletionId: id('task-delete'),
          deletedAt: now()
        }));
      } catch (error) {
        if (error.code === 'task-active') return json(response, 409, { error: publicError(error) });
        throw error;
      }
      this.broadcast({ type: 'state.changed', reason: 'task.deleted', taskId: deletion.taskId });
      return json(response, 200, { deleted: true, deletion });
    }
    const archiveMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/(archive|unarchive)$/);
    if (request.method === 'POST' && archiveMatch) {
      const archiving = archiveMatch[2] === 'archive';
      await this.store.update((state) => {
        const task = state.tasks.find((entry) => entry.id === archiveMatch[1]);
        if (!task) throw new Error('Task not found');
        if (archiving && !['completed', 'failed', 'cancelled', 'rejected'].includes(task.status)) {
          throw new Error('Only completed, failed, cancelled, or rejected tasks can be archived');
        }
        task.archivedAt = archiving ? now() : null;
        task.updatedAt = now();
        state.audit.push({ id: id('audit'), type: `task.${archiveMatch[2]}d`, taskId: task.id, createdAt: now() });
      });
      this.broadcast({ type: 'state.changed', reason: `task.${archiveMatch[2]}d`, taskId: archiveMatch[1] });
      return json(response, 200, { ok: true });
    }
    const executionCancelMatch = routeMatch(url.pathname, /^\/api\/executions\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && executionCancelMatch) {
      if (!this.processes.cancel(executionCancelMatch[1])) throw new Error('Execution is not running');
      return json(response, 202, { status: 'cancelling' });
    }
    const approvalMatch = routeMatch(url.pathname, /^\/api\/approvals\/([^/]+)$/);
    if (request.method === 'POST' && approvalMatch) {
      const input = await readJsonBody(request);
      return json(response, 200, await this.decideApproval(approvalMatch[1], input.decision));
    }
    const cancelMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      const task = this.store.state.tasks.find((entry) => entry.id === cancelMatch[1]);
      if (!task) throw new Error('Task not found');
      if (!task.executionId || !this.processes.cancel(task.executionId)) throw new Error('Task is not running');
      return json(response, 202, { status: 'cancelling' });
    }
    const requeueMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/requeue$/);
    if (request.method === 'POST' && requeueMatch) {
      await this.store.update((state) => {
        const task = state.tasks.find((entry) => entry.id === requeueMatch[1]);
        if (!task) throw new Error('Task not found');
        if (task.status !== 'blocked') throw new Error('Only blocked tasks can be requeued');
        state.audit.push({ id: id('audit'), type: 'task.requeued', taskId: task.id, createdAt: now() });
        // A dep-blocked task re-checks its gate: still-failed dependencies re-block it.
        const failed = failedDependencies(new Map(state.tasks.map((entry) => [entry.id, entry])), task);
        if (failed.length) {
          this.blockForDependencies(state, task, failed.join(' '));
          return;
        }
        // A write task whose approval expired while blocked must not restart on
        // its own authority: it returns to waiting with a fresh pending approval.
        const hasAuthority = task.accessMode !== 'workspace-write'
          || state.approvals.some((entry) => entry.taskId === task.id && ['approved', 'auto-approved'].includes(entry.status));
        if (!hasAuthority) {
          const agent = state.agents.find((entry) => entry.id === task.agentId);
          if (!agent || agent.status !== 'installed') throw new Error('Assigned agent is unavailable');
          Object.assign(task, { status: 'waiting', blocker: null, updatedAt: now() });
          state.approvals.unshift(this.buildWriteApproval(state, task, agent));
          return;
        }
        Object.assign(task, { status: 'ready', blocker: null, updatedAt: now() });
      });
      this.broadcast({ type: 'state.changed', reason: 'task.requeued', taskId: requeueMatch[1] });
      await this.startQueuedTasks();
      return json(response, 200, { ok: true });
    }
    const reviewMatch = routeMatch(url.pathname, /^\/api\/tasks\/([^/]+)\/review$/);
    if (request.method === 'POST' && reviewMatch) {
      const input = await readJsonBody(request);
      await this.store.update((state) => {
        const task = state.tasks.find((entry) => entry.id === reviewMatch[1]);
        if (!task) throw new Error('Task not found');
        task.status = input.accepted ? 'completed' : 'rejected';
        task.updatedAt = now();
      });
      this.broadcast({ type: 'state.changed', reason: 'task.reviewed', taskId: reviewMatch[1] });
      // The verdict changes dependents: completed deps free them, rejected deps block them.
      await this.startQueuedTasks();
      return json(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/room/trust') {
      const input = await readJsonBody(request);
      if (!['gated', 'unleashed'].includes(input.trust)) throw new Error('trust must be "gated" or "unleashed"');
      await this.store.update((state) => {
        state.room.trust = input.trust;
        state.audit.push({ id: id('audit'), type: 'room.trust-changed', detail: input.trust, decidedBy: 'user', createdAt: now() });
        state.messages.push({
          id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
          content: input.trust === 'unleashed'
            ? 'Room set to UNLEASHED — agent plans dispatch and run automatically with full workspace and command access. Approvals are bypassed; the audit log still records everything.'
            : 'Room set to GATED — the Coordinator can assign read-only work; writes and commands follow room approval policy.',
          createdAt: now()
        });
      });
      this.broadcast({ type: 'state.changed', reason: 'room.trust-changed' });
      if (input.trust === 'unleashed') await this.startQueuedTasks();
      return json(response, 200, { trust: input.trust });
    }
    if (request.method === 'POST' && url.pathname === '/api/policy') {
      const policy = validatePolicy(await readJsonBody(request));
      await this.store.update((state) => {
        state.policy = policy;
        state.audit.push({ id: id('audit'), type: 'policy.updated', createdAt: now() });
        state.messages.push({
          id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
          content: `Autopilot policy updated: ${policy.enabled ? 'enabled' : 'disabled'} · auto-approve writes ${policy.autoApproveWrites}`
            + ` · ${policy.commandAllowlist.length} allowlisted command pattern${policy.commandAllowlist.length === 1 ? '' : 's'}`
            + ` · auto-accept reviews ${policy.autoAcceptReviews ? 'on' : 'off'}`
            + ` · auto-retry ${policy.autoRetry.enabled ? `up to ${policy.autoRetry.maxAttempts} attempt${policy.autoRetry.maxAttempts === 1 ? '' : 's'}` : 'off'}`
            + ` · at most ${policy.maxAutoApprovalsPerHour} auto-approvals per hour.`,
          createdAt: now()
        });
      });
      this.broadcast({ type: 'state.changed', reason: 'policy.updated' });
      return json(response, 200, this.store.state.policy);
    }
    if (request.method === 'POST' && url.pathname === '/api/commands') {
      const input = await readJsonBody(request);
      const command = clampText(input.command, 4_000).trim();
      const purpose = clampText(input.purpose, 1_000).trim();
      if (!command || !purpose) throw new Error('Command and purpose are required');
      const approval = {
        id: id('approval'), type: 'command', status: 'pending', title: 'Local command approval',
        detail: purpose, impact: 'Runs exactly as entered inside the active project workspace.',
        command, cwd: this.store.state.room.workspace, createdAt: now(), decidedAt: null, decidedBy: null, reason: null
      };
      const verdict = await this.store.update((state) => {
        state.approvals.unshift(approval);
        const evaluated = evaluateAutoApproval(state, approval, { running: this.processes.running.size });
        if (evaluated.code === 'rate-capped') {
          state.audit.push({ id: id('audit'), type: 'autopilot.rate-capped', approvalId: approval.id, createdAt: now() });
        }
        if (evaluated.allow) this.recordAutoApproval(state, approval, { reason: evaluated.reason, subject: `command “${approval.command}”` });
        return evaluated;
      });
      if (verdict.allow) this.startCommand(approval);
      this.broadcast({ type: 'state.changed', reason: verdict.allow ? 'approval.auto-approved' : 'approval.created', approvalId: approval.id });
      return json(response, 201, approval);
    }
    if (request.method === 'POST' && url.pathname === '/api/room/pause') {
      await this.store.update((state) => { state.room.paused = true; });
      this.processes.cancelAll('room-paused');
      this.broadcast({ type: 'state.changed', reason: 'room.paused' });
      return json(response, 200, { paused: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/room/resume') {
      await this.store.update((state) => { state.room.paused = false; });
      this.broadcast({ type: 'state.changed', reason: 'room.resumed' });
      await this.startQueuedTasks();
      return json(response, 200, { paused: false });
    }
    if (request.method === 'POST' && url.pathname === '/api/workspace/refresh') {
      const workspace = await inspectWorkspace(this.store.state.room.workspace);
      await this.store.update((state) => { state.workspace = workspace; });
      this.broadcast({ type: 'state.changed', reason: 'workspace.refreshed' });
      return json(response, 200, workspace);
    }
    if (request.method === 'POST' && url.pathname === '/api/agents/scan') {
      const agents = await detectAgents();
      await this.store.update((state) => {
        const active = new Map(state.agents.map((agent) => [agent.id, agent]));
        state.agents = agents.map((agent) => {
          const prior = active.get(agent.id);
          if (prior?.activity === 'running') {
            return { ...agent, activity: prior.activity, connection: prior.connection, currentTaskId: prior.currentTaskId, lastAction: prior.lastAction };
          }
          if (prior?.connection === 'verified' && agent.status === 'installed') {
            return { ...agent, connection: 'verified', lastAction: prior.lastAction };
          }
          return agent;
        });
        state.audit.push({ id: id('audit'), type: 'agents.scanned', createdAt: now() });
      });
      this.broadcast({ type: 'state.changed', reason: 'agents.scanned' });
      return json(response, 200, agents);
    }
    if (request.method === 'POST' && url.pathname === '/api/workspace') {
      const input = await readJsonBody(request);
      const candidate = path.resolve(clampText(input.path, 2_000));
      const details = await stat(candidate);
      if (!details.isDirectory()) throw new Error('Workspace must be a directory');
      const workspace = await inspectWorkspace(candidate);
      await this.store.update((state) => {
        state.room.workspace = candidate;
        state.workspace = workspace;
        state.messages.push({
          id: id('msg'), source: 'system', sourceName: 'Conclave', type: 'system',
          content: `Workspace changed to ${candidate}`, createdAt: now()
        });
      });
      this.broadcast({ type: 'state.changed', reason: 'workspace.changed' });
      return json(response, 200, { path: candidate, workspace });
    }
    json(response, 404, { error: 'API route not found' });
  }

  async serveStatic(response, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(publicDir, relative);
    if (file !== publicDir && !file.startsWith(`${publicDir}${path.sep}`)) return json(response, 403, { error: 'Forbidden' });
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': contentTypes[path.extname(file)] || 'application/octet-stream' });
      response.end(body);
    } catch (error) {
      if (error.code === 'ENOENT') return json(response, 404, { error: 'Not found' });
      throw error;
    }
  }

  hasSessionAuthority(request) {
    if (this.openAccess) return true;
    return this.hasExplicitSessionAuthority(request);
  }

  hasExplicitSessionAuthority(request) {
    const presented = request.headers['x-conclave-token'] ?? readCookie(request, 'conclave_token');
    return presented !== null && timingSafeStringEqual(presented, this.sessionToken);
  }

  async handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!isTrustedHost(request.headers.host)) return json(response, 403, { error: 'Untrusted Host header' });
        const memoryControlPath = url.pathname === '/api/memory'
          || url.pathname.startsWith('/api/memory/')
          || url.pathname === '/api/backup'
          || url.pathname.startsWith('/api/backup/');
        if (memoryControlPath && !this.hasExplicitSessionAuthority(request)) {
          return json(response, 403, { error: 'Memory governance requires the explicit operator session token' });
        }
        if (request.method !== 'GET') {
          if (!isTrustedOrigin(request.headers.origin, request.headers.host)) {
            return json(response, 403, { error: 'Cross-origin request blocked' });
          }
          // Mutations require the per-boot session token so a local process (or a
          // running agent) cannot decide approvals or rewrite policy and roles.
          if (!this.hasSessionAuthority(request)) {
            return json(response, 403, { error: 'Session token required — open the URL printed in the server console' });
          }
        }
        await this.handleApi(request, response, url);
      } else {
        // Visiting the tokened URL from the console binds this browser to the
        // session: the HttpOnly cookie then authorizes its same-origin mutations.
        if (url.searchParams.get('token') !== null && timingSafeStringEqual(url.searchParams.get('token'), this.sessionToken)) {
          response.setHeader('set-cookie', `conclave_token=${this.sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
        }
        await this.serveStatic(response, url.pathname);
      }
    } catch (error) {
      json(response, 400, { error: publicError(error) });
    }
  }

  listen({ port = 4317, host = '127.0.0.1' } = {}) {
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server.address())));
  }

  close() {
    this._closed = true;
    this.stopIdleWatchdog();
    if (this._summaryTimer) {
      clearTimeout(this._summaryTimer);
      this._summaryTimer = null;
    }
    this.processes.cancelAll('server-shutdown');
    for (const client of this.clients) client.end();
    if (this.memoryDb) {
      this.memoryDb.close();
    }
    return new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const openAccess = ['1', 'true', 'yes'].includes(String(process.env.CONCLAVE_OPEN_ACCESS ?? '').toLowerCase());
  const app = new ConclaveApp({
    workspace: process.env.CONCLAVE_WORKSPACE || process.cwd(),
    openAccess,
    ...(process.env.CONCLAVE_STATE ? { storeFile: path.resolve(process.env.CONCLAVE_STATE) } : {}),
    ...(process.env.CONCLAVE_TOKEN ? { sessionToken: process.env.CONCLAVE_TOKEN } : {})
  });
  await app.initialize();
  const address = await app.listen({ port: Number(process.env.PORT || 4317), host: process.env.HOST || '127.0.0.1' });
  if (openAccess) {
    console.log('Conclave is running — OPEN ACCESS mode (no session token required):');
    console.log(`  http://${address.address}:${address.port}/`);
    console.log('(CONCLAVE_OPEN_ACCESS is set: any loopback request may send, approve, and change');
    console.log(' settings. Host/Origin CSRF guards still apply. Intended for a single trusted');
    console.log(' operator on a private machine — unset CONCLAVE_OPEN_ACCESS to require the token.)');
    console.log('Memory governance remains explicitly token-gated; use this URL to unlock it:');
    console.log(`  http://${address.address}:${address.port}/?token=${app.sessionToken}`);
  } else {
    console.log('Conclave is running — open this exact URL to unlock actions in your browser:');
    console.log(`  http://${address.address}:${address.port}/?token=${app.sessionToken}`);
    console.log('(General reading is open on loopback; memory content, sending, approving, and settings need this session token.');
    console.log(' Set CONCLAVE_TOKEN to pin the token across restarts, or CONCLAVE_OPEN_ACCESS=1 to drop it.)');
  }
  console.log(`Workspace: ${app.store.state.room.workspace}`);
}
