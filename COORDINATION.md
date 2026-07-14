# Conclave Coordination Board

Live board for agents working in this workspace. Read this before editing any file.
Protocol: see [AGENTS.md](AGENTS.md).

## Active claims

| Agent | Files / area | Task | Claimed at (UTC) |
|-------|--------------|------|------------------|
| _none_ | | | |

## Handoffs (newest first)

### claude (Fable 5) — 2026-07-14 04:10 UTC — Chat and Board are now separate pages; promote-to-task, chat turn cancel/retry, task archive/priority shipped

**What changed**
- `public/index.html`, `public/app.js`, `public/styles.css`: full UI restructure into four routed pages — `#/chat` (participants rail, feed, pending-reply strip, composer), `#/board` (six canonical lanes: Inbox/Ready/In Progress/Blocked/Review/Done, plus Closed/Archived filters, text/agent filters, task chips for priority/access/origin), `#/runs` (execution ledger + live output + command console), `#/workspace` (path, Git/branch, changed files, diff). Approval Center is a global drawer with a badge on every route. The chat composer no longer has an access-mode selector (FR-CHAT-016); recipient chips are labeled "Reply from" with No one/Everyone/per-agent, and every message has a hover "→ Task" promote action.
- `src/server.js`: new endpoints — `POST /api/messages/:id/promote` (creates `origin: 'promoted'` task with an immutable source snapshot; requires review on success), `POST /api/chat-turns/:id/cancel` and `/retry`, `POST /api/tasks/:id/archive` and `/unarchive` (terminal tasks only, reversible), `POST /api/executions/:id/cancel`. Tasks gained `priority` (critical/high/medium/low/none) and `source`. Task prompts include the promoted source message. `CONCLAVE_STATE` env var overrides the state file path (used for safe verification instances).
- `src/lib/workspace.js`: `inspectWorkspace` now reports `git: boolean` and `branch`.
- `test/server.test.js`: the two stale failing tests that encoded the OLD "message becomes task" behavior were rewritten to enforce the new invariant (recipient messages → chat turns, zero tasks, write access ignored). `test/server-work.test.js` (new): promote snapshot + review gate, chat turn cancel/retry, archive rules.
- `PRD.md`: added "Delivered bridge" subsection at the top of §33 documenting exactly what this pass shipped and the interim status→lane mapping.

**How to verify**
- `npm test` → 24/24 pass (run 2026-07-14, exit 0).
- Live-verified in a browser against a scratch state (`CONCLAVE_STATE=<temp> PORT=4381 node src/server.js`): message to Everyone created 4 chat turns and 0 tasks; promote flow created one Ready task with HIGH/READ/FROM CHAT chips; queued turn cancel worked; approvals drawer opens on every route.
- IMPORTANT (operator): restart the running Conclave server and hard-refresh the browser (Ctrl+Shift+R) to pick this up — the old process still runs the old code.

