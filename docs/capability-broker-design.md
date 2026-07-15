# Capability Verification & Tool Broker Design

**Status:** design only (no product flip)  
**Author:** Grok (Conclave room)  
**Date:** 2026-07-15  
**Depends on (landed in-tree, not yet necessarily on `origin/main`):**

1. Grok cancel-bleed fix — per-invocation / finished-run drain of stream accumulators  
2. Execution `command` previews — create-time + `/api/state` projection via `previewCommand`  

**Sources:** Codex live CLI inventory (room 2026-07-14), re-probed on this host 2026-07-15, current `src/lib/adapters.js` / `process-manager.js` / `server.js` / `policy.js`, PRD §4.5 / §8 / §14 / §20.

---

## 1. Problem

Today Conclave lies in a polite way:

| Claim in UI / state | What it actually means |
|---|---|
| `connection: verified` | At least one `agent`/`chat` execution exited 0 (`server.js` marks agent verified on `execution.finished` completed) |
| `capabilities: [...]` | Static string list on `AGENT_DEFINITIONS` — never probed |
| Role / assignment “fit” | Free-text match against those static strings |
| Write safety | Operator (or autopilot/unleashed) approves the *whole run*; Conclave then trusts the CLI’s own sandbox/permission mode |

Consequences:

- Gemini historically advertised filesystem/command tools while running a text-only API bridge (fixed by `agy` at `a021c54`, but the badge model still cannot prove it).
- MCP servers attached to Codex/Claude/Grok are invisible to Conclave, so room policy cannot gate them.
- Per-tool interactive approval is not normalized across providers (README is honest about this); the product must not claim it until events prove it.
- A future control-plane “broker” that emits more lineage events would have inflated `/api/state` before the command-preview fix. Design assumes the **post-fix payload model**.

---

## 2. Inventory (this host, 2026-07-15)

Re-probed with `--help` / `mcp list` / `--version`. Secrets and env values are **not** recorded below — names and status only.

### 2.1 Installed versions

| Agent id | CLI command | Version observed | Adapter build surface (`adapters.js`) |
|---|---|---|---|
| `codex` | `codex` | `codex-cli 0.144.1` | `exec --json --sandbox {read-only\|workspace-write\|danger-full-access} --cd <ws> -` (stdin prompt) |
| `claude` | `claude` | `2.1.209` (Claude Code) | `--print --verbose --output-format stream-json --permission-mode {plan\|acceptEdits\|bypassPermissions}` (argv prompt) |
| `grok` | `grok` | `0.2.93` | `-p <prompt> --output-format streaming-json --permission-mode {plan\|acceptEdits\|bypassPermissions}` |
| `gemini` | `agy` | `1.1.2` | `-p <prompt> --mode {plan\|accept-edits} [--dangerously-skip-permissions]` (plain text, not JSONL) |

### 2.2 MCP management

| CLI | MCP subcommand | Status inventory on this host (names only) |
|---|---|---|
| **Codex** | `codex mcp` → `list`, `get`, `add`, `remove`, `login`, `logout`; also `codex mcp-server` (expose Codex as MCP) | Multiple configured entries: `context7`, `node_repl`, plugin-local servers, remote `figma` / `github` (auth status varies). **Do not persist commands/env in Conclave state.** |
| **Claude** | `claude mcp` → `list`, `get`, `add`, `remove`, `login`, `logout`, `add-json`, … | Multiple claude.ai connectors + `context7` + local HTTP `illustrator` (connect failure observed). List performs health checks. |
| **Grok** | `grok mcp` → `list`, `add`, `remove`, `doctor` | **No MCP servers configured** on this host at probe time. |
| **Antigravity (`agy`)** | **No `mcp` command** in installed help | Plugins exist (`agy plugin` / `plugins`); agentic modes only. **MCP gap.** |

### 2.3 Tool allow / deny and sandbox controls

