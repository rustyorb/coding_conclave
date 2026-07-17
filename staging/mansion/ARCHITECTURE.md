# Mansion Architecture — Domain Boundaries & APIs

**Status:** phase-0 design (greenfield)  
**Date:** 2026-07-17  
**Depends on:** [CHARTER.md](./CHARTER.md), [REFERENCE.md](./REFERENCE.md)  
**Audience:** scaffold implementers, reviewers, tests authors  

This document specifies **module boundaries**, **data ownership**, **domain APIs**, and **event flow** for the sibling mansion. It ports **proven behavior** from Conclave (see REFERENCE), not its file tree or monolith. Implementation may rename modules; ownership and contracts stay stable.

---

## 1. System shape (one diagram)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Host (thin): HTTP / SSE / CLI  ·  session token  ·  process wiring     │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ commands / queries
┌────────────────────────────────▼────────────────────────────────────────┐
│                         Application services                             │
│   orchestrate pure domain modules; open one write transaction per cmd   │
└───┬──────────┬──────────┬──────────┬──────────┬──────────┬─────────────┘
    │          │          │          │          │          │
 RoomCtx   Conversation  Work    Authority  Runtime   Coordination
    │          │          │          │          │          │
    └──────────┴──────────┴────┬─────┴──────────┴──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  EventLog + Store   │  ← single durable SoT
                    │  (seq, projections) │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
         Workspace         Adapters          HardGates
         (path/diff)    (detect/spawn)    (high-blast only)