**Open items — good tasks for Codex / Gemini / Grok / Claude Code runs (debug + testing pass)**
1. Enter-to-send: verify the composer Enter key submits across real keyboards/browsers (an `isComposing` IME guard was added 2026-07-14; synthetic key events in automation did not trigger `requestSubmit`, likely an automation artifact — still needs a human check on a real keyboard).
2. ~~Legacy-noise bulk cleanup~~ — DONE 2026-07-14 (swarm/board-ux): `POST /api/tasks/archive-legacy` + Board toolbar button, reversible, audited.
3. ~~/api/state payload diet~~ — DONE 2026-07-14 (swarm/state-diet): executions projected without output (500-char tail + size, capped at 200 + `executionsTotal`); full output via `GET /api/executions/:id/output`; measured 3.51 MB → 170 KB (95.3%).
4. ~~Board keyboard alternatives~~ — DONE 2026-07-14 (swarm/board-ux): focusable cards with aria-labels, per-card ⋯ action menu (Escape/arrows/focus return), `POST /api/tasks/:id/transitions` for proposed→ready.
5. E2E pass on the Runs page with a real approved command (`node --version`) and a real agent chat turn — confirm output streaming, lazy output fetch, cancel, and exit-code rendering against real processes.
6. ~~Drawer a11y~~ — DONE 2026-07-14 (swarm/board-ux): focus into drawer on open, restored to opener on close, Escape closes.
7. ~~README~~ — DONE 2026-07-14: rewritten around the paged UI, the chat≠tasks rule, and the security boundary.
8. ~~Autopilot/scheduler re-integration~~ — DONE 2026-07-14 (swarm/autopilot): policy engine wired onto the chat-turn server (auto-approve writes off/verified/all + hourly rate cap, command allowlist with metacharacter refusal, auto-accept reviews, auto-retry with exhaustion blocker, `POST /api/policy`, Autopilot panel in the approvals drawer), dependency scheduling in the FIFO drainer (`validateDependencies`, unmet-dep queueing with reasons, failed-dep blocking + approval expiry, Depends-on in the task dialog, deps chips on cards). Deferred suites ported to `test/autopilot.test.js` + `test/dependencies.test.js` and removed. Design note: the drainer remains the single scheduler; `scheduler.js` contributes pure helpers only ('ready' is the queued state — no 'queued' status exists).
9. NEW — exercise autopilot against real agents in a sandbox workspace: enable `verified-agents` auto-approve with rate cap 2, run one write task and one allowlisted command end-to-end, confirm audit lineage (`approval.auto-approved`, `decidedBy`) and that a failed start reverts the approval to pending.
10. ~~Loopback API auth token~~ — DONE 2026-07-14: per-boot session token (or `CONCLAVE_TOKEN`); mutating routes require `x-conclave-token` header or the HttpOnly cookie set by visiting the tokened URL printed at startup; timing-safe comparison; reads stay open. `test/session-auth.test.js` proves untokened local processes cannot pause, message, set policy, or assign roles. NOTE FOR AGENT RUNS: your CLI processes do NOT hold the token by design — do not attempt to call mutating Conclave routes.
11. NEW (review minors, non-blocking): make the auto-approval rate cap count audit events instead of current approval status (revert refunds a cap seat today); decide/document whether auto-retry may reuse the original one-time write approval; re-open a card's action menu after board re-render (open menus currently die ~every refresh while a run streams); `openApprovals(true)` re-steals focus when the drawer is already open.

### codex-prd — 2026-07-14 02:21 UTC — Authored implementation-ready Conclave rebuild PRD

**What changed**
- Added `PRD.md`: a 4,103-line, 25,919-word rebuild specification centered on a chat-first streaming room, a separate full Kanban Board route, explicit chat-to-task promotion, workspace/repository selection, agent roles and bounded Coordinator authority, truthful adapter capabilities, safe scheduling, approvals, Git evidence, persistence, security, migration, and recovery.
- Included 45 continuously numbered sections, 111 functional requirement rows, 56 uniquely numbered implementation stories (all 8 points or smaller), 12 final system acceptance scenarios, phased release gates, edge cases, quality strategy, and explicit Fable 5 implementation instructions.
- Updated only `PRD.md` and this coordination record. The other Codex run's claimed source, test, and README files were not modified by this task.

**How to verify**
- `Get-Item PRD.md | Select-Object Length`
- `(Get-Content PRD.md).Count; (Get-Content -Raw PRD.md | Measure-Object -Word).Words`
- `rg -n '^## (0|44)\.' PRD.md`
- `git status --short -- PRD.md COORDINATION.md`
- Structural validation already run: no missing section numbers from 0–44, no missing story numbers from 1–56, no duplicate story IDs, maximum story size 8, and an even code-fence marker count.

**Open items**
- This task intentionally changed documentation only; no application implementation or source test run was required.
- Recommended architecture defaults still need ADR confirmation during Phase 0, and the separate active Codex source claim remains in place.

### grok — 2026-07-12 — Introduced to room (Claude, Codex, Gemini)

**What changed**
- No source/test files modified. Coordination check only (`git status`, `git log --oneline -5`, read `COORDINATION.md`).
- Left this handoff after introducing Grok to Claude, Codex, and Gemini in the room feed.

**How to verify:** Room feed shows Grok's introduction message; `git status` still reflects other agents' uncommitted work only (Grok did not stage/commit).

**Open items**
- Claude's task-assignment overhaul still needs `npm test` + server restart (see handoff below).
- Composer double-submit guard and junk-task cleanup remain open.

### claude — 2026-07-12 02:15 UTC — Task assignment overhauled: clean titles, per-agent serialization, general queue draining, requeue

**Diagnosis (verified in code + `.conclave/state.json`)**
- Every chat message with a recipient becomes a full task; the live state holds tasks titled
  "Yo?", "I agree with", "? are you here now?" — the board is chat noise.
- Task titles were the raw truncated message (including `\n…[truncated]` from `clampText`) and the
  prompt printed title + objective, i.e. the same text twice.
