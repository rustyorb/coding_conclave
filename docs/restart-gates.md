# Live-room restart gates (open mode via `start-open.cmd`)

Exact go/no-go gates for bouncing the live Conclave room server. Written 2026-07-17
(task `task_9184ba95`) after Codex's safe-deletion handoff, with the full suite green
(`npm test` → 227/227). All line references are to the code shipped at that point.

**Status note (2026-07-17):** the open-mode restart these gates were commissioned for
already happened — the live server on port 4317 (PID 24776) booted 2026-07-17 09:51:47 UTC
from current disk code. The post-restart gates (G4–G6) were verified live that day; see
the COORDINATION.md handoff. Use this document for any *future* bounce.

## What a restart does (why the gates exist)

On boot, `initialize()` (`src/server.js:358-388`) mutates persisted state:

- every `running` execution → `interrupted` (`:362-365`) — the child process is dead;
- every `active` or `ready` task → `blocked` with a "Conclave restarted…" blocker (`:366-375`)
  — this is the mechanism that produced the fossil pile;
- every `active`/`queued` chat turn → `interrupted` (`:376-384`);
- then the idle watchdog starts (`:388`) and will later requeue *recoverable*
  restart-blocked tasks (ready-eligible deps + standing write authority,
  `src/lib/idle-watchdog.js:57-72`).

A clean shutdown (`close()`, `src/server.js:2137-2150`) cancels all child processes.
Either way, an agent that is mid-write when the server goes down is killed with the
workspace possibly half-written. Hence gate G1.

## Pre-restart gates — ALL must pass at the moment of the bounce

### G1 — No active mid-write agents

```powershell
$s = Invoke-RestMethod http://127.0.0.1:4317/api/state
$s.tasks      | Where-Object { $_.status -eq 'active' }    # must be empty
$s.executions | Where-Object { $_.status -eq 'running' }   # must be empty
```

Both lists empty. (Historical `interrupted` chat turns are terminal noise from prior
restarts — they do not block.) Supplementary: `git status --porcelain` in the workspace
should be clean or every dirty path understood; the restart doesn't touch the worktree,
but a dirty tree is evidence someone was mid-write recently.

**Self-reference trap:** a board-dispatched agent can never satisfy G1 — its own run *is*
the active execution, and bouncing the server kills its own process mid-run. G1 can only
be evaluated and acted on **operator-side (out-of-band)**, between agent runs.

### G2 — Correct launcher and environment

- Launch with `start-open.cmd` (repo root). It does exactly: `cd /d` to the repo dir,
  `set CONCLAVE_OPEN_ACCESS=1`, `node src/server.js`. State resolves to
  `.conclave/state.json` anchored to the repo (`src/server.js:24`), so the same board
  comes back.
- **Keep the console window** (or redirect its output somewhere durable). The boot banner
  prints the per-boot session token URL; even in open mode, memory/backup governance
  requires that explicit token (`src/server.js:2102-2108`). Losing the console = memory
  governance locked until the next restart. **Preferred hardening:** set `CONCLAVE_TOKEN`
  before launch to pin the token across restarts (`:2159`) — this removes the token trap
  entirely.
- Check for leftover env in the launching shell: `CONCLAVE_IDLE_INTERVAL_MS` /
  `CONCLAVE_IDLE_CHECK_MS` override the watchdog cadence (defaults 15m / 60s; 0 disables)
  — the 09:51Z boot inherited a ~1-minute interval this way. Also confirm
  `CONCLAVE_STATE`, `CONCLAVE_WORKSPACE`, `PORT`, `HOST`, `CONCLAVE_SQLITE_MEMORY` are
  unset unless deliberately chosen.

### G3 — Stop the old process cleanly, and only that process

```powershell
Get-NetTCPConnection -LocalPort 4317 -State Listen | Select-Object OwningProcess
```

Stop **only** the PID that owns the 4317 listener — Ctrl+C in its console if you have it,
otherwise `Stop-Process -Id <pid>`. Known hazard: orphan `node src/server.js` processes
from earlier boots may exist that are *not* bound to 4317 (e.g. PID 27140 from
2026-07-16) — matching on the command line kills the wrong process. Confirm the port is
free before relaunching (the `Get-NetTCPConnection` probe returns nothing).

## Post-restart gates — verify immediately after boot

### G4 — Deletion API present

Mutation-free probe (fails on the confirmation check before touching state,
`src/lib/task-deletion.js:23-25`):

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:4317/api/tasks/task_probe-nonexistent-0000' `
  -Method DELETE -ContentType 'application/json' `
  -Body '{"confirmTaskId":"probe-mismatch"}' -SkipHttpErrorCheck
```

- **PASS:** `400 {"error":"Confirm deletion with the exact task id"}` — route present
  (`src/server.js:1863-1879`) *and* the untokened mutation passed the auth gate.
- `403 "Session token required"` → open mode did NOT come up (G5 fail — env didn't reach
  the process).
- Anything else (404/unknown route) → the process is running pre-deletion code.

Also: `(Invoke-RestMethod http://127.0.0.1:4317/api/state).taskDeletions` is non-null
(the durable tombstone array is projected).

### G5 — Open mode restored, token trap accounted for

- The G4 probe returning 400 (not 403) *is* the open-mode proof: with no token presented,
  `hasSessionAuthority` passes only when `openAccess` is true (`src/server.js:2087-2090`).
- Console shows the `OPEN ACCESS mode` banner (`:2163-2170`).
- `GET /api/memory/items` untokened → **403 is expected and correct** (memory governance
  stays explicitly token-gated by design). Capture the tokened URL from the console, or
  have `CONCLAVE_TOKEN` pinned (G2), so memory routes remain reachable this boot.

### G6 — Board integrity after the bounce

```powershell
(Invoke-RestMethod http://127.0.0.1:4317/api/state).tasks | Group-Object status
node -e "const {listEligibleIdleWork}=await import('./src/lib/idle-watchdog.js');const s=JSON.parse(require('fs').readFileSync('./.conclave/state.json','utf8'));const {ready,requeueable}=listEligibleIdleWork(s);console.log(ready.length,requeueable.length,[...ready,...requeueable].filter(t=>t.status==='rejected'||t.archivedAt).length)" --input-type=module
```

- Rejected/archived fossil count unchanged (75 rejected as of 2026-07-17, 73 archived);
  the third number from the eligibility probe is **0** — no fossil is wakeable.
- Tasks the boot just marked restart-`blocked` are live work only; the watchdog requeues
  the recoverable ones after the idle interval — that is intended wake, not spam.
- Success ticks stay silent: watchdog chat messages appear only when it acts.

## Decision rule

Restart the live room **only** when G1–G3 all pass at the moment of the bounce, and treat
the restart as failed (investigate before dispatching any write work) unless G4–G6 all
pass right after boot. A board-dispatched agent must never perform the bounce itself (G1
self-reference trap) — hand it to the operator or an out-of-band scheduled window.