```

**Rules**

1. Domain modules are **pure of HTTP** and **do not spawn processes** (Runtime owns spawn policy; Adapters build argv; Host/Runtime executes).
2. **One durable store** + append-only **event log** with per-room monotonic `seq`. No dual JSON/SQLite SoT.
3. **Chat ≠ work.** Conversation never grants write authority. Work never posts chat-only turns as board tasks without explicit promote.
4. **Default-allow** inside the room’s declared workspace root; **HardGates** only for high-blast actions (charter §3–4).

---

## 2. Bounded contexts (modules)

| Module | Owns | Does **not** own | Port from Conclave |
|--------|------|------------------|--------------------|
| **Room** | room id/name, workspace root(s), trust posture, pause, limits, coordinator, membership roles | process spawn, CLI flags | `state.room` |
| **Agents** | registered participants, install detect cache, activity, current run id | argv construction, policy decisions | `state.agents` + detect |
| **Conversation** | messages (chat lane), chat turns (read-only reply jobs) | approvals, board status | messages + `chatTurns` |
| **Work** | tasks, dependencies, board transitions, deletion tombstones | execution streams | tasks + `task-deletion` |
| **Authority** | hard-gate approvals, room policy profile, auto-approve evaluation | CLI spawn | approvals + `policy` (simplified) |
| **Runtime** | executions, slot reserve/release, one-run-per-agent, cancel/timeout, output caps, redaction at ingest | board rules | ProcessManager + executions |
| **Coordination** | path leases, handoffs, liveness vocabulary | embeddings/memory | `AGENTS.md` protocol → first-class |
| **Workspace** | declared roots, inspect status/diff, branch snapshot | agent cosmetics | `workspace.js` lessons |
| **EventLog** | allocate `seq` + `recordedAt`, append events, project read models | business transitions | `ensureEventIdentity` |
| **Adapters** | detect CLI, build invocation, map access → provider flags | room policy | thin adapter interface |
| **HardGates** | classify high-blast actions; require Authority | routine read/write/test | charter hard gates |
| **Host** | HTTP/SSE/CLI, session cookie/token, wire Runtime ↔ OS | domain invariants | thin `server` shell |

### Intentional non-modules (phase 0)

| Deferred | Why |
|----------|-----|
| Memory / summary pipeline | Research in v1; re-implement only when needed (ADR requirements, not code) |
| Capability broker / MCP control plane | Design docs only; day-1 is detect + spawn + honest failure |
| Multi-tenant IAM / CSRF / host-header maze | Trust the perimeter |
| Static capability badges as truth | Optional probes later; never claim unverified tools |

---

## 3. Data ownership

### 3.1 Single writer principle

- All mutations go through **application commands** that:
  1. Load current projection (or work inside a store transaction).
  2. Call pure domain functions (validate → decide → produce events + new projection slices).
  3. **EventLog** stamps `seq` / `recordedAt` and persists.
- No module mutates another’s tables directly. Cross-context effects are **events** or **explicit service orchestration** (e.g. Work.DeleteTask → Authority.ExpirePendingForTask).

### 3.2 Aggregate roots & primary keys

| Aggregate | Key | Lifetime notes |
|-----------|-----|----------------|
| Room | `roomId` | One active room per process in phase 0 (multi-room later is layout-compatible) |
| Agent | `agentId` (stable slug: `codex`, `claude`, …) | Re-detected on boot; not deleted when offline |
| Task | `taskId` | Soft-delete via tombstone; id never reused for board identity |
| ChatTurn | `turnId` | Always read-only access |
| Approval | `approvalId` | Terminal states are final |
| Execution | `executionId` | One subprocess lifecycle |
| Lease | `leaseId` | Time-bounded; expired = free |
| Handoff | `handoffId` | Immutable once written |
| Event | `seq` (per room) | Monotonic; never recycled |

### 3.3 Projection tables (suggested schema shape)

Concrete SQL/JSON is implementer’s choice; **ownership** is fixed:

| Store slice | Owner module | Notes |
|-------------|--------------|-------|
| `rooms` | Room | trust, paused, limits, workspace roots |
| `agents` | Agents | status, activity, currentExecutionId |
| `messages` | Conversation | chat lane only; human-first content |
| `chat_turns` | Conversation | reply jobs; never write access |
| `tasks` | Work | board; status machine |
| `task_deletions` | Work | tombstones |
| `approvals` | Authority | hard-gate only in breathe default |
| `policy` | Authority | room profile (not agent self-approval) |
| `executions` | Runtime | status, exit, capped output refs |
| `leases` | Coordination | paths, expiry, taskId |
| `handoffs` | Coordination | verify commands, open items |
| `events` | EventLog | type, payload, seq, recordedAt, actor |
| `workspace_snapshots` | Workspace | last inspect (optional cache) |

**Messages vs audit vs domain events**

- **Chat messages** are a Conversation projection (what humans read).
- **Domain events** are the EventLog (causal system truth).
- UI may mirror selected domain events into chat as *system notices* (short, human-readable) — never dump token matrices or raw test logs into the chat lane (operator UX constraint).

---

## 4. Domain APIs

APIs below are **domain command/query interfaces**, not HTTP routes. Host maps REST/SSE onto these. Types are conceptual TypeScript-ish; implement in any language.

### 4.1 Room

```ts
// Commands
createRoom(input: { name: string; workspaceRoots: string[]; trust?: 'breathe' | 'gated' }): Room
setPaused(roomId, paused: boolean): void
setTrust(roomId, trust: 'breathe' | 'gated'): void   // operator only
setLimits(roomId, limits: { maxConcurrentRuns: number; timeoutMinutes: number }): void
setCoordinator(roomId, agentId: string | null): void

// Queries
getRoom(roomId): Room
```

| Field | Meaning |
|-------|---------|
| `trust: 'breathe'` | Default-allow workspace write/run; HardGates still apply |
| `trust: 'gated'` | Optional stricter profile: routine writes may also need approval |
| `paused` | Blocks **new** starts; does not kill running children (Runtime.cancel is separate) |

**Simpler than Conclave:** no room “mode” sprawl; no multi-tenant open-access dual personality as core.

### 4.2 Agents

```ts
// Commands
refreshAgents(): Agent[]                 // detect installed CLIs
setAgentRoles(roomId, roles: Record<AgentId, string[]>): void
// activity updates come from Runtime (on start/end)

// Queries
listAgents(): Agent[]
getAgent(agentId): Agent | null
isAgentFree(agentId): boolean            // no currentExecutionId
```

**Agent record (minimal)**

```ts
type Agent = {
  id: string;
  displayName: string;
  status: 'installed' | 'unavailable';
  activity: 'idle' | 'running' | 'error';
  currentExecutionId: string | null;
  lastSeenAt: string | null;
};
```

**Simpler than Conclave:** no cosmetic identity as load-bearing; no static capability badges as truth.

### 4.3 Conversation (chat lane)

```ts
// Commands
postMessage(input: {
  roomId: string;
  source: 'operator' | 'agent' | 'system';
  sourceId?: string;
  content: string;           // human prose; not run dumps
  replyToMessageId?: string;
}): Message