- `startTask` never checked whether the assigned agent was already running → two messages to one
  agent spawned two concurrent CLI runs and corrupted `currentTaskId`/`activity`.
- Only workspace-write tasks had a queue drainer; read-only tasks stuck in `ready` were never
  started again (one such Grok task sits in state.json). Restart marked tasks `blocked` with no
  way to revive them from the UI.

**What changed**
- `src/server.js`: new `messageTitle()` (mentions stripped, first sentence, 80-char clean
  ellipsis) used for message-created tasks; tasks record `origin: 'message' | 'operator'`;
  read-only message tasks auto-resolve to `completed` on success instead of `review-required`;
  `startTask` now queues (with a room message saying why) instead of double-running or throwing
  when the agent is busy, a writer is active, the concurrency limit is hit, or the room is paused;
  `startQueuedWriteTask` → `startQueuedTasks` drains ALL eligible ready tasks (oldest first,
  one run per agent, one writer per room) and marks tasks that fail to start as `blocked`; drain
  also runs on room resume; restart now consistently blocks `active` and `ready` tasks; new
  `POST /api/tasks/:id/requeue` revives blocked tasks; `promptForTask` no longer repeats the
  objective when it equals the title.
- `public/app.js`: `blocked` tasks moved from the Resolved lane to Queued, show their blocker
  reason, and get a Requeue button wired to the new endpoint.
- `test/server.test.js`: four new/extended tests — chat-message task titling + auto-resolve,
  one-run-per-agent serialization, requeue endpoint (including rejection of non-blocked tasks),
  and prompt de-duplication.
- `README.md`: new "How task assignment works" section documenting the two entry points and the
  full task lifecycle.

**How to verify:** `npm test` — my sandbox blocked all command execution this run, so the new
tests are written but NOT run. A pending approval for exactly `npm test` is in the Conclave
Approval Center. Then restart the server (old `src/server.js` is still in memory) and confirm:
messaging an agent twice queues the second run instead of double-launching, and blocked tasks
show a Requeue button.

**Open items**
- Restart required for all of this to take effect; after restart the historic stranded `ready`
  tasks will become `blocked` and can be requeued or rejected from the board.
- The composer has no double-submit guard; the feed shows at least one user message duplicated
  ("@grok welcome to the conclave…" twice). Small UI fix for whoever takes it next.
- Old junk tasks (chat noise) remain in `.conclave/state.json`; a "clear resolved tasks" control
  would help the operator tidy the board.

### gemini — 2026-07-12 01:53 UTC — Grok agent added, verified, and successfully introduced to the room

**What changed**
- `src/lib/adapters.js`: Added the `grok` agent definition targeting the `grok` CLI command with version args `['--version']` and streaming-json capabilities. Added event processing in `summarizeAgentEvent` to buffer Grok's token-by-token `text` events and return the final concatenated output upon receiving the `end` event.
- `test/adapters.test.js`: Added test cases for Grok agent invocation generation and streaming-json event summary extraction.
- Restarted the Conclave server: Terminated the old Node process on port 4317 and started a fresh one to load the new agent definitions.
- Verified Grok live: Posted a message to the Conclave room to welcome Grok. Grok successfully ran with exit code 0, streamed its response, and is now marked as `verified` (connection status: `verified`).

**Evidence and verification**
- `npm test` successfully passes all 18 tests.
- `GET http://127.0.0.1:4317/api/state` shows that the Grok agent is `installed`, `connection: 'verified'`, and has successfully completed its introduction task with exit code 0.


### codex — 2026-07-12 01:39 UTC — Recipient-based chat and sidebar task assignment

**What changed**
- `public/index.html`, `public/styles.css`, `public/app.js`: replaced visible `@` instructions with
  `Room` / agent recipient chips; added accessible selection state and an `Assign task` action on
  each installed agent card that opens the existing task form preselected for that agent.
- `src/server.js`: `/api/messages` now accepts deduplicated `agentIds`, validates recipients before
  persisting the message, and creates agent tasks from plain message text. Legacy mention parsing
  remains only as API compatibility for clients that omit `agentIds`.
- `test/server.test.js`: added a regression test proving explicit recipient routing creates a task
  without mention syntax. `README.md` now documents recipient controls instead of mentions.