| CLI | Per-run tool allow | Per-run tool deny | Sandbox / FS-network profile | Elevation / skip-all |
|---|---|---|---|---|
| **Codex** | Via config / features (not a simple `--tools` flag on `exec`); sandbox scopes shell | Approval policy for shell | `--sandbox read-only \| workspace-write \| danger-full-access` | `--dangerously-bypass-approvals-and-sandbox` (and elevated maps to `danger-full-access` today) |
| **Claude** | `--allowedTools` / `--tools` | `--disallowedTools` | Permission modes; `--add-dir`; safe-mode | `--dangerously-skip-permissions` (+ allow flag); elevated → `bypassPermissions` |
| **Grok** | `--allow <RULE>`, `--tools <TOOLS>` | `--deny <RULE>`, `--disallowed-tools` | `--sandbox <PROFILE>` / `GROK_SANDBOX` | `bypassPermissions` (flag name still needs live verify under unleashed) |
| **agy** | Not exposed as Conclave-mapped flags today | — | `--sandbox` (terminal restrictions); `--mode plan \| accept-edits` | `--dangerously-skip-permissions` when elevated |

### 2.4 Design implications of the inventory

1. **Native MCP is a child-process concern** for Codex/Claude/Grok. Conclave should **inventory and policy-bind**, not re-implement MCP transport for those CLIs in phase 1.
2. **Antigravity cannot be assumed MCP-capable.** Treat `mcp.inventory` / `mcp.invoke` as `unsupported` until a future agy release or a Conclave-side MCP guest bridge is separate product work.
3. **Allow/deny granularity differs.** Conclave’s stable capability keys must map *through* each adapter’s native flags; never invent a fake universal `--tools` for Codex.
4. **Sandbox is delegated** for workspace file/shell inside the agent run. The **broker** is for *Conclave control-plane* mutations (tasks, board, identity, policy intents) and for *policy profiles* applied at spawn — not for intercepting every Bash call inside Claude/Codex (that requires stream tool events we do not yet normalize).

---

## 3. Post-fix event & payload model (design baseline)

Any capability/broker work **must** respect these constraints already encoded in the tree:

### 3.1 Process events (ProcessManager)

```
execution.started   → { type, execution }     // execution.command is already previewCommand(redactSecrets(argv))
execution.output    → { type, executionId, taskId, agentId, stream, line, createdAt }  // line redacted
execution.cancelling→ { type, executionId, reason, createdAt }
execution.finished  → { type, executionId, taskId, agentId, exitCode, signal, reason, status, finishedAt }
```

Rules:

- One foreground run per agent; cancel records reason before kill so win32/taskkill does not look like a retryable failure.
- Grok (and any accumulator agent) **clears buffers on new invocation and on finished/cancel flush** — broker probes are just more runs; they must not reintroduce bleed.
- Full stdout stays on the execution record (capped); API projection strips full output.

### 3.2 API projection (`projectStateForApi`)

- Executions: last `STATE_EXECUTION_LIMIT` (200), `command` re-previewed, `output` → `outputSize` + `outputTail` (500 chars).
- Full output: per-execution fetch only.
- **New capability / MCP / probe records must be small, structured, and free of secrets** (no MCP env, no tokens, no full argv prompts).

### 3.3 Agent “verified” today

Still means “successful prior execution.” The design **splits** that into:

| Field | Meaning |
|---|---|
| `status` | `installed` / `unavailable` (PATH detection) |
| `connection` | process health: `unverified` \| `verified` \| `error` (keep; success of *any* real run or probe) |
| `capabilities[]` | **structured** objects with confidence (below), not bare strings |
| `capabilityProfileVersion` | adapter version + CLI version hash that produced the profile |

---

## 4. Goals and non-goals

### Goals

1. Replace static capability badges with **declared → probed → verified** confidence.
2. Ship a **minimal, names-only MCP inventory** per agent where the CLI supports it.
3. Apply **policy-bound tool/sandbox profiles at spawn** using each CLI’s native flags.
4. Define where a **Conclave capability broker** is required vs where we **delegate to the CLI sandbox**.
5. Keep `/api/state` lean: probe evidence is summary + pointers, not raw dumps.

