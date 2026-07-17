# Conclave Reference Lessons

**Status:** phase-0 extraction (read-only audit of live Conclave)  
**Date:** 2026-07-17  
**Audience:** mansion architects / implementers  
**Source freeze:** Conclave at `main` ≈ `7a29e65` (232 tests). **Do not feature-work this tree** unless the operator reopens it.

This document ports **behavior and hard-won rules**, not file trees. Second-system trap: copying every scar.

---

## 1. What Conclave is (in one paragraph)

A **local-first room** that runs **real coding-agent CLIs** as subprocesses against one workspace. Humans and agents share a chat feed and a Kanban board. **Chat is conversation; tasks are work.** Write and shell authority pass through an **approval** gate (or operator-authored autopilot / unleashed trust). Coordination between agents on disk is largely a **social protocol** (`AGENTS.md` + `COORDINATION.md` leases/handoffs), not a first-class database object.

Evidence: `README.md`, `src/lib/store.js` `initialState`, `src/server.js` task/chat split, `AGENTS.md`.

---

## 2. Domain concepts (as built)

| Concept | What it is | Core fields / states | Where it lives |
|--------|------------|----------------------|----------------|
| **Room** | Single collaboration session bound to a workspace path | `id`, `name`, `workspace`, `trust` (`gated` \| `unleashed`), `paused`, `coordinatorId`, `roles`, `limits` (max concurrent runs, timeout, max turns) | `state.room` |
| **Agent** | Real installed CLI participant (never simulated) | `id` (`codex`/`claude`/`gemini`/`grok`…), `status` installed/unavailable, `connection` / verified-by-success, `activity`, `currentTaskId`, optional cosmetic `identity` | `state.agents` + adapters |
| **Task** | Board work unit (explicit create or promote-from-chat) | `accessMode` (`read-only` \| `workspace-write`), `status` (`waiting`/`ready`/`active`/`blocked`/`review-required`/`completed`/`failed`/`cancelled`/`rejected` + archive), `dependencies`, `origin` (`operator`/`message`/`promoted`), `attempts`, `blocker` | `state.tasks` |
| **Chat turn** | Read-only reply lane; **cannot** request write | Queued → active → completed/failed/cancelled; always `accessMode: read-only` | `state.chatTurns` |
| **Approval** | Gate for authority before a write run or local command | Types: `agent-write`, `command`. Status: `pending` → `approved` / `auto-approved` / `rejected` / `expired`. `decidedBy`: operator \| autopilot \| system | `state.approvals` |
| **Execution** | One subprocess invocation | `kind`: `agent` \| `chat` \| `command`; status running → completed/failed/cancelled; streamed, redacted output (capped) | `state.executions` + `ProcessManager` |
| **Event / audit** | Observable history + causal lineage | Per-room monotonic `seq` + server `recordedAt` on messages/audit; wall-clock alone is **not** total order | `state.events.nextSequence`, `messages[]`, `audit[]` |
| **Task deletion tombstone** | Permanent board removal without erasing that it existed | Compact `taskDeletions[]`; expires **pending** approvals; blocks dependents still `ready`/`waiting` | `state.taskDeletions` + `task-deletion.js` |
| **Policy / autopilot** | Operator-authored standing decisions | `enabled`, `autoApproveWrites`, `commandAllowlist`, rate cap, optional auto-retry | `state.policy` |
| **Lease (file protocol)** | Time-bounded claim on paths/areas | Agent, paths, task, claimed-at, **lease expiry** (default +2h); expired = free; silence under lease = failed liveness | `COORDINATION.md` + `AGENTS.md` (not enforced by server) |
| **Handoff** | Actionable finish record | What changed, files, **exact verify commands**, open items, state (`completed`/`blocked`/`failed`) | Prepended in `COORDINATION.md`; mirrored in room chat |
| **Job lease (memory pipeline)** | Separate concept: summary/memory background jobs | `leaseOwner`, `leaseExpiresAt` on SQLite job rows | `memory-db.js` (partial; not the multi-agent workspace lease) |

### Mental model (port this shape)

```
Operator / Agent message
        │
        ├─► Chat turn ──► read-only execution ──► room message
        │
        └─► Task (explicit or promote)
                 │
                 ├─ read-only ──► ready → start when agent free
                 └─ workspace-write ──► waiting + Approval
                                              │
                         approve / auto-approve / unleashed
                                              │
                                    active execution
                                              │
                         success → review-required (most writes)
                         fail → blocked / retry policy / requeue
```

---

## 3. Proven behaviors to port

These earned their keep in production use and regression tests. Prefer **rules + small modules**, not a copy of `server.js`.

### 3.1 Product invariants

