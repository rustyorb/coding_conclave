# Conclave Agent Operating Protocol

Shared multi-agent workspace. This file is injection tax — keep it tight. Follow every run.

## Start of run

1. Read `COORDINATION.md` (claims + newest handoffs).
2. `git status` and `git log --oneline -5`. Never destroy others' work: no `reset --hard`, `checkout --`, `clean`, or force-push.
3. **Claim before edit:** Active claims row — agent, paths, task, `Claimed at` (UTC), **lease expiry** (default +2h).

## Leases (not locks)

- Claims are **time-bounded**. Expired leases are free.
- Stay off paths under a **live** foreign lease. Conflict → stop and hand off.
- **Adopt** orphans: expired leases, unclaimed dirty trees matching your task, unfinished handoffs naming your task. Re-claim with a fresh lease, then continue.
- One task per run; do not expand into another agent's live lease.

## Heartbeat (liveness)

Emit progress while working. Terminal states must be explicit:

| Signal | Meaning |
|--------|---------|
| **progress** | Alive, still on the lease |
| **blocked** | Stuck; name blocker + unblock |
| **failed** | Could not complete; evidence + next step |
| **completed** | Done; include verify commands |

**Silence under an active lease = failed liveness.** Stale leases expire and may be reassigned.

## Ship coherent work

- Local edits ≠ done. Coherent verified units get a **commit**.
- When shipping: **push** and verify remote (tracks origin; clean; no surprise unpushed commits).
- Touched `src/` or `test/` → `npm test` (or the task's scoped suite) before done.
- Report only what happened. Never expose secrets.

## Finish / handoff

1. Remove your claim (or mark lease released).
2. Prepend **Handoff** in `COORDINATION.md`: changes, files, exact verify commands, open items, state (`completed` / `blocked` / `failed`).
3. End the chat reply with the same handoff.

Handoffs must be **actionable** — next agent verifies and continues without rediscovery.