### Non-goals (this design / phase 1–2)

- Intercepting every in-CLI tool call for interactive Conclave Approvals (no normalized `tool.approval.events` yet).
- Implementing a full MCP host inside Conclave for agy.
- Giving agents the operator session token.
- Unifying four CLIs into one fake tool API.

---

## 5. Capability model

### 5.1 Stable keys (PRD §8.4, adapted)

| Key | Evidence class | Notes |
|---|---|---|
| `conversation.stream` | Probe: short chat, structured/plain stream parse | All four adapters |
| `repository.read` | Probe: read a canary file under workspace | Requires FS tools or CLI read |
| `filesystem.write` | Probe: write+delete canary under workspace (write mode only) | Must not run in read-only |
| `command.execute` | Probe: allowlisted benign command e.g. `node --version` | Subject to room policy |
| `web.search` | Probe or CLI feature flag inventory | Optional; do not claim without evidence |
| `test.run` | Soft: successful prior test task, or probe | Often inferred from command.execute + history |
| `code.review` | Soft: successful review task | Role-facing, not hard gate |
| `mcp.inventory` | `mcp list` names-only | Unsupported on agy |
| `mcp.configured` | count > 0 from inventory | Not “MCP works for task X” |
| `tool.allowlist` | Adapter can pass allow/deny flags | Claude/Grok strong; Codex via sandbox/config |
| `sandbox.enforced` | Adapter maps accessMode → CLI sandbox/permission | All four, different mechanisms |
| `session.resume` | Future | Declared unsupported until probed |
| `usage.report` | Codex usage events already partially parsed | Soft |
| `tool.approval.events` | Stream emits tool-request events Conclave understands | **Declared unsupported** until per-adapter parsers exist |
| `structured.output` | JSONL / streaming-json parse success | codex/claude/grok; agy text-only |

### 5.2 Confidence

```text
declared  — adapter manifest claims it (static, always labeled as declared)
probed    — last probe run attempted this key; store result + timestamp + cliVersion
verified  — probe passed for current (adapterVersion, cliVersion) within TTL
unsupported — adapter explicitly cannot provide it (e.g. agy + mcp.inventory)
stale     — CLI version changed since last probe, or TTL expired
failed    — probe ran and failed (keep reason code, not full logs in state)
```

UI rule (PRD §4.5): never show a green “supports filesystem.write” from `declared` alone.

### 5.3 Record shape (suggested state)

```js
// state.agents[i].capabilityProfile
{
  adapterVersion: 1,                 // bump when build()/probe matrix changes
  cliVersion: '0.2.93',
  probedAt: '2026-07-15T…Z',         // null if never probed
  ttlHours: 72,
  capabilities: {
    'conversation.stream': { confidence: 'verified', evidenceId: 'probe_…' },
    'repository.read': { confidence: 'probed', result: 'failed', code: 'PROBE_READ_DENIED', evidenceId: 'probe_…' },
    'mcp.inventory': { confidence: 'verified', servers: ['context7', 'figma'], /* names only */ },
    'mcp.inventory': // agy:
    // { confidence: 'unsupported', reason: 'agy has no mcp subcommand' }
  }
}
```

Evidence blobs live beside executions (`kind: 'probe'`) with **preview commands** and truncated output tails — same post-fix path as agent runs.

---

## 6. Broker vs CLI sandbox — split of responsibility

```
┌─────────────────────────────────────────────────────────────────┐
│ Operator / Autopilot / Unleashed policy                         │
│  (session token, Approvals drawer, room.trust)                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────▼──────────────┐
              │  Conclave Capability Broker │  ← control plane + spawn profiles
              │  (server-side, no token to  │
              │   child agents)             │
              └───────┬─────────────┬───────┘
                      │             │
         intents      │             │  build(invocation)
         (tasks,      │             │  + tool profile flags
          board,      │             │
          identity)   │             ▼
                      │     ┌───────────────────┐
                      │     │ Provider CLI child│
                      │     │ sandbox / perms   │  ← data plane tools
                      │     │ + native MCP      │
                      │     └───────────────────┘
                      ▼
              audit + SSE events (lean)
```