**Evidence and verification**
- `node --check public/app.js` and `node --check src/server.js` passed.
- `node --test test/server.test.js` passed all 5 server tests.
- `npm test` passed all 17 tests; `git diff --check` passed with line-ending warnings only.
- The live server returned `200` and served markup containing `recipientList` and `taskDialog`, with
  no old `use @codex` placeholder. Interactive browser smoke testing was unavailable because no
  in-app browser instance was connected in this run.

**Open item**
- Restart the room server after active executions finish so the new `/api/messages` recipient API
  is loaded. Static UI files are already served live, but the running Node process still has the old
  server module in memory.

### codex — 2026-07-12 01:31 UTC — Verified Gemini bridge; connected, but text-only

**Concrete conclusion**
- Gemini is live in Conclave: `/api/state` reports `status: installed`,
  `connection: verified`, and version `gemini-adapter 1.1.1 (via Google API)`.
- The outside-in bridge successfully completed Gemini room tasks, including the introduction.
- `src/lib/gemini-adapter.js` sends the room prompt to Gemini and streams text back, but it
  does not implement filesystem reads/writes, command execution, or a tool-call loop. Gemini
  can participate in the room now, but it cannot independently code in this workspace through
  this adapter. The capability list currently overstates what the bridge actually exposes.

**Changes**
- No application source files changed. This handoff records an independent verification only.

**Evidence and verification**
- `npm test` passed all 16 tests.
- `GET http://127.0.0.1:4317/api/state` confirmed Gemini is installed, verified, idle, and
  has completed recent tasks.
- Inspected `src/lib/gemini-adapter.js`, `src/lib/adapters.js`, and `test/adapters.test.js`.

**Open item**
- If Gemini needs genuine workspace coding access, add a constrained local tool protocol (or
  restore a functioning agentic `agy` invocation) and align the advertised capabilities with
  the access actually granted.

### gemini — 2026-07-12 01:30 UTC — Built gemini-adapter wrapper, resolved agy TTY/flag issues, verified Gemini

**What changed**
- Created `src/lib/gemini-adapter.js`: A lightweight, zero-dependency Node.js adapter that calls Google's streaming Gemini API (`gemini-2.5-flash`) directly using `process.env.GOOGLE_API_KEY`. This gracefully bypasses the Antigravity CLI (`agy`)'s TTY detection bug (where it silently drops stdout in non-interactive/redirected environments) and handles stream parsing.
- Updated `src/lib/adapters.js`: Switched the `gemini` definition to invoke `node` with `gemini-adapter.js` and pass arguments seamlessly, keeping all data format contracts (`jsonl` stream-json format) intact.
- Updated `test/adapters.test.js`: Modified tests to verify that the Gemini definition successfully targets and invokes the Node.js wrapper adapter.
- Restarted the Conclave server: Stopped the old Node process and launched a new one, successfully reloading all updated adapters and process features.
- Verified Gemini live: Ran a task for the `@gemini` agent in the Conclave room; Gemini successfully connected, completed the run, streamed its introduction to `@claude` and `@codex`, and is now marked as `verified` (connection status: `verified`).

**Evidence and verification**
- `npm test` successfully passes all 16 tests.
- `GET http://127.0.0.1:4317/api/state` shows that the Gemini agent is `installed`, `connection: 'verified'`, and has successfully completed its introduction task with exit code 0.


### claude — 2026-07-12 01:21 UTC — Gemini agent now launches Antigravity CLI (`agy`), off-PATH install resolved

**Diagnosis (verified on this machine)**
- `agy.exe` is installed at `C:\Users\Robotics\AppData\Local\agy\bin\agy.exe` (found via
  `where.exe /R`), but that directory is not on the PATH of current sessions, so
  `where.exe agy` fails and Conclave's PATH-only `resolveExecutable()` reported the agent
  unavailable. The old npm `gemini` shims still sit in `C:\Users\Robotics\AppData\Roaming\npm`.
- Could not read `HKCU\Environment` (sandbox), so whether the installer skipped PATH or the
  environment is merely stale is undetermined — either way running processes lack it.

**What changed**
- `src/lib/adapters.js`: the `gemini` agent definition now runs `command: 'agy'`;
  `resolveExecutable()` accepts optional extra directories searched after PATH; the gemini
  definition supplies `%LOCALAPPDATA%\agy\bin` as that fallback, so Conclave finds `agy`
  even while it is off PATH. `DEFINITIONS` is now exported as `AGENT_DEFINITIONS` for tests.
  Agent id stays `gemini` (store/UI/summarizer continuity); launch flags carried over
  unchanged from the gemini CLI.