requestChatReply(input: {
  roomId: string;
  agentId: string;
  promptMessageId: string;   // what to answer
}): ChatTurn                 // always accessMode: 'read-only'

// Promote is Work, not Conversation:
// Work.promoteMessageToTask(...)

// Queries
listMessages(roomId, { beforeSeq?, limit?, budgetChars? }): Message[]
getChatTurn(turnId): ChatTurn
```

**Invariants**

1. Chat reply **cannot** request workspace-write or hard-gate authority.
2. Posting a message never starts a board task.
3. System may inject short notices; bulk telemetry stays in Runs / EventLog.

**Simpler than Conclave:** no dual path where messages accidentally become work; chat UI is not the board.

### 4.4 Work (tasks / board)

```ts
type TaskStatus =
  | 'waiting' | 'ready' | 'active' | 'blocked'
  | 'review-required' | 'completed' | 'failed' | 'cancelled' | 'rejected';

// Commands
createTask(input: {
  roomId: string;
  title: string;
  objective: string;
  agentId?: string;
  accessMode: 'read-only' | 'workspace-write';
  dependsOn?: string[];      // task ids
  origin: 'operator' | 'promoted' | 'plan';
}): Task

promoteMessageToTask(messageId, input: Partial<CreateTask>): Task

assignTask(taskId, agentId): void
setTaskStatus(taskId, status, reason?: string): void   // constrained transitions
requeueTask(taskId): void
blockTask(taskId, blocker: string): void
completeTask(taskId): void
failTask(taskId, reason: string): void
cancelTask(taskId): void

deleteTask(taskId, { confirmTaskId: string }): TaskDeletion
// refuses if active/running; expires pending hard-gate approvals; tombstones;
// dependents that were ready/waiting become blocked with explicit reason

// Queries
listTasks(roomId, filter?: { status?: TaskStatus[] }): Task[]
getTask(taskId): Task
listDeletions(roomId): TaskDeletion[]
```

**Status machine (allowed edges — implement as table, not ad-hoc)**

```
waiting  → ready | cancelled | rejected
ready    → active | blocked | cancelled
active   → review-required | completed | failed | cancelled | blocked
blocked  → ready | cancelled | failed
review-required → completed | ready | failed
failed   → ready (requeue) | cancelled
completed, cancelled, rejected → (terminal for board; archive optional)
```

**Access modes**

| Mode | Meaning under `trust: breathe` |
|------|--------------------------------|
| `read-only` | Inspect / answer; no workspace mutation |
| `workspace-write` | Edit/run inside roots **without** routine approval; HardGates still need Authority |

**Simpler than Conclave:** fewer archive/special-case paths at day 1; deletion rules stay strict (confirm id, no delete while running).

### 4.5 Authority (approvals & policy)

Under **breathe**, Authority is **not** a gate for every write. It owns:

1. **Hard-gate approvals** (destructive, external, secrets, out-of-root).
2. Optional **gated** trust profile (stricter rooms).
3. **Policy** as operator standing will (never agent self-approve).

```ts
type ApprovalKind = 'hard-gate' | 'write' | 'command';  // 'write'|'command' only if trust=gated or policy requires
type ApprovalStatus = 'pending' | 'approved' | 'auto-approved' | 'rejected' | 'expired';

// Commands
requestApproval(input: {
  roomId: string;
  kind: ApprovalKind;
  taskId?: string;
  agentId: string;
  summary: string;
  detail: string;            // exact command or action description
  gateClass?: HardGateClass; // when kind=hard-gate
}): Approval

decideApproval(approvalId, decision: 'approve' | 'reject', decidedBy: 'operator' | 'autopilot' | 'system', reason?: string): Approval

expireApproval(approvalId, reason: string): Approval
expirePendingForTask(taskId, reason: string): Approval[]   // called by Work.deleteTask

evaluateAutoApproval(approvalId): // pure; may auto-approve under policy + rate cap
  | { action: 'approve'; mode: 'auto' }
  | { action: 'wait' }
  | { action: 'reject'; reason: string }