### 6.1 Delegate to each CLI’s sandbox (do **not** reimplement)

| Concern | Owner | How Conclave participates |
|---|---|---|
| Workspace file reads/writes during a coding run | CLI sandbox / permission mode | Map `accessMode` + `elevated` → native flags (already partially done) |
| Shell commands the model invents mid-run | CLI approval/sandbox | Optional future: parse tool events; until then, do not claim per-tool approval |
| Provider-native MCP tool calls | CLI MCP config | Inventory names; optional spawn-time allow/deny if CLI supports it |
| Model selection, provider auth | CLI / user env | Detect auth failure codes; never store secrets in state |

### 6.2 Conclave broker **is** required

| Concern | Why CLI sandbox is insufficient |
|---|---|
| Creating/assigning/starting tasks, board ops, identity | Child has no operator token; must submit **intents** for server evaluation |
| Room policy, pause, rate limits, one-writer | Host-level; CLI cannot see other agents’ runs |
| Cross-agent coordination claims | Shared workspace protocol (`COORDINATION.md` is social; broker can enforce later) |
| Truthful capability badges & assignment gates | Requires probes and profile storage Conclave owns |
| Spawn-time **tool profiles** (which tools/MCP a *this* run may use) | Policy must be applied in `build()` before the child starts |
| Audit lineage for approvals vs outcomes | ProcessManager + audit log |

The broker Codex sketched for autonomy (structured intents, single-use authority, no token to agents) is the **control-plane** broker. Capability verification is the **readiness** half of the same architecture: *what can this agent truthfully do* before we grant intents or assign roles.

### 6.3 Decision rule

> If the action mutates **Conclave state** or **room policy**, it goes through the broker.  
> If the action mutates **workspace files/shell inside an already-approved agent run**, it stays inside the CLI sandbox Conclave configured at spawn.  
> If we cannot observe or constrain it, we must **not** advertise it as a Conclave-verified capability.

---

## 7. Spawn-time tool profiles (bridge between policy and CLI)

Introduce a pure function (suggested `src/lib/tool-profile.js`):

```js
buildToolProfile({ agentId, accessMode, elevated, roomTrust, policy, capabilityProfile })
→ {
  accessMode,
  elevated,
  sandbox,              // codex/grok
  permissionMode,       // claude/grok
  agyMode,              // gemini
  allowedTools,         // claude/grok when policy supplies
  deniedTools,
  mcpMode: 'inherit' | 'none' | 'allowlist',
  mcpAllowlist: [],     // names only
  notes: []             // human-readable limitations for UI
}
```

Adapters consume the profile inside `build()` instead of ad-hoc ternaries. That is the **exact** extension point for allow/deny and MCP scoping without a runtime interceptor.

**Default profiles (phase 2):**

| Room / access | Profile intent |
|---|---|
| `read-only` | Strongest sandbox/plan mode; deny write tools where flags exist; no elevated |
| `workspace-write` gated | acceptEdits / workspace-write; no bypass |
| `unleashed` + write | elevated flags as today; still no operator token in child |
| Policy command allowlist | Does **not** automatically become CLI `--allowedTools`; it gates Conclave `command` approvals only until tool-event normalization exists |

---

## 8. Per-adapter conformance probe list

Each probe is a real child invocation (or a side CLI command for inventory), recorded as `execution.kind === 'probe'`, purpose tagged, command previewed. **Pass criteria are observable**, not model self-report.

### 8.1 Shared probes (all agents)

| Probe id | Capability keys | Procedure | Pass |
|---|---|---|---|
| `P-detect` | (install) | `resolveExecutable` + `versionArgs` | executable + version string |
| `P-stream` | `conversation.stream`, `structured.output` | Minimal prompt “Reply with exactly: PROBE_OK”; parse via `summarizeAgentEvent` / flush | output contains `PROBE_OK`; structured agents parse without throw |
| `P-cancel` | (reliability) | Start stream, cancel mid-run, start second probe | Second reply has **no** first-run text (Grok regression class) |
| `P-preview` | (payload) | Inspect persisted execution.command | length ≤ ~200 + marker; no full multi-KB prompt |