1. **Real agents only.** Availability and output come from installed CLIs; never fabricate runs, diffs, or “verified” without evidence (`README` principle; adapter detect/spawn).
2. **Chat ≠ work.** Messages create chat replies only. Work requires New task / Assign / promote. Chat API must ignore write-access requests.
3. **Human sovereignty.** Pause room, interrupt run, reject approval, requeue, delete task (with confirm), archive — operator remains final authority.
4. **Local-first control plane.** State and coordination on the operator machine; agents may call their own providers, but the room does not need multi-tenant SaaS auth.
5. **Visible causal lineage.** Who proposed / approved / executed / what changed / what is open — via messages, audit, executions, workspace diff.

### 3.2 Scheduling & contention

6. **One run per agent** at a time (chat **or** task) — avoids dual-prompt thrash.
7. **One direct workspace-write writer per room** at a time — soft mutual exclusion; others queue with an explicit “why” blocker.
8. **Concurrency cap + reserve slots.** Count reserved-not-yet-spawned slots with running children so two starters cannot both pass capacity (`ProcessManager.reserve/release`).
9. **Queue honesty.** If a task cannot start, say exactly why (agent busy, writer held, paused, dependencies, missing approval).

### 3.3 Approval lifecycle (hard-won)

10. **Approvals authorize the task, not a single execution** — retries reuse write authority by design; document that clearly in v2.
11. **Auto-approval rate cap counts audit events**, not current status — re-pending after failed start must **not** refund the hourly seat (`policy.js` comment + tests).
12. **Failed start after approve:** re-pend only if the task still exists; if deleted mid-window, **expire** the approval (no ghost pending that cannot be decided) — F2 fix `7a29e65` / `revertFailedStart`.
13. **Delete task:** require exact id confirmation; refuse while active/running; expire pending approvals; tombstone; block dependents still waiting on it.
14. **Autopilot is the operator’s standing will**, not agent self-approval. Agents never decide their own write gate.
15. **Unleashed trust:** room-wide auto-approve for write/command under still-enforced one-writer, pause, and audit — for trusted local rooms (matches mansion “breathe” posture).
16. **Command approvals must show the exact command** that will run; agent-write argv may be previewed/redacted in `/api/state` to keep payloads small.

### 3.4 Process & safety (keep light, keep real)

17. **Secret redaction** on streamed lines before persist/display.
18. **Cancel is not fail.** Cancelled children (incl. Windows `taskkill` exit codes) must not be classified as `failed` or auto-retry will resurrect them.
19. **Output caps + state projection.** Full run output is large; list endpoints strip or preview; per-execution fetch for full log.
20. **Workspace inspection** that includes untracked content and survives huge diffs via truncation markers (not throw) — salvage lessons in `workspace.js` tests.
21. **Session/token gate for mutations** is fine as a light perimeter (loopback + cookie/header). Do not crush local use with multi-tenant IAM.

### 3.5 Multi-agent coordination protocol (port the *idea*)

22. **Time-bounded leases, not forever locks.** Expired claims are free; live foreign leases are off-limits.
23. **Adopt orphans** (expired leases, unfinished handoffs for your task).
24. **Heartbeat vocabulary:** `progress` / `blocked` / `failed` / `completed` — silence under a lease means failed liveness.
25. **Handoffs must be actionable:** changes, files, verify commands, open items — next agent continues without rediscovery.
26. **One task per run** under a claim — reduces thrash and claim sprawl.

### 3.6 Event identity

27. **Per-room monotonic sequence** for durable history; do not sort legacy history by ambiguous wall-clock timestamps (`ensureEventIdentity`, ADR 0001).
28. **Structured domain state outranks prose** that describes it (memory ADR) — summaries cannot rewrite tasks/approvals.

### 3.7 UX surfaces that worked

29. Four lanes + drawer: **Chat / Board / Runs / Workspace + Approvals**.
30. Plan-dispatch fenced blocks → multiple board tasks with `dependsOn` — useful, but keep parser/caps simple.
31. Participant cards + optional identity cosmetics — nice, optional.

---

## 4. Accidental complexity to leave behind

Do **not** port these as load-bearing architecture.

