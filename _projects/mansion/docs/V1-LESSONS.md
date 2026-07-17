# Conclave v1 Lessons & Behavioral Inventory

**Status:** phase-0 extraction for Mansion (greenfield)  
**Date:** 2026-07-17  
**Source freeze:** Conclave `main` at `d403771` (museum); F2 fix at `7a29e65`; suite **232** tests  
**Audience:** mansion architects, implementers, testers  
**Companion docs (Conclave design staging):** `staging/mansion/REFERENCE.md` (domain map), `staging/mansion/CHARTER.md`, `staging/mansion/ARCHITECTURE.md`  
**Sibling product docs:** `U:\mansion\docs\` (CHARTER / REFERENCE / ARCHITECTURE / this file)

This document is a **portable inventory**: behaviors worth re-implementing, **bug classes to design out**, and **regression tests** that earned their keep. Port rules and tests — not `server.js`.

Paths below are **Conclave-repo-root relative** unless noted as `U:\mansion\…`.

---

## 1. Why this exists

Conclave v1 is frozen as a behavioral museum (`FREEZE.md`). The sibling product lives at `U:\mansion`. Before building there, capture:

1. What worked in production use and regression suites  
2. Failure modes that cost real operator time (ghost approvals, restart fossils, headless CLI denials)  
3. Exact v1 files/tests that prove each lesson  

**One-line export:** chat ≠ work · real CLIs only · one-writer + one-run-per-agent · approval terminal states exhaustively tested · cancel ≠ fail · monotonic event seq · redaction · actionable leases/handoffs · default-allow (“breathe”) inside declared roots with hard gates only for real damage.

---

## 2. Behavioral inventory (worth porting)

Prefer small domain modules + pure rules. Evidence paths are relative to Conclave repo root.

### 2.1 Product invariants

| # | Behavior | Why it earned rent | Primary evidence |
|---|----------|--------------------|------------------|
| B1 | **Real agents only** — never fabricate runs, diffs, or “verified” without CLI evidence | Fake agents poison trust and debugging | `README.md`; `src/lib/adapters.js`; `test/adapters.test.js` |
| B2 | **Chat ≠ work** — recipient messages create chat turns only; write-access on chat is ignored | Prevents drive-by board spam and accidental write authority | `src/server.js` message handlers; `test/server.test.js` (`FR-CHAT-004`); `test/autopilot.test.js` (chat + full autopilot still zero tasks); `test/recipient-selection.test.js` |
| B3 | **Human sovereignty** — pause, interrupt, reject, requeue, delete-with-confirm, archive | Operator remains final authority even when autopilot is on | `src/server.js` routes; `test/server-work.test.js`; `test/task-deletion.test.js` |
| B4 | **Visible causal lineage** — who proposed / approved / ran / what changed | 3am debug and multi-agent handoff | `state.audit`, `state.messages`, `state.executions`; `/api/state` projection |
| B5 | **Local-first control plane** | Matches operator hardware; multi-tenant IAM is wrong threat model for this product | `README.md`; `FREEZE.md`; mansion CHARTER trust model |

### 2.2 Scheduling & contention

| # | Behavior | Why | Evidence |
|---|----------|-----|----------|
| B6 | **One run per agent** (chat *or* task) | Avoids dual-prompt thrash | `test/server.test.js` (“one run per agent…”) |
| B7 | **One direct workspace-write writer per room** | Soft mutual exclusion; honest “why blocked” | `test/server.test.js` (“workspace-write runs are serialized…”) |
| B8 | **Reserve slots before spawn** — count reserved-not-yet-spawned with running children | Two starters cannot both pass capacity | `src/lib/process-manager.js`; `test/start-safety.test.js` (M2 concurrent starts) |
| B9 | **Queue honesty** — say exactly why a task cannot start | Reduces false “agent stuck” reports | `startTask` error paths; dependency blockers in `test/dependencies.test.js` |

### 2.3 Approval / authority lifecycle

| # | Behavior | Why | Evidence |
|---|----------|-----|----------|
| B10 | Approvals authorize the **task**, not a single execution (retries reuse write authority) | Document explicitly in v2 so operators understand | `src/server.js` start + autopilot paths |
| B11 | **Rate cap counts audit events**, not current approval status — re-pend after failed start must **not** refund the hourly seat | Prevents silent rate-cap bypass via fail-start loops | `src/lib/policy.js` `autoApprovalsInWindow` + comment; `test/policy.test.js` (“reverts do not refund seats”); `test/autopilot.test.js` rate-cap test |
| B12 | **Failed start after approve:** re-pend only if task still exists; else **expire** (no undecidable ghost) | F2 class — see §3 | `src/server.js` `revertFailedStart` (~1407–1435); commit `7a29e65`; `test/task-deletion.test.js` race test |
| B13 | **Delete task:** exact id confirmation; refuse while active; expire **pending** approvals; tombstone; block dependents still waiting | Prevents silent resurrection and dep thrash | `src/lib/task-deletion.js`; `test/task-deletion.test.js` |
| B14 | Autopilot is **operator standing will**, never agent self-approval | Trust boundary | `src/lib/policy.js` `evaluateAutoApproval`; `test/autopilot.test.js` |
| B15 | **Unleashed / breathe** room: auto-approve write+command under pause, concurrency, and audit still enforced | Matches mansion default-allow posture | `src/lib/policy.js` unleashed branch; `test/trust.test.js` |
| B16 | Command approvals show the **exact command**; agent-write argv may be preview-capped in state projection | Operator must see what will run | `test/state-projection.test.js` |

### 2.4 Process, safety, history

| # | Behavior | Why | Evidence |
|---|----------|-----|----------|
| B17 | **Secret redaction** on streamed lines before persist/display | Stops token leaks in room logs | `test/store-security.test.js`; `room-summary` re-scan |
| B18 | **Cancel ≠ fail** — cancelled children must not auto-retry | Windows `taskkill` exit codes look like failures otherwise | `test/autopilot.test.js` (“cancelled run is never auto-retried”); Grok cancel stream tests |
| B19 | **Output caps + projection** — list strips; full log per-execution | Keeps `/api/state` usable | `test/state-projection.test.js` |
| B20 | **Workspace inspect** includes untracked content; huge diffs **truncate** (not throw) | PR #2 salvage W2+W3 | `src/lib/workspace.js` (`398e60b`); `test/workspace.test.js` |
| B21 | **Per-room monotonic `seq`** + server `recordedAt` — wall-clock alone is not total order | History integrity across restarts | `src/lib/store.js` `ensureEventIdentity`; `test/event-identity.test.js`; ADR `docs/adr/0001-conclave-memory-architecture.md` |
| B22 | Light session/token gate for mutations is enough; do not crush local use with multi-tenant IAM | Headless/local UX | `test/session-auth.test.js`; open-access notes in restart gates |

### 2.5 Multi-agent coordination protocol (idea, not markdown-as-SoT)

| # | Behavior | Why | Evidence |
|---|----------|-----|----------|
| B23 | **Time-bounded leases**, not forever locks; expired = free | Prevents stuck ownership | `AGENTS.md`; `COORDINATION.md` |
| B24 | **Adopt orphans** (expired leases, unfinished handoffs for your task) | Continuity across agents | `AGENTS.md` |
| B25 | Heartbeat vocabulary: `progress` / `blocked` / `failed` / `completed` | Silence under lease = failed liveness | `AGENTS.md` |
| B26 | Handoffs must be **actionable** (files, verify commands, open items) | Next agent continues without rediscovery | `COORDINATION.md` handoff format |
| B27 | Idle watchdog: silent success ticks when no eligible work; never reanimate fossils | Chat spam + board thrash prevention | `src/lib/idle-watchdog.js`; `test/idle-watchdog.test.js`; COORDINATION fossil handoffs |

### 2.6 Mansion trust flip (founding lesson from room, not code)

Conclave’s default product posture is **gated** (default-deny write until approval/autopilot/unleashed). Operator direction for Mansion:

- **Default-allow** inside declared workspace roots (no permission prompts for routine read/write)  
- Keep an **append-only action log** (undo/debug — not a gate)  
- Keep **one config switch** to tighten later if the surface faces a network  
- Hard gates only for real damage: data deletion, force-push, credential exposure  

Evidence of why gated defaults hurt: Gemini/agy **headless soft-deny** of tools when prompts cannot appear — chat works, tool-using tasks fail silently (`COORDINATION.md` 2026-07-17 Gemini stall triage; `src/lib/adapters.js` elevated `--dangerously-skip-permissions` path).

---

## 3. Bug classes to design out

These are **classes**, not one-off patches. Mansion Authority / Work / Runtime modules should make each impossible or trivially tested.

### 3.1 F2 — Approval lifecycle race (ghost pending)

| Field | Detail |
|-------|--------|
| **Name** | Ghost approval after approve × delete × failed start |
| **PR #2 triage** | Only open defect from six PR claims; fixed on main as F2 (`COORDINATION.md` Claude 2026-07-17 12:45 UTC) |
| **Mechanism** | `decideApproval` commits `approved` → task deleted before `startTask` snapshot → `deleteBoardTask` only expires **pending** approvals → approved survives → `revertFailedStart` **unconditionally re-pended** → Approval Center shows permanently undecidable `pending` |
| **Fix (v1)** | `revertFailedStart`: if task missing, set `expired` / `decidedBy: 'system'` / `reason: 'Task deleted'`; honest operator message |
| **Code** | `src/server.js` `revertFailedStart` lines ~1407–1435; ported from PR head `c6223ed` |
| **Commit** | `7a29e65` |
| **Regression** | `test/task-deletion.test.js` — *“an approve racing a delete expires the approval instead of resurrecting a pending ghost”* |
| **Mansion design rule** | Model approval as a **state machine with exhaustive terminals** (`pending` → `approved` \| `auto-approved` \| `rejected` \| `expired`). Every failed-start path must branch on task existence. Delete must expire *all* non-terminal gates for that task, or start-failed must. Prefer domain-level `Authority.revertFailedStart(taskId, approvalId)` with pure pure-function tests. |

```
  pending ──approve──► approved ──start ok──► (consumed / linked to execution)
     │                    │
     │                    ├── task deleted mid-window ──► expired (system)
     │                    └── start fails, task lives ──► pending (recoverable)
     └── delete task ──► expired (pending gates)
