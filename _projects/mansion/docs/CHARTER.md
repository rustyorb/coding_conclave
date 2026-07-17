# Mansion Charter

**Status:** founding document (canonical)
**Date:** 2026-07-17
**Supersedes:** consolidates the draft `staging/mansion/CHARTER.md` into the project's canonical charter
**Companions:** [V1-LESSONS.md](V1-LESSONS.md) (what Conclave taught us) · `staging/mansion/ARCHITECTURE.md` (module APIs, event flows) · `staging/mansion/REFERENCE.md` (Conclave domain map)
**Active repo:** `U:\mansion` (this file lives in Conclave's `_projects/mansion/docs/` as the design record; mirror into the sibling repo's `docs/`)

---

## 1. What the Mansion is

The Mansion is a **local-first multi-agent coding environment for a single operator**: a room
where real, installed CLI agents (Codex, Claude, Gemini, Grok, …) chat with the operator and
each other, take on board tasks, edit and test code inside declared workspace roots, and leave
a durable, replayable record of everything they did.

It is the greenfield successor to Conclave v1, which is feature-frozen as a behavioral museum
and regression baseline. The Mansion ports Conclave's **proven behaviors** — never its code,
file tree, or accidental complexity. The portable inventory is [V1-LESSONS.md](V1-LESSONS.md);
treat it as a checklist, not a suggestion.

**Founding decision, not a retrofit:** the Mansion is built for the neighborhood it actually
lives in — one operator, local hardware, behind a firewall. Its trust model is
**trusted-local** (§4) from the first commit. Conclave's default-deny permission maze is one of
the things deliberately left behind.

## 2. Product goals

1. **Agents that breathe.** Routine work — reading, editing, running tests, committing inside
   declared workspace roots — happens without permission prompts or approval queues. The
   operator's attention is spent on direction and review, not on clicking "allow".
2. **Chat is not work.** A conversation lane for humans (never polluted with telemetry dumps)
   and a work board for tasks, with an explicit promote step between them. Chat replies are
   always read-only; write authority comes only from board tasks.
3. **Everything on the record.** One durable store with an append-only event log (per-room
   monotonic `seq`). Any task's causal lineage — who created it, what gate decisions applied,
   which executions ran, what changed, what the handoff said — is reconstructible after the
   fact, including at 3am after an agent did something weird.
4. **Coordination as a feature, not a ritual.** Time-bounded path leases, actionable handoffs,
   and liveness signals are first-class records in the store — replacing Conclave's
   multi-megabyte append-only `COORDINATION.md` file protocol. Markdown remains an export
   format for agents that read it, never the system of record.
5. **Honest execution.** Slot reservation before spawn, one run per agent, one workspace
   writer per room, cancel ≠ fail, secret redaction at ingest, output caps with full logs on
   demand, and restart reconciliation that never reports silent success.
6. **Recoverability over prevention.** For routine in-root work, the safety mechanism is undo
   and audit (git, tombstones, the event log) — not gates. Gates are reserved for the small
   class of actions that recoverability cannot walk back (§4.3).

### Non-goals

- **No multi-tenant SaaS posture.** No IAM, CSRF machinery, host-header validation mazes, or
  cloud dependencies. The perimeter is the operator's firewall.
- **No legacy code porting.** Conclave's `server.js` and file structure stay in the museum.
- **No capability theater.** Agents are real installed CLIs, detected honestly; no static
  badge claims without verification. Capability brokers and memory pipelines are deferred
  until earned (memory, when it comes, enters as a provenance-bearing read model — not a
  second source of truth).
- **No global system mutation as routine.** The workspace roots are the room; everything
  outside them is gated.

## 3. Module boundaries

Six product-level boundaries define the Mansion. Each maps onto the bounded contexts specified
in `staging/mansion/ARCHITECTURE.md` §2–4 (module names in parentheses); that document is the
authority on APIs and event flows.

| Boundary | Owns | Key invariants |
|----------|------|----------------|
| **Rooms** (Room, Workspace) | Room identity, declared workspace roots, trust posture, pause state, concurrency limits, coordinator | Workspace roots are declared absolute paths; `pathAllowed` is the in/out-of-room test; pause blocks new starts, never kills running children |
| **Agents** (Agents, Adapters) | Registered participants, install detection, free/busy activity, thin CLI adapters | Real CLIs only; detect + honest unavailable; adapters build argv, never decide policy |
| **Tasks** (Work, Conversation) | Chat lane, chat turns, board tasks, status machine, dependencies, deletion tombstones | Chat ≠ work; promote is explicit; status transitions are a table, not ad-hoc; delete is race-safe (confirm id, refuse while running, expire pending gates, block dependents with reason) |
| **Approvals** (Authority, HardGates) | Hard-gate classification, approval lifecycle, room policy, autopilot as operator standing will | Under default trust, approvals exist only for hard gates; terminal states are final; no ghost pendings (a failed start after approve re-pends only if the task still exists, else expires); rate caps don't refund; agents never decide their own gate |
| **Execution** (Runtime) | Slot reserve/release, spawn lifecycle, cancellation, timeouts, output capture, redaction | Reserve before spawn, release on every terminal path; one run per agent; one writer per room; cancel ≠ fail (no auto-retry of cancelled work); redact before persist and before stream |
| **Durable event history** (EventLog, Coordination) | Append-only event log with per-room monotonic `seq` + `recordedAt`, projections, leases, handoffs | Single durable store, no dual-store SoT; `seq` is the total order (wall-clock is not); events are never updated or deleted; leases are time-bounded, expired = free; handoffs carry exact verify commands |

