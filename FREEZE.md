# Conclave freeze policy (reference-only)

**Status:** FROZEN as of 2026-07-17  
**Scope:** This repository (`U:\coding_conclave`) — the live Conclave v1 prototype.

## Policy

1. **No new feature work** on legacy Conclave (`src/`, `public/`, `test/` product surface) unless the **operator explicitly reopens** the freeze (message in the room or a COORDINATION handoff that says reopen + scope).
2. This tree is a **behavioral museum and working prototype** — run it, read it, learn from it. Do not renovate it into v2.
3. All greenfield multi-agent product work goes to the **sibling Mansion** project.
4. Docs-only edits here are allowed when they **point agents at the freeze** or **stage design for Mansion** (e.g. `staging/mansion/`, this file, coordination handoffs). Prefer not to grow Conclave app docs further.

## Where to work instead

| Role | Path |
|------|------|
| **Sibling product (build here)** | `U:\mansion` — independent Git repo, scaffold + modules + smoke tests |
| **Design staging still in this repo** | `staging/mansion/CHARTER.md`, `REFERENCE.md`, `ARCHITECTURE.md` |
| **Lessons to port (read-only)** | `staging/mansion/REFERENCE.md` and live code under `src/` for evidence only |

> Note: Room chat sometimes said `U:\coding_mansion`. The scaffold that exists is **`U:\mansion`**. Use that path unless the operator renames/moves it.

## Allowed vs not allowed under freeze

| Allowed without reopen | Not allowed without reopen |
|------------------------|----------------------------|
| Read / run / test the prototype | New features, UI pages, APIs, adapters |
| Bugfix **only** if operator reopens with that scope | “While we’re here” refactors of `server.js` or dual-store memory |
| Coordination/docs that enforce freeze or hand off to Mansion | Expanding capability broker, multi-tenant hardening, etc. |
| Copying **behavioral lessons** into Mansion (not file trees) | Porting `src/server.js` wholesale into Mansion |

## How to reopen

Operator (or room coordinator under operator direction) must:

1. State in the room or prepend a COORDINATION handoff: **reopen freeze**, with **paths** and **objective**.
2. Agents claim those paths with a normal lease before editing.
3. When done, handoff should say whether the freeze is **re-applied** or remains open for a named follow-up.

Silent assumption of reopen is not valid.

## Pointers for agents (start of run)

1. Read this file (`FREEZE.md`) and `COORDINATION.md`.
2. If the task is product work on multi-agent rooms/agents/tasks → **`cd U:\mansion`** (or open that workspace), not this repo’s `src/`.
3. If the task is “learn what Conclave did” → read `staging/mansion/REFERENCE.md`, then code under `src/` as evidence only.
4. Follow [AGENTS.md](AGENTS.md) for leases/handoffs when editing *this* workspace.

## Verify freeze is still intact

```powershell
# From U:\coding_conclave
Test-Path FREEZE.md
git status
git log --oneline -5
# Expect no feature commits on src/ unless operator reopened.
```

Sibling (where active work belongs):

```powershell
cd U:\mansion
npm test
npm run smoke
```