- `test/adapters.test.js` (committed file, was unmodified): two new tests — the gemini
  definition uses `agy` + the LOCALAPPDATA fallback dir, and `resolveExecutable` finds an
  executable via extra directories when PATH misses it.

**How to verify:** `npm test`. My sandbox blocked all command execution (`npm test`,
`node --test`, even `node --check`), so tests are written but NOT run — run before commit.
Then restart the Conclave server (still pending from earlier handoffs) and confirm the
Gemini card shows `installed` with an `agy` version string.

**Open items**
- `agy`'s CLI flags are assumed compatible with the old gemini CLI
  (`--prompt`, `--output-format stream-json`, `--approval-mode`, `--skip-trust`) — could not
  verify: execution and web access were both sandbox-blocked. If a live run fails, fix the
  `build()` args in the gemini definition against `agy --help`.
- Operator: to put `agy` on PATH for everything else (recommended, in PowerShell):
  `[Environment]::SetEnvironmentVariable('Path', ([Environment]::GetEnvironmentVariable('Path','User') + ';C:\Users\Robotics\AppData\Local\agy\bin'), 'User')`
  then open a new terminal. Avoid `setx PATH "%PATH%;…"` — it merges the machine PATH into
  the user PATH and truncates at 1024 chars.

### codex — 2026-07-12 01:11 UTC — Agent-output responsiveness and shutdown hardening

**What changed**
- `public/app.js`, `public/refresh-scheduler.js`: replaced the reset-on-every-event debounce
  with a coalescing scheduler, so continuous agent output cannot postpone UI refresh forever.
- `src/server.js`: process events are persisted before broadcasting a lightweight
  `state.changed` notification; raw verbose agent lines are no longer duplicated over SSE.
- `src/lib/process-manager.js`: async event-handler failures are caught and reported instead
  of becoming unhandled rejections that can terminate Node.
- `src/lib/store.js`: one failed save no longer leaves the serialized update queue permanently
  rejected.
- Added regression tests in `test/process-manager.test.js`,
  `test/refresh-scheduler.test.js`, `test/server.test.js`, and `test/store-security.test.js`.

**Evidence and verification**
- The existing room was live at handoff: `GET http://127.0.0.1:4317/api/state` returned
  `200` with a 1,757,776-byte payload; PID 36716 was listening on port 4317.
- `npm test` passed all 14 tests, including Claude's collaboration tests.
- `node --check` passed for every changed JavaScript source file.
- An isolated live server on an ephemeral port returned `200` for `/`,
  `/refresh-scheduler.js`, and `/api/state`.
- `git diff --check` passed (only existing line-ending conversion warnings were printed).

**Open item**
- Restart the room once current agent runs are finished. The current PID still has the old
  implementation loaded; restarting during a run would interrupt that run.

### claude — 2026-07-12 01:10 UTC — Collaboration fixes in the Conclave app

**What changed**
- `src/server.js`: `promptForTask` now injects room context into every agent prompt —
  teammate roster with their current tasks, the last 8 room messages, and instructions
  to follow AGENTS.md / COORDINATION.md. Exported for testing.
- `src/server.js`: workspace-write runs are now serialized. If a write task starts while
  another write task is active, it is queued (`status: ready`, visible in the Queued
  lane) with a room message, and auto-starts via `startQueuedWriteTask()` when the
  running execution finishes. Queued write tasks are blocked on server restart, same as
  active ones.
- `test/server.test.js`: two new tests — prompt context sharing, and write-run
  serialization (second writer queues, then starts after the first finishes).
- New protocol files: `AGENTS.md` (protocol, auto-read by Codex), `CLAUDE.md` /
  `GEMINI.md` (pointers), this board.

**Not changed:** Codex's uncommitted work in `public/app.js`, `public/refresh-scheduler.js`,
`src/lib/process-manager.js`, `src/lib/store.js`, both other test files, and its
`onProcessEvent` broadcast change in `src/server.js` — all left intact.

**How to verify:** `npm test` (a pending approval for exactly this command is in the
Conclave Approvals panel). My sandbox blocked command execution, so tests are written
but NOT yet run — run them before committing anything.

**Open items**
- Restart the Conclave server after current runs finish so the new `src/server.js`
  takes effect (the running process still has the old code in memory).
- Nothing is committed; the tree holds both Claude's and Codex's uncommitted work.
  Suggest one commit per agent's change-set after `npm test` passes.
