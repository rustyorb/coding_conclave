# Mansion Build Plan — Milestones 1–3

**Status:** adopted (cross-review deliverable)
**Date:** 2026-07-17
**Inputs:** [CHARTER.md](CHARTER.md) (canonical founding doc) × [V1-LESSONS.md](V1-LESSONS.md) (port checklist) · [ARCHITECTURE.md](ARCHITECTURE.md) (module APIs)
**Build target:** `U:\mansion` (active sibling repo per CHARTER header + Conclave `FREEZE.md`). This file lives in `_projects/mansion/docs/` as the design record; mirror into `U:\mansion\docs\` on a mansion-scoped run.

This document does two things: records the **cross-review** of the charter against the v1
lessons (§1 — conflicts and gaps, each with a resolution this plan adopts), and defines the
**first three milestones** with acceptance criteria (§2). CHARTER §6 asked for exactly this.

---

## 1. Cross-review findings: CHARTER.md × V1-LESSONS.md

Alignment confirmed first: the five hard-gate classes (CHARTER §4.3) match ARCHITECTURE §4.11
name-for-name; chat ≠ work, monotonic `seq`, cancel ≠ fail, reserve-before-spawn, one-writer,
race-safe delete, and the F2 ghost-approval rule appear identically in both documents. The
conflicts and gaps that remain:

### C1 — CONFLICT: secrets gate vs. default-allow in-root *reads*

CHARTER §4.2 grants unprompted **reads** anywhere inside declared roots; §4.3 gates
"**secrets** — reading or exfiltrating credentials." A `.env` inside a declared root is both
at once. §4.5 also requires "every **write** path" to go through classification — under-scoped,
since the secrets class is a read hazard. V1 practice (V1-LESSONS B17) enforced secrets by
**redaction at ingest**, not read gates.

**Resolution adopted:** classification runs on **every action, reads included**, *before* the
in-root allow test. Routine in-root file reads classify `allow`; credential material is kept
out of the record by redaction-before-persist (the enforcement that actually worked in v1);
explicit credential-store access (keychains, env dumps, paths outside roots) classifies
`secrets`. Encoded in M1 acceptance. CHARTER §4.5 should be amended "write path" → "action
path" when next touched.

### C2 — GAP: hard-gate approval scope is unstated

V1-LESSONS B10: v1 approvals authorized the **task**, not a single execution (retries reused
write authority) — with the explicit instruction "document explicitly in v2." CHARTER is
silent on scope.

**Resolution adopted:** a hard-gate approval authorizes the **task × gate-class** — retries of
the same task reuse it; a different gate class re-pends. Failed-start handling follows the F2
rules (V1-LESSONS §3.1): re-pend only if the task still exists, else expire (`decidedBy:
'system'`). Encoded in M2.

### C3 — GAP: `gated` posture is underspecified

CHARTER §4.5 says `gated` "may add allowlists" with no policy shape; V1-LESSONS P0 carries
"shell metachar refusal **(if gated profile kept)**" — a test with nothing to anchor to.

**Resolution adopted:** in M1, `gated` is exactly this: the same classifier with a wider
mapping — routine in-root writes and commands classify `require-approval` instead of `allow`.
No allowlist language lands in M1–M3; the metachar-refusal test is carried **only if** an
allowlist policy is ever added (explicitly out of scope, §4 below). The testable invariant is
the **switch flip**: one action, `allow` under `breathe`, pending gate under `gated`, no other
code path different.

### C4 — GAP: liveness/watchdog has no owner in the charter's module table

V1-LESSONS B27 and §3.5 (watchdog must never reanimate terminal/quarantine states) plus the
P1 `idle-watchdog` tests have no home in CHARTER §3's six boundaries.

**Resolution adopted:** eligibility is a **pure rule in Tasks (Work)** — a function over task
state that terminal/tombstoned work can never satisfy; the timer/tick lives in the thin host,
which owns no invariants. No-reanimation acceptance lands in M3.

### C5 — RISK: two scaffolds, one product

CHARTER names `U:\mansion` the active repo; the room has *also* scaffolded a nested git repo
at `_projects/mansion` with overlapping module stubs. Left alone, the same module gets
implemented twice and forks.

**Resolution adopted:** all milestone code lands in **`U:\mansion`**. `_projects/mansion`
is the **design record** (docs only); its `src/`+`test/` scaffold is a frozen sketch, not a
build target. Canonical docs live here, mirrored to `U:\mansion\docs\` on mansion-scoped runs.

### C6 — GAP: adapter honesty is weaker in the charter than in the lessons

V1-LESSONS §3.6 requires a **typed** `permission-denied-headless` failure (the Gemini/agy
soft-deny class: empty output presented as success). CHARTER's Agents row requires "detect +
honest unavailable" at install time but says nothing about typed runtime failures.

**Resolution adopted:** adapters must surface typed errors — never treat empty output as
success. Day-1 test #12 lands in M3.

### C7 — GAP: orphan adoption is in the lessons but not the charter

CHARTER goal 4 covers leases, handoffs, liveness signals; V1-LESSONS B24 (adopt orphans:
expired leases, unfinished handoffs) has no charter counterpart.

**Resolution adopted:** lease records land in M2 with "expired = free" semantics (the
precondition for adoption). Adoption *behavior* is deferred past M3 — it needs a running
multi-agent runtime to mean anything. Flagged here so it is deferred, not lost.

### C8 — NOTE: vocabulary drift (not a conflict)

V1-LESSONS uses v1 names for charter concepts: *unleashed* → `breathe`, *approval* →
hard-gate decision, *audit* → event log. Tests re-expressed in Mansion use Mansion vocabulary
(the day-1 names in V1-LESSONS §4.5 already do).

### Open operator gate

CHARTER §6 checkbox 1 — operator accepts the trusted-local model — is still unticked. It is
an **M1 exit criterion** below: the foundation encodes the trust model, so the operator signs
off (or amends the charter) before M2 builds on it.

---

## 2. Milestones

Ordering: M1 → M2 → M3. Each milestone builds only on the ones before it; each maps its
acceptance criteria to the 12 day-1 test names in V1-LESSONS §4.5 (all 12 are covered:
M1 = #9 #11, M2 = #1 #2 #3 #4 #8, M3 = #5 #6 #7 #10 #12). Codex's kernel/outbox blueprint is
in-flight under adversarial review; these milestones pin **charter-level invariants only** —
the blueprint may reshape internals without moving these acceptance bars.

### Milestone 1 — Foundation: the log and the switch

**Goal:** a durable store with an append-only event log, a room that knows its roots and its
trust posture, and one classifier every action goes through — so the trust model is real code
before any feature sits on it.

**Scope (modules in `U:\mansion\src\modules\`):** `eventlog`, `room`, `workspace`,
`hardgates`, plus redaction in the store write path.
**Out:** tasks, approvals, execution, adapters, HTTP surface.

**Deliverables**

1. EventLog: append-only, per-room monotonic `seq` + server `recordedAt`; no update/delete
   API exists; restart never reuses a `seq`; wall-clock ties broken by `seq`
   (CHARTER §3 event-history row; V1-LESSONS B21, §3.8).
2. Room: `trust: 'breathe' | 'gated'` — exactly two values, operator-only `setTrust`;
   declared absolute workspace roots; `pathAllowed` as the in/out test; pause state
   (CHARTER §4.5, §3 rooms row).
3. HardGates: `classify(action) → 'allow' | gateClass` with the five classes of CHARTER §4.3;
   classification runs on **every action including reads** (C1); `gated` maps routine in-root
   write/command to `require-approval` with no other behavioral difference (C3).
4. Redaction before persist: secret patterns scrubbed at ingest; secrets never land in event
   payloads (CHARTER §4.4; V1-LESSONS B17).

**Acceptance criteria**

- [ ] Test `events: seq monotonic across restart; wall-clock ties broken by seq` (day-1 #9) passes.
- [ ] Test `hard-gates: destructive actions still require explicit gate under breathe trust` (day-1 #11) passes.
- [ ] Switch-flip test: the same in-root write action classifies `allow` under `breathe` and produces a pending gate under `gated`; flipping back requires no restart.
- [ ] `pathAllowed`: in-root path accepted, escape attempts (`..`, absolute outside roots) classify `out-of-workspace`.
- [ ] Redaction test: a token-bearing payload is appended; the persisted event contains the redaction marker and not the token.
- [ ] Append-only proof: the store module exports no event update/delete; a correction is a new event.
- [ ] `cd U:\mansion; npm test` → full suite green (existing 15 + new).
- [ ] **Operator sign-off** on the trusted-local model recorded (CHARTER §6 box 1 ticked or charter amended).

### Milestone 2 — Work & authority: chat ≠ work, exhaustive terminals

**Goal:** the conversation lane, the work board, and a gate lifecycle in which every v1
approval-race bug class (V1-LESSONS §3.1, §3.2, §3.7) is structurally impossible.

**Scope:** `conversation`, `work`, `authority` modules; `coordination` record types
(leases, handoffs).
**Out:** process spawning (M3), adapters (M3), UI.

**Deliverables**

1. Conversation vs. Work: chat turns never create tasks or carry write authority; promote is
   an explicit operation (CHARTER goal 2; V1-LESSONS B2).
2. Task status machine as a transition **table**; race-safe delete: exact-id confirm, refuse
   while running, expire all non-terminal gates for the task, tombstone survives restart,
   dependents blocked with a stated reason (CHARTER §3 tasks row; V1-LESSONS B13).
3. Authority state machine: `pending → approved | auto-approved | rejected | expired`,
   terminals final; `revertFailedStart(taskId, gateId)` branches on task existence (F2 rule);
   rate caps count **append-only events**, never current row status (no refund via re-pend);
   dependency failure/rejection cascades authority (expire/reject) with status; autopilot is
   operator standing will, defaults off, agents never decide their own gate; approval scope is
   task × gate-class (C2) (V1-LESSONS §3.1, §3.2, §3.7, B10, B11, B14).
4. Coordination records in the store: time-bounded leases (expired = free), handoffs that
   carry exact verify commands; markdown is export only (CHARTER goal 4; V1-LESSONS B23, B26).

**Acceptance criteria**

- [ ] Test `authority: approve then delete before start expires approval (no ghost pending)` (day-1 #1) passes.
- [ ] Test `authority: failed start with living task re-pends for operator recovery` (day-1 #2) passes.
- [ ] Test `authority: auto-approve audit events count toward rate cap after re-pend` (day-1 #3) passes.
- [ ] Test `work: chat message creates zero tasks under full auto-approve policy` (day-1 #4) passes.
- [ ] Test `work: delete requires confirmTaskId; tombstone survives restart` (day-1 #8) passes.
- [ ] Dependency tests re-expressed from v1 P0: cycles rejected; unmet dep waits; failed dep expires the dependent's pending gate.
- [ ] Lease rule test: an expired lease is claimable by another agent; a live one is not.
- [ ] All authority terminals reachable in tests and no transition out of any terminal state exists in the table.
- [ ] `cd U:\mansion; npm test` → full suite green.

### Milestone 3 — Honest execution: runtime, one writer, adapters that fail loudly

**Goal:** real processes under the invariants that kept v1 honest — no double-booking, no
cancel-as-fail resurrection, no restart fossils, no silent adapter denials.

**Scope:** `runtime`, `adapters`, `agents` (detection), workspace inspect.
**Out:** HTTP/SSE living-room surface (separate track), memory, capability probes.

**Deliverables**

1. Runtime: atomic slot **reserve before spawn**, release on every terminal path; one run per
   agent; one workspace-write writer per room with an explicit "why blocked" reason;
   `cancelled` is terminal and excluded from retry policy; output caps in projections with
   full per-execution log on demand (CHARTER goal 5; V1-LESSONS B6–B9, B18, B19, §3.3, §3.4).
2. Durable run records: restart recovers or cleanly terminalizes every run — never silent
   success, never a fossil left `active`; watchdog eligibility (pure rule in Work, per C4)
   can never select terminal or tombstoned work (V1-LESSONS §3.5, B27).
3. Adapters: real installed CLIs detected honestly; accessMode → argv; **typed** failures
   including `permission-denied-headless`; empty output is never success; stream buffers
   isolated per execution id (CHARTER §3 agents row; V1-LESSONS §3.6, §3.8, C6).
4. Workspace inspect: untracked content included; oversized diffs truncate with an explicit
   marker, never throw (V1-LESSONS B20).

**Acceptance criteria**

- [ ] Test `runtime: cancel is terminal and excluded from retry` (day-1 #5) passes.
- [ ] Test `runtime: concurrent starts reserve one slot / one agent run` (day-1 #6) passes.
- [ ] Test `work: one workspace-write writer; second queues with explicit blocker` (day-1 #7) passes.
- [ ] Test `workspace: huge diff truncates; untracked content included` (day-1 #10) passes.
- [ ] Test `adapters: headless permission deny surfaces typed failure, not empty success` (day-1 #12) passes.
- [ ] Restart reconciliation test: a run record left non-terminal by process death is recovered or terminalized on boot, and the event log records which.
- [ ] No-reanimation test: terminal/tombstoned tasks are never returned by the watchdog eligibility rule.
- [ ] Stream isolation test: output after cancel never pollutes the next execution's buffer.
- [ ] `cd U:\mansion; npm test` → full suite green.

---

## 3. Out of scope for M1–M3 (deliberately)

Memory subsystems (enters later as a provenance-bearing read model, CHARTER §2 non-goals);
capability probes/badges; allowlist policy language for `gated` (C3); orphan adoption
behavior (C7); HTTP/SSE living-room surface hardening (separate track — M1–M3 are fully
testable through module APIs without it); anything multi-tenant.

## 4. Verify this document

```powershell
# From U:\coding_conclave
Test-Path _projects/mansion/docs/BUILD-PLAN.md
Select-String -Path _projects/mansion/docs/BUILD-PLAN.md -Pattern 'C1|Milestone 1|day-1 #9|switch-flip|permission-denied-headless'
# All 12 day-1 test names from V1-LESSONS §4.5 appear exactly once each in §2:
Select-String -Path _projects/mansion/docs/BUILD-PLAN.md -Pattern 'day-1 #' | Measure-Object
```