setPolicy(roomId, policy: Policy): void   // operator only

// Queries
listApprovals(roomId, { status? }): Approval[]
getApproval(approvalId): Approval
```

**Hard-learned rules (must remain true)**

| Rule | Behavior |
|------|----------|
| Approve authorizes the **task/action**, not a single spawn | Retries reuse authority unless revoked |
| Rate cap counts **audit/auto events**, not “currently pending” | Re-pend after failed start does **not** refund the hourly seat |
| Failed start after approve | Re-pend only if task still exists; else **expire** (no ghost pending) |
| Autopilot | Operator standing will only |
| Agents | Never decide their own gate |

**Policy (minimal)**

```ts
type Policy = {
  enabled: boolean;
  autoApproveHardGates: boolean;     // default false even in breathe
  autoApproveWrites: boolean;        // only relevant if trust=gated
  maxAutoApprovalsPerHour: number;
  // optional allowlist only for gated/command profiles — not day-1 default maze
};
```

**Simpler than Conclave:** no shell-metacharacter allowlist maze as default; unleashed/breathe is the primary product path.

### 4.6 Runtime (execution)

```ts
type ExecutionKind = 'agent-task' | 'chat' | 'command';
type ExecutionStatus = 'reserved' | 'running' | 'completed' | 'failed' | 'cancelled';

// Commands
reserveSlot(input: { roomId: string; agentId: string; kind: ExecutionKind; taskId?: string; turnId?: string }):
  | { ok: true; executionId: string }
  | { ok: false; reason: string }   // agent busy, room paused, concurrency, writer held, missing approval

startExecution(executionId, invocation: Invocation): void
  // Host/Runtime spawns; streams lines through redact → append chunks

completeExecution(executionId, result: { exitCode: number; timedOut?: boolean }): void
failExecution(executionId, error: string): void
cancelExecution(executionId, reason: string): void   // cancel ≠ fail

// Queries
getExecution(executionId): Execution
listExecutions(roomId, { limit? }): Execution[]      // capped previews
getExecutionLog(executionId): string                 // full capped log
```

**Scheduling invariants**

1. **One run per agent** (chat or task).
2. **One direct workspace-write writer per room** (soft mutex); others get explicit blocker reason.
3. **Reserve before spawn**; always release on terminal status (including failed spawn).
4. **Cancel is not fail** — cancelled children must not auto-retry.
5. **Redact secrets** on streamed lines before persist/display.
6. **Output caps** + list projection; full log on demand.

**Writer lock**

```ts
// Runtime / Work orchestration
canStartWrite(roomId, agentId): { ok: true } | { ok: false; holderExecutionId: string; reason: string }
```

**Simpler than Conclave:** reserve/release designed in-module from day 1; no mid-restart fossil mythology.

### 4.7 Coordination (leases & handoffs)

First-class replacement for append-only `COORDINATION.md` as system of record (protocol file may still be generated for agents that read markdown).

```ts
// Leases
claimLease(input: {
  roomId: string;
  agentId: string;
  taskId: string;
  paths: string[];
  ttlMinutes?: number;       // default 120
}): Lease | { error: 'conflict'; holders: Lease[] }

renewLease(leaseId, ttlMinutes?: number): Lease
releaseLease(leaseId): void
adoptOrphanLeases(agentId, taskId): Lease[]   // expired only

// Handoffs
writeHandoff(input: {
  roomId: string;
  agentId: string;
  taskId: string;
  state: 'completed' | 'blocked' | 'failed';
  summary: string;
  filesChanged: string[];
  verifyCommands: string[];  // exact, copy-pasteable
  openItems: string[];
}): Handoff