### 8.2 Codex

| Probe id | Keys | Procedure | Pass / Fail notes |
|---|---|---|---|
| `P-codex-sandbox-ro` | `sandbox.enforced`, `repository.read` | `accessMode=read-only`, prompt to read `package.json` only | Completes; no write canary created |
| `P-codex-write` | `filesystem.write` | write mode, create+delete `.conclave-probe-codex` | file appears then gone; git dirty handled |
| `P-codex-cmd` | `command.execute` | allowlisted `node --version` via agent or operator command path | exit 0; version in output tail |
| `P-codex-mcp-list` | `mcp.inventory`, `mcp.configured` | `codex mcp list` (subprocess, not full agent) | names-only list parsed; **strip env/command columns before persist** |
| `P-codex-jsonl` | `structured.output`, `usage.report` | normal exec JSONL | `item.completed` / usage lines recognized |

**Adapter touchpoints:** `AGENT_DEFINITIONS.codex.build`, `summarizeAgentEvent` codex branch, new `probeCodexMcpInventory()`.

### 8.3 Claude

| Probe id | Keys | Procedure | Pass / Fail notes |
|---|---|---|---|
| `P-claude-plan` | `sandbox.enforced` | `--permission-mode plan`, ask to edit a file | no durable edit (or CLI refuses write) |
| `P-claude-tools-deny` | `tool.allowlist` | `--disallowedTools` Bash (or equivalent), ask to run `node --version` | model cannot execute / reports blocked |
| `P-claude-tools-allow` | `tool.allowlist`, `command.execute` | allow only benign tool set + write canary path | canary write succeeds under acceptEdits |
| `P-claude-mcp-list` | `mcp.inventory` | `claude mcp list` | names + health; store names + connected\|failed only |
| `P-claude-stream` | `conversation.stream` | stream-json assistant text | `summarizeAgentEvent` returns text |

**Adapter touchpoints:** `claude.build` must grow optional `allowedTools` / `disallowedTools` / `mcp-config` args from tool profile; **migrate prompt to stdin** (punch item 12) before large probe prompts.

### 8.4 Grok

| Probe id | Keys | Procedure | Pass / Fail notes |
|---|---|---|---|
| `P-grok-perm-plan` | `sandbox.enforced` | `--permission-mode plan` | read-only behavior |
| `P-grok-allow-deny` | `tool.allowlist` | `--deny` / `--disallowed-tools` vs `--allow` / `--tools` | deny blocks; allow permits documented built-in |
| `P-grok-sandbox` | `sandbox.enforced` | `--sandbox <profile>` if stable profiles documented | profile reflected in CLI behavior or help-validated enum |
| `P-grok-mcp-list` | `mcp.inventory` | `grok mcp list` | empty list is valid (`configured=false`) |
| `P-grok-cancel-bleed` | (reliability) | cancel mid-stream + new run | **no** cancelled text in next reply |
| `P-grok-bypass-name` | elevated mapping | unleashed write dry-run flag check | confirm `bypassPermissions` accepted by CLI (open item from trust handoff) |

**Adapter touchpoints:** `grok.build` tool profile flags; `textAccumulators` / `flushAgentSummary` / invoke-start clear (post cancel-bleed fix); optional stdin prompt if supported.

### 8.5 Gemini / Antigravity (`agy`)

| Probe id | Keys | Procedure | Pass / Fail notes |
|---|---|---|---|
| `P-agy-mode-plan` | `sandbox.enforced` | `--mode plan` | no writes |
| `P-agy-mode-edit` | `filesystem.write`, `repository.read` | `--mode accept-edits`, canary R/W | **must pass** or strip write badges |
| `P-agy-text-flush` | `conversation.stream` | multi-line reply | single flushed message via `flushAgentSummary` (no mid-run JSONL) |
| `P-agy-mcp` | `mcp.inventory` | attempt `agy mcp` / help parse | expect **`unsupported`** on 1.1.2 |
| `P-agy-elevated` | elevated | `--dangerously-skip-permissions` only when elevated | flag present in argv build test |