```

### 3.2 Rate-cap refund via re-pend

| Field | Detail |
|-------|--------|
| **Class** | Accounting by mutable status instead of immutable audit |
| **Mechanism** | Auto-approve → failed start → status back to `pending` → if rate cap counted *current* auto-approved rows, the seat refunds |
| **v1 rule** | Count `audit` entries `type === 'approval.auto-approved'` in trailing hour |
| **Evidence** | `src/lib/policy.js` `autoApprovalsInWindow`; `test/policy.test.js` |
| **Mansion rule** | Rate limits / budgets always from **append-only events**, never from current row status |

### 3.3 Cancel classified as fail → auto-retry resurrection

| Field | Detail |
|-------|--------|
| **Class** | Exit-code / status conflation |
| **Mechanism** | Operator cancel or `taskkill` → process exit ≠ 0 → `failed` → auto-retry requeues |
| **Evidence** | `test/autopilot.test.js` cancel never auto-retried; Grok stream cancel isolation |
| **Mansion rule** | Runtime statuses: `cancelled` is terminal and **excluded** from retry policy |

### 3.4 Dual-start / slot double-booking

| Field | Detail |
|-------|--------|
| **Class** | TOCTOU between eligibility check and spawn |
| **Evidence** | `test/start-safety.test.js` M2; `ProcessManager.reserve/release` |
| **Mansion rule** | Atomic **reserve** before spawn; release on fail; one-writer as domain invariant, not hope |

### 3.5 Restart fossils / mid-write bounce

| Field | Detail |
|-------|--------|
| **Class** | In-memory run state lost on process death; board left `active`/`blocked` with restart blockers |
| **Evidence** | `docs/restart-gates.md`; fossil quarantine handoffs (73 rejected+archived); `idle-watchdog` eligibility excludes fossils |
| **Mansion rule** | Durable run records from day 1; restart recovers or cleanly terminalizes; watchdog **must not** reanimate terminal quarantine states |

### 3.6 Headless CLI permission soft-deny (adapter class)

| Field | Detail |
|-------|--------|
| **Class** | Provider requires interactive consent; headless mode auto-denies; room shows empty/deny text |
| **Evidence** | COORDINATION Gemini stall triage 2026-07-17; agy 1.1.3 print-mode soft-deny; `src/lib/adapters.js` |
| **Mansion rule** | Adapters must fail **loudly** with typed error (`permission-denied-headless`); room trust “breathe” reduces need for tool prompts inside declared roots; never treat empty output as success |

### 3.7 Dependency cascade without approval hygiene

| Field | Detail |
|-------|--------|
| **Class** | Failed/rejected dependency leaves orphan pending write approvals on dependents |
| **Evidence** | `test/dependencies.test.js` (failed dep expires pending write approval; denied dep rejects task) |
| **Mansion rule** | Work graph transitions must cascade **authority** (expire/reject) with status |

### 3.8 Projection / buffer hazards (secondary)

| Class | Symptom | Evidence | Design out |
|-------|---------|----------|------------|
| Oversized git inspect throw | Workspace panel dies | `test/workspace.test.js` truncate | Caps + markers, never throw on size |
| Untracked invisible in diff | Operator misses agent files | same | Include untracked content |
| Stream cross-talk after cancel | Next reply polluted | `test/adapters.test.js` Grok cancel | Isolate stream buffers per execution id |
| Wall-clock history sort | Wrong causal order | `test/event-identity.test.js` | Monotonic seq only |

### 3.9 PR #2 triage map (what not to re-litigate)

| ID | Claim | Disposition on main | Mansion note |
|----|-------|---------------------|--------------|
| **F2** | Ghost pending after delete mid-start | **Fixed** `7a29e65` + regression | **Design out** as §3.1 |
| F1 | `retryTask` issues | Obsolete — no `retryTask` on main | N/A |
| F3/F4 | Workspace inspect gaps | Fixed by salvage `398e60b` | Port truncate + untracked |
| F5 | Block dependents on delete | Intentional on main | Keep safer policy |
| F6 | Per-run diff UI | Not on main | Product choice (S1), not a bug |
| S2 | Write-by-default | Product choice | Aligns with breathe; not a silent port |

PR #2 itself: **closed not merged** (would delete ~6,577 test lines); branch preserved `c6223ed` for archaeology only.

---

## 4. Regression tests worth carrying over

Do **not** copy test harness blindly. Re-express invariants against Mansion modules. Priority tiers:

### 4.1 P0 — domain correctness (must have day-1)

| v1 test file | Case(s) to re-express | Invariant |
|--------------|----------------------|-----------|
| `test/task-deletion.test.js` | exact confirm; active block; **approve×delete race → expired not pending**; tombstone after restart | Delete + authority race safety |
| `test/start-safety.test.js` | C1 write→pending approval; M1 failed start re-pends when task lives; M2 single run under concurrent start/drain | Start races |
| `test/policy.test.js` | rate cap; **reverts do not refund seats**; pause denies; shell metachar refusal (if gated profile kept) | Authority accounting |
| `test/autopilot.test.js` | chat never creates tasks even with full autopilot; cancelled never retried; rate-capped second write | Chat/work + cancel/retry |
| `test/server.test.js` | FR-CHAT-004 chat≠task; one run per agent; write serialization | Core scheduling |
| `test/event-identity.test.js` | monotonic seq; restart no reuse; same-ms order | History identity |
| `test/dependencies.test.js` | cycles rejected; unmet dep waits; failed dep expires approval | Graph integrity |
| `test/trust.test.js` | unleashed auto-approves write+command; pause/concurrency still hold | Breathe profile |

### 4.2 P1 — process & workspace

| v1 test file | Carry | Invariant |
|--------------|-------|-----------|
| `test/workspace.test.js` | all 4 (clean, untracked, oversized tracked, oversized untracked) | Inspect never throws on size; untracked visible |
| `test/process-manager.test.js` / reserve paths in start-safety | slot reserve | Capacity honesty |
| `test/store-security.test.js` | redaction patterns; workspace boundary prefix | Secrets + path jail |
| `test/state-projection.test.js` | output tail; command preview caps; exact command for command-approvals | API payload safety |
| `test/idle-watchdog.test.js` | silence on no-eligible; no double-fire; fossils not eligible | Heartbeat hygiene |

### 4.3 P2 — adapters & UX (port when adapters exist)

| v1 test file | Carry | Note |
|--------------|-------|------|
| `test/adapters.test.js` | accessMode→flags; cancel stream isolation | Per-CLI; fail loud on headless deny |
| `test/agent-heartbeat.test.js` | newest signal; honest none; no invented timestamps | UI optional |
| `test/chat-feed.test.js` | chat feed excludes task noise | Conversation surface |

### 4.4 Leave behind (do not port as load-bearing)

| Area | Why leave |
|------|-----------|
| `test/adversarial-memory-eval.test.js`, memory E2E stack | Research / unfinished dual-store; re-implement from ADR requirements only when needed |
| `test/capability-probes.test.js`, `capability-badges.test.js` | Declared≠proven theater; optional later |
| `test/backup-*.test.js` | Experimental; not live product surface |
| PR #2 branch lifecycle L2–L7 / R1–R3 not on main | Superseded or contradict main’s safer delete policy |
| Deferred/quarantine test landfills | Signal of retrofit stress — green suite only |

### 4.5 Suggested Mansion day-1 test names (spec, not implementation)

1. `authority: approve then delete before start expires approval (no ghost pending)`  
2. `authority: failed start with living task re-pends for operator recovery`  
3. `authority: auto-approve audit events count toward rate cap after re-pend`  
4. `work: chat message creates zero tasks under full auto-approve policy`  
5. `runtime: cancel is terminal and excluded from retry`  
6. `runtime: concurrent starts reserve one slot / one agent run`  
7. `work: one workspace-write writer; second queues with explicit blocker`  
8. `work: delete requires confirmTaskId; tombstone survives restart`  
9. `events: seq monotonic across restart; wall-clock ties broken by seq`  
10. `workspace: huge diff truncates; untracked content included`  
11. `hard-gates: destructive actions still require explicit gate under breathe trust`  
12. `adapters: headless permission deny surfaces typed failure, not empty success`

---

## 5. PR #2 / salvage — what landed vs museum-only

| Item | Landed on main | Commit / note |
|------|----------------|---------------|
| Untracked + truncation in `inspectWorkspace` | Yes | `398e60b` + `test/workspace.test.js` |
| F2 ghost approval fix | Yes | `7a29e65` + race test in `task-deletion.test.js` |
| Chat/work split (earlier) | Yes | `2c3fa8c` lineage |
| Write-by-default (S2) | No | Product decision for Mansion breathe |
| Per-run execution.diff UI (S1) | No | Optional later |
| PR #2 merge | **Closed** | Superseded; branch `claude/agent-swarms-loop-feature-pqm7od` @ `c6223ed` preserved |

---

## 6. Accidental complexity (do not port as architecture)

Summarized from production scars — full narrative in `REFERENCE.md` §4:

| Scar | Mansion direction |
|------|-------------------|
| Monolithic `src/server.js` | Thin host + pure domain modules |
| JSON room aggregate + partial SQLite memory dual path | One durable store + event log early |
| Default-deny allowlist maze as default UX | Breathe + hard gates + audit log |
| Capability broker / badge theater | Optional probes later |
| Multi-tenant security crush | Trust perimeter + light auth |
| Giant `COORDINATION.md` as only SoT | Protocol file small; handoffs in store |
| Restart gate mythology | Durable runs from day 1 |
| Branch/PR archaeology as architecture | Tests + this inventory |

---

## 7. Evidence index (museum map)

| Topic | Path |
|-------|------|
| Initial state | `src/lib/store.js` → `initialState` |
| Policy / unleashed / rate cap | `src/lib/policy.js` |
| Task delete | `src/lib/task-deletion.js` |
| Ghost / failed start | `src/server.js` → `revertFailedStart` |
| Process slots | `src/lib/process-manager.js` |
| Workspace inspect | `src/lib/workspace.js` |
| Event sequence | `src/lib/store.js` `ensureEventIdentity` |
| Adapters | `src/lib/adapters.js` |
| Idle / fossils | `src/lib/idle-watchdog.js` |
| Restart semantics | `docs/restart-gates.md` |
| Memory aspirations (not full product) | `docs/adr/0001-conclave-memory-architecture.md` |
| Agent protocol | `AGENTS.md`, `COORDINATION.md` |
| Freeze | `FREEZE.md` |
| F2 handoff | `COORDINATION.md` — Claude 2026-07-17 12:45 UTC |
| Salvage handoff | `COORDINATION.md` — Claude 2026-07-17 12:35 UTC |

---

## 8. Explicit non-goals of this artifact

- No changes under Conclave `src/` or `test/` (freeze).  
- No runnable code in Mansion beyond what already exists at `U:\mansion`.  
- Does not replace CHARTER or ARCHITECTURE — feeds them.  
- Does not mandate porting Conclave’s gated default; Mansion may start from unleashed/breathe and keep hard gates only.

---

## 9. Verify this document

```powershell
# From U:\coding_conclave
Test-Path _projects/mansion/docs/V1-LESSONS.md
Select-String -Path _projects/mansion/docs/V1-LESSONS.md -Pattern 'F2|revertFailedStart|task-deletion|ghost|rate cap|7a29e65'
# Cross-check live museum tests still present:
Select-String -Path test/task-deletion.test.js -Pattern 'approve racing a delete'
Select-String -Path src/server.js -Pattern 'Task deleted'
# Optional: sibling copy
Test-Path U:\mansion\docs\V1-LESSONS.md
```

No `npm test` required for this docs-only unit (Conclave freeze; suite remains green at 232 if run for confidence).