// Queries
listActiveLeases(roomId): Lease[]
listHandoffs(roomId, { taskId? }): Handoff[]
```

**Liveness vocabulary** (for agent messages / heartbeats, not store enums only):  
`progress` | `blocked` | `failed` | `completed` — silence under a live lease ⇒ treat as failed liveness for adoption policy.

**Simpler than Conclave:** structured leases; no multi-megabyte coordination file as SoT.

### 4.8 Workspace

```ts
setWorkspaceRoots(roomId, roots: string[]): void   // operator; must be absolute local paths
inspectWorkspace(roomId): {
  branch: string | null;
  status: string;            // porcelain summary
  diff: string;              // includes untracked content when feasible
  truncated: boolean;
  refreshedAt: string;
}
pathAllowed(roomId, absolutePath: string): boolean  // under declared roots
```

**Invariants:** agents cannot treat paths outside roots as in-room; HardGates for anything that escapes.

### 4.9 EventLog

```ts
// Internal — only Store/EventLog and application services call this
append(roomId, events: DomainEventInput[]): DomainEvent[]
  // assigns seq, recordedAt server-side; persists; updates projections

// Queries
listEvents(roomId, { afterSeq?, types?, limit? }): DomainEvent[]
getProjection(roomId): RoomProjection
```

**Event envelope**

```ts
type DomainEvent = {
  seq: number;
  recordedAt: string;        // server UTC ISO
  roomId: string;
  type: string;              // e.g. 'task.created', 'approval.expired'
  actor: { kind: 'operator' | 'agent' | 'system'; id?: string };
  payload: unknown;
  correlation?: { taskId?: string; executionId?: string; approvalId?: string };
};
```

**Ordering rule:** wall-clock alone is **not** total order. Clients sort by `seq`.

### 4.10 Adapters

```ts
interface AgentAdapter {
  id: string;
  detect(): Promise<{ installed: boolean; version?: string }>;
  buildInvocation(input: {
    workspaceRoot: string;
    accessMode: 'read-only' | 'workspace-write';
    prompt: string;
    extraArgs?: string[];
  }): Invocation;            // { command, args, cwd, env? }
}
```

**Simpler than Conclave:** thin interface; fail honest; no universal capability broker on day 1.

### 4.11 HardGates

```ts
type HardGateClass =
  | 'destructive-data'     // rm project roots, drop DBs, wipe history
  | 'force-push'           // git push --force / publish
  | 'secrets'              // read/print credentials, .env leak paths
  | 'out-of-workspace'     // path escapes roots
  | 'global-system';       // install global tools, edit OS config

classifyAction(action: PlannedAction): 'allow' | { gate: HardGateClass; reason: string }
```

Routine `git commit`, edit source, `npm test` → **allow** under breathe + in-root.

---

## 5. Event flow (happy paths)

### 5.1 Human chat (no work)

```
Operator posts message
  → Conversation.postMessage
  → EventLog: message.posted
  → (optional) Conversation.requestChatReply
  → Runtime.reserveSlot (kind=chat)
  → Adapter.buildInvocation (read-only)
  → Runtime start → stream/redact → complete
  → Conversation completes ChatTurn + agent message
```

### 5.2 Task under breathe (workspace-write, no hard gate)

```
Operator/agent createTask(accessMode=workspace-write)
  → Work: task ready (if agent free + deps met)
  → Runtime.reserveSlot (check one-writer, pause, free agent)
  → no Authority.request for routine write
  → spawn → complete
  → Work: review-required or completed (policy)
  → Coordination.writeHandoff (agent responsibility; server may accept API)
```

### 5.3 Hard-gate path

```
PlannedAction classified as hard-gate
  → Authority.requestApproval(kind=hard-gate, detail=exact action)
  → EventLog: approval.requested
  → Operator decide OR autopilot (if policy allows hard gates — default no)
  → approved → Runtime may start
  → rejected/expired → Work blocked/cancelled with reason
```

### 5.4 Delete task (race-safe)

```
Work.deleteTask(id, confirmTaskId=id)
  → refuse if execution active
  → Authority.expirePendingForTask
  → tombstone task_deletions
  → dependents blocked with reason
  → EventLog: task.deleted, approval.expired*
```

### 5.5 Failed start after approve (ghost prevention)

```
Approval approved → Runtime.reserve/start fails (e.g. agent vanished)
  → if task exists: Authority re-pend or leave approved for retry (document choice; port: re-pend)
  → if task deleted: Authority.expire (never leave undecidable pending)
  → EventLog: execution.start-failed, approval.expired|approval.repended