**Adapter touchpoints:** `gemini` definition (`command: 'agy'`); `summarizeAgentEvent` plain-text accumulate; do **not** delete `gemini-adapter.js` until live agy probe suite green (coordination note). Truthfulness: if `P-agy-mode-edit` fails, set write keys to `failed`/`unsupported` and block write role assignment.

---

## 9. Exact adapter & server touchpoints

| Area | File | Change (when implementing) |
|---|---|---|
| Static capabilities → manifest | `src/lib/adapters.js` | Replace string arrays with `declaredCapabilities` + `probeSupport` matrix; keep `build(options)` but accept `toolProfile` |
| Invocation build | `src/lib/adapters.js` `AGENT_DEFINITIONS.*.build` | Apply profile: sandbox, permission-mode, allow/deny, elevated flags |
| Event summarize / cancel safety | `src/lib/adapters.js` `summarizeAgentEvent`, `flushAgentSummary`, `buildAgentInvocation` | Probes reuse same path; per-executionId accumulators preferred long-term |
| Process lifecycle | `src/lib/process-manager.js` | `kind: 'probe'`; command previews already required; optional shorter timeout for probes |
| Verification marking | `src/server.js` `onProcessEvent` / `detectAgents` merge | Update `capabilityProfile` from probe results; stop treating any exit-0 chat as proof of `filesystem.write` |
| API projection | `src/server.js` `projectStateForApi` | Project capability summaries only; never MCP env; cap server name lists |
| Policy | `src/lib/policy.js` | Optional: require `verified` keys for auto-approve write (`verified-agents` becomes capability-aware) |
| Tool profiles | `src/lib/tool-profile.js` **(new)** | Pure mapping room/policy → per-agent flags |
| MCP inventory helpers | `src/lib/mcp-inventory.js` **(new)** | Spawn `codex/claude/grok mcp list`, parse names only |
| UI badges | `public/app.js` | Show confidence; disable assign when required keys missing (PRD US-012) |
| Tests | `test/adapters.test.js`, `test/capability-probes.test.js` **(new)**, projection tests | Fixture CLI stubs; cancel-bleed; preview size; agy unsupported mcp |
| Docs | this file | Living design until implementation PR |

**Do not touch for this design task:** live operator token routes, unleashed semantics (except documenting elevated flag mapping), memory system work.

---

## 10. Phased delivery

### Phase 0 — Prerequisites (done or in-tree)

- [x] Grok cancel bleed fixed (accumulator clear + regression)  
- [x] Execution command previews at create + project  
- [ ] Commit/push those fixes if still only local  
- [ ] Live verify Grok `bypassPermissions` flag name  

### Phase 1 — Truthful profiles (minimal product value)

1. Structured `declared` capabilities in adapter definitions (no behavior change).  
2. `P-detect` + `P-stream` + `P-agy-mcp` → persist `capabilityProfile` with `declared`/`unsupported`/`verified` for stream only.  
3. UI: show “declared” vs “verified” without removing agents.  
4. Tests for projection size of profile objects.

**Exit:** Badges no longer imply proof; agy MCP shows unsupported.

### Phase 2 — Conformance probes + spawn profiles

1. Implement `tool-profile.js` and wire `build()`.  
2. Claude/Grok allow/deny plumbing from profile (defaults = current behavior).  
3. Workspace canary probes for read/write per adapter (`P-*-write`, `P-*-sandbox-ro`).  
4. Names-only MCP inventory probes for codex/claude/grok.  
5. Assignment UI warns on missing `repository.read` / `filesystem.write`.

**Exit:** Write auto-approve can optionally require `filesystem.write: verified`.