Cross-boundary effects travel as events or explicit service orchestration — no module reaches
into another's tables. The host (HTTP commands + cursor-resumable SSE, session token, process
wiring) stays thin and owns no domain invariants; high-volume run output is kept out of the
main event stream and served on demand.

## 4. Trust model: trusted-local

### 4.1 Deployment assumption

One operator, on operator-owned hardware, behind the operator's firewall. The app binds to
loopback/LAN with a lightweight session token. The perimeter is trusted; the app does not
re-litigate it. This assumption is what the whole model is derived from — if it changes, flip
the switch (§4.5).

### 4.2 Default-allow inside declared workspace roots

Within a room's declared workspace roots, agents holding a `workspace-write` task may, without
any approval or prompt:

- read, create, edit, and delete files;
- run project commands — tests, builds, linters, package scripts;
- use git locally — branch, stage, commit, diff, log.

Chat turns and `read-only` tasks may read and inspect, never mutate. There is no allowlist to
maintain and no shell-metacharacter maze: in-root routine actions classify as **allow**.

### 4.3 Hard gates — the short list that still needs approval

An action requires an Authority approval only when it falls in a class that undo cannot walk
back (gate classes per ARCHITECTURE.md §4.11):

- **destructive-data** — wiping project roots, dropping databases, purging git history;
- **force-push** — force-pushing remotes, publishing packages;
- **secrets** — reading or exfiltrating credentials;
- **out-of-workspace** — any path escaping the declared roots;
- **global-system** — installing global tools, editing OS or host configuration.

Autopilot may hold standing operator approval for gate classes, but defaults to off even in
the default trust posture, and agents never approve their own gates.

### 4.4 Append-only action log — a record, not a gate

Every consequential action — workspace mutations, process spawns and exits, gate requests and
decisions, task transitions, lease claims — is appended to the event log with `seq`,
`recordedAt`, and actor identity. The log:

- **never blocks.** Logging is not a checkpoint; nothing waits for permission to be recorded.
- **is append-only.** Events are never rewritten; corrections are new events.
- **exists for recovery and debugging** — the "what did the agent do at 3am" question is
  answered by replaying the log, and paired with git and deletion tombstones it is the undo
  path for routine work.
- **redacts before persisting.** Secrets never land in event payloads.

This is the trade that makes default-allow safe enough for a trusted-local room: the room is
open, but the activities get written down.

### 4.5 One switch to tighten

A single room-level config value controls the trust posture:

```
trust: 'breathe' | 'gated'     // default: 'breathe'
```

- **`breathe`** (default) — the model above: default-allow in-root, approvals for hard gates
  only.
- **`gated`** — for deployments that face a network or otherwise exit the trusted-local
  assumption: routine workspace writes and commands also require Authority approval, and
  policy may add allowlists.

Tightening is one operator-only setting (`setTrust`), not a redesign: HardGates, the event
log, redaction, and execution invariants are identical in both postures — `gated` only widens
which actions require approval. Nothing else in the system may assume `breathe`; every write
path goes through the same classification so the switch actually works when flipped.

### 4.6 What we deliberately do not build

Multi-tenant IAM, CSRF protection, host-header validation, per-request capability brokering,
and default-deny allowlists. Conclave proved these cost agent throughput and operator patience
daily while defending against a threat model this deployment does not have. If the Mansion
ever becomes multi-operator or internet-facing, that is a new charter, not a config change.

## 5. Boundary with Conclave v1

Conclave v1 (this repository) is **feature-frozen as of 2026-07-17** — a behavioral museum and
232-test regression baseline. No Mansion code lands there; no Conclave code is copied here.
What crosses the boundary is behavioral: the invariants in §3, the bug classes in
[V1-LESSONS.md](V1-LESSONS.md) §3 (ghost approvals, rate-cap refunds, cancel-as-fail,
dual-starts, restart fossils, headless soft-denies, dependency cascades), and the regression
tests worth re-expressing (V1-LESSONS P0–P2 carry list) — written against Mansion's modules
from day one.

## 6. Success criteria for this charter

- [ ] Operator accepts the trusted-local model as the founding trust decision (or amends here).
- [ ] Architecture and scaffold conform: trust posture is a room field with exactly the two
      values in §4.5; event log is append-only with monotonic `seq`; hard-gate classes match §4.3.
- [ ] First milestones (cross-review task) derive from this charter + V1-LESSONS.
- [ ] Day-1 tests cover the §3 invariants and the V1-LESSONS P0 carry list.

---

**One-line export:** one operator, local hardware, trusted perimeter — agents breathe inside
declared roots, hard gates guard the irreversible, everything lands in an append-only log, and
one switch (`breathe` → `gated`) tightens the whole house if it ever faces a network.