```

### 5.6 Causal lineage (what operators can always reconstruct)

For any task id, EventLog + projections answer:

1. Who created / promoted it  
2. Whether hard-gate approval was required and who decided  
3. Which execution(s) ran (exit, cancel vs fail)  
4. Workspace inspect after run (optional)  
5. Handoff verify commands and open items  

---

## 6. Cross-cutting policies

| Concern | Owner | Rule |
|---------|-------|------|
| Session auth | Host | Light token/cookie on loopback/LAN; no multi-tenant IAM |
| Redaction | Runtime | Before persist and before SSE |
| Projection size | Host + EventLog | List APIs strip full logs; detail endpoints for full |
| Restart | Runtime + Store | Persist reserved/running; on boot reconcile OS children or mark interrupted → not silent success |
| Secrets on disk | Store | No raw tokens in event payloads; redact |
| Prompt injection tax | Host | Generate agent system prompt from Room + Coordination snapshot; not a domain module |

---

## 7. What is intentionally simpler than Conclave

| Conclave scar | Mansion simplification |
|---------------|------------------------|
| Monolithic `server.js` domain+HTTP+spawn | Thin host + pure modules |
| Default-deny / allowlist maze | **Breathe** default; HardGates only |
| Approvals for routine workspace writes | Approvals for **high-blast** (and optional gated profile) |
| Dual JSON state + SQLite memory sidecar | **One** durable store + event log |
| `COORDINATION.md` as SoT | Structured leases/handoffs; markdown is export |
| Static capability theater | Detect + honest unavailable |
| Capability broker product | Deferred |
| Multi-tenant security crush | Perimeter + light session |
| Half-built memory pipeline | Out of phase 0 |
| Giant injection-tax markdown as architecture | Generated prompts |
| Restart-gate folklore | Durable run state from day 1 |
| Chat polluted with telemetry | **Two lanes:** chat human-first; runs/events for machine detail |

**What is not simplified away (must stay rigorous)**

- Chat ≠ work  
- One run per agent; one writer per room  
- Cancel ≠ fail  
- Approval terminal states + delete/start races  
- Monotonic `seq` event identity  
- Real CLI agents only  
- Actionable handoffs + time-bounded leases  
- Secret redaction  

---

## 8. Host API sketch (optional mapping)

Not required for domain purity; suggested for scaffold:

| HTTP | Domain |
|------|--------|
| `GET /api/state` | projection snapshot (capped) |
| `GET /api/events?afterSeq=` | EventLog.listEvents |
| `POST /api/messages` | Conversation.postMessage |
| `POST /api/tasks` | Work.createTask |
| `POST /api/tasks/:id/delete` | Work.deleteTask |
| `POST /api/approvals/:id/decide` | Authority.decideApproval |
| `POST /api/executions/:id/cancel` | Runtime.cancelExecution |
| `GET /api/executions/:id` | Runtime.getExecution + log |
| `POST /api/leases` | Coordination.claimLease |
| `POST /api/handoffs` | Coordination.writeHandoff |
| `GET /api/workspace` | Workspace.inspectWorkspace |
| SSE `/api/stream` | event + execution chunks |

---

## 9. Test strategy (domain-first)

| Layer | What to test without HTTP |
|-------|---------------------------|
| Work status machine | Illegal transitions throw |
| deleteTask | Confirm id; expire approvals; block dependents; refuse when active |
| Authority | Ghost prevention (task deleted mid-approve); rate cap non-refund |
| Runtime | Reserve contention; cancel ≠ fail; one-writer |
| EventLog | seq monotonic across streams; no wall-clock sort required |
| HardGates | classify allow vs gate |
| Conversation | chat cannot request write |

Port the **behavioral** tests from Conclave’s `task-deletion`, `policy`, `event-identity`, `process-manager` lessons — not the files.

---

## 10. Phase-0 success criteria for this artifact

- [x] Modules named with clear ownership  
- [x] APIs for rooms, agents, tasks, approvals, execution, durable events  
- [x] Event flows for chat, breathe-write, hard-gate, delete, failed-start  
- [x] Explicit “simpler than Conclave” list  
- [ ] Sibling repo skeleton implements these module folders / packages (separate task)  
- [ ] Runnable host that creates a room and posts a message (separate task)  

---

## 11. One-line export

**Mansion = pure bounded contexts + one event-sourced store + breathe-by-default workspace + hard gates only for real damage; chat stays human, work stays board, runs stay runs.**