### Phase 3 — Control-plane capability broker

1. Structured agent intents (create task, assign, requeue, identity already partially special-cased).  
2. Server validates role + policy + risk; single-use capability grants; audit.  
3. No operator token in child env (pair with punch item 14: strip provider keys).  
4. System ops queue (board reset after quiescence) as broker operations, not fake tasks.

**Exit:** Autopilot autonomy is real for board mutations without token leakage.

### Phase 4 — Optional deep tool visibility

1. Normalize tool-call events from JSONL streams where providers emit them → `tool.approval.events`.  
2. Only then claim per-tool interactive approval in README/UI.  
3. MCP allowlist at spawn if/when each CLI documents stable flags for per-run MCP filtering.

**Exit:** Approvals drawer can show in-run tool requests for adapters that emit them; others remain “whole-run approval.”

---

## 11. Event additions (lean)

New SSE / audit types (all small payloads):

| Type | Payload (max) | Notes |
|---|---|---|
| `capability.probe.started` | `{ agentId, probeId, executionId }` | |
| `capability.probe.finished` | `{ agentId, probeId, keys[], results[], cliVersion }` | no raw stdout |
| `capability.profile.updated` | `{ agentId, probedAt, summary }` | summary = counts by confidence |
| `mcp.inventory.updated` | `{ agentId, serverNames[], truncated? }` | names only, cap N=50 |

Reuse `execution.*` for the underlying process. Probe executions use `previewCommand` like everyone else.

---

## 12. Security notes

- MCP list output may include env keys or URLs with tokens — **parse defensively; persist names + crude status only.**  
- Probes run under the same host as the operator; use workspace canaries under `.conclave/probes/` (gitignored) or a temp dir outside the repo if dirty-tree policy requires it.  
- Unleashed rooms still must not put the session token in child `env`.  
- `danger-full-access` / `bypassPermissions` / `--dangerously-skip-permissions` remain operator-trust features; capability profiles should label them `elevated` not `verified safe`.  
- Do not auto-run write probes on a dirty production workspace without operator opt-in; default probe suite is read-only + MCP list + stream.

---

## 13. Acceptance criteria for the eventual implementation PR

1. Static string badges are gone or clearly labeled `declared`.  
2. Each adapter has a documented probe list (this file §8) with automated tests for the pure mapping and at least stubbed integration tests for stream + MCP unsupported paths.  
3. `/api/state` growth from profiles/MCP names stays well under ~50 KB even with four agents fully probed.  
4. Cancel-bleed and command-preview regressions remain green.  
5. README safety boundary updated only when `tool.approval.events` is real.  
6. Assignment path can explain missing capabilities (PRD US-012).

---

## 14. Open questions (for coordinator / operator)

1. **Probe cadence:** on detect only, on operator button, or TTL auto-refresh? Recommendation: operator “Verify agents” + auto re-probe when `cliVersion` changes.  
2. **Write probes in real workspaces:** opt-in vs dedicated probe worktree. Recommendation: dedicated `.conclave/probes/` canary dir, never touch user files.  
3. **Whether `verified-agents` autopilot requires `filesystem.write: verified`:** Recommendation: yes in gated rooms; unleashed unchanged.  
4. **Codex MCP list currently includes remote servers** — should Conclave display them when auth is “Not logged in”? Recommendation: show name + `auth: required`, never pretend connected.

---

## 15. Summary

| Question | Answer |
|---|---|
| What replaces static badges? | Structured capability profiles with declared/probed/verified/unsupported + real probes |
| Where does Conclave broker? | Control-plane intents, policy, spawn profiles, audit, assignment gates |
| Where does it delegate? | In-run FS/shell/MCP inside each CLI’s sandbox after spawn flags are set |
| Antigravity gap? | No MCP CLI; mark `mcp.*` unsupported; still probe plan/edit modes for honest write claims |
| Payload safety? | Names-only MCP, preview commands, probe summaries, existing execution projection |

This document is the implementation contract for follow-on tasks; it intentionally ships no runtime switch.