| Scar | Why it is debt | Mansion direction |
|------|----------------|-------------------|
| **Monolithic `server.js` (~2k+ lines)** | Domain, HTTP, scheduling, approvals, chat, autopilot, memory projection entangled | Clean modules + thin host; domain pure of HTTP |
| **JSON whole-room aggregate as SoT** with partial SQLite memory sidecar | Dual paths, incomplete migration, migration/version anxiety | Pick one durable store early; event log + tables |
| **Half-built memory/summary stack** | `memory-db`, ledger, context-assembler, adversarial eval — valuable research, unfinished product | Port *requirements* from ADR; re-implement only when needed |
| **Static capability badges** | `declaredCapabilities` not proven; “verified” ≈ one successful exit 0 | Optional probes later; never claim tools you cannot prove |
| **Provider adapter matrix sprawl** | Each CLI’s permission/sandbox/MCP flags differ; Gemini/agy headless permission denials; leftover adapter paths | Thin adapter interface; fail honest; no fake universal broker on day 1 |
| **Capability-broker design as phase-0** | Useful inventory doc; productizing control-plane MCP brokerage is a product, not a skeleton | Defer; keep spawn + policy profiles simple |
| **Security posture for multi-tenant / hostile LAN** | Host header DNS-rebinding, CSRF-ish origin checks, open-access mode + token-gated memory, restart token traps | Trust perimeter + light auth; hard gates only for real damage (delete data, force-push, secret leak) |
| **Command allowlist + shell-metacharacter maze** | Correct for auto-approve-from-policy in hostile model; heavy for local trusted room | Prefer unleashed/simple profiles; allowlist optional |
| **Restart fossil / gate mythology** | Mid-write bounce creates blocked fossils; long gate docs | Design durable run state + safe restart from day 1 |
| **Ghost approval class of bugs** | Races between approve, start, delete | Model approval terminal states exhaustively in domain tests |
| **Giant append-only `COORDINATION.md`** as both protocol and history | Works culturally; becomes unreadable | Keep protocol file small; handoffs in store or rotating log |
| **PR salvage / dual-branch archaeology** | Lessons live in tests and handoffs; branch soup is not architecture | Tests + this REFERENCE; freeze old repo |
| **Injection-tax agent markdown** | Necessary for today’s agents; not a domain model | Generate system prompts from room config; don’t design the product around one prompt blob |
| **Deferred / quarantine test trees** | Signal of retrofit stress | Green suite only; no shadow test landfills |
| **Crushing default deny** | Operator asked for room to breathe | Wide workspace access inside a room; opt-in hard gates |

---

## 5. Design posture for the mansion (operator constraints)

| Principle | Implication for v2 |
|-----------|-------------------|
| **Local-first** | Single operator / LAN; no multi-tenant threat model |
| **Trust the perimeter** | Enterprise firewall exists; auth real but light |
| **Room for activities** | Agents can read/write/run/coordinate without permission mazes |
| **Breathe** | Wide default workspace access; hard gates only for real damage |
| **Port deliberately** | Proven behavior, not file trees |

Map to Conclave trust: **unleashed + audit + one-writer + cancel** is closer to the desired posture than **gated + dense autopilot allowlists** as the default.

---

## 6. Suggested clean domain boundaries (for next tasks)

Not implemented here — only boundaries that fall out of the audit:

| Bounded context | Owns | Does not own |
|-----------------|------|--------------|
| **Room** | trust, pause, limits, membership | process spawn details |
| **Work** | tasks, dependencies, board transitions, deletion tombstones | chat streaming |
| **Conversation** | messages, chat turns, promote-to-task | write execution |
| **Authority** | approvals, policy, unleashed evaluation | CLI argv construction |
| **Runtime** | executions, reserve slots, cancel/timeout, redaction | board rules |
| **Workspace** | path, branch, inspect/diff | agent identity cosmetics |
| **Coordination** | leases, handoffs, liveness (first-class in v2) | memory embeddings |
| **Adapters** | detect CLI, build invocation, map accessMode → provider flags | room policy |

---

## 7. Evidence index (where to look in the museum)

| Topic | Primary evidence |
|-------|------------------|
| Initial state shape | `src/lib/store.js` → `initialState` |
| Policy / unleashed / rate cap | `src/lib/policy.js` |
| Task delete + dependents | `src/lib/task-deletion.js`, `test/task-deletion.test.js` |
| Approval ghost / failed start | `src/server.js` → `revertFailedStart`, commit `7a29e65` |
| Process slots / cancel | `src/lib/process-manager.js` |
| Event sequence | `src/lib/store.js` → `ensureEventIdentity`, `test/event-identity.test.js` |
| Chat vs task | `README.md`, message handlers in `src/server.js` |
| Agent coordination protocol | `AGENTS.md`, `COORDINATION.md` |
| Memory aspirations (not full product) | `docs/adr/0001-conclave-memory-architecture.md`, `docs/memory.md` |
| Adapter/capability inventory | `docs/capability-broker-design.md`, `src/lib/adapters.js` |
| Workspace inspect salvage | `src/lib/workspace.js`, `test/workspace.test.js` |
| Product intent | `README.md`, `PRD.md` (spec; not all implemented) |

---

## 8. Explicit non-goals for this artifact

- No changes under `src/` or `test/`.
- No runnable mansion skeleton (separate task).
- No charter rewrite (separate task).
- No freeze commit/docs in app root beyond this staging tree + coordination handoff.

---

## 9. One-line export

**Port:** chat/work split, room trust, task+approval lifecycle (incl. delete/expire races), one-writer + one-run-per-agent, real CLI executions, event sequence, redaction, actionable leases/handoffs.  
**Leave:** monolith retrofit, dual-store memory debt, capability theater, multi-tenant security crush, branch archaeology.
