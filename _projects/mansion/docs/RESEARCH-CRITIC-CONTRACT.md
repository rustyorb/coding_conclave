# Research / Critic Loop Contract

**Status:** adopt-ready contract (phase 0 companion)  
**Date:** 2026-07-17  
**Default search backend:** SearXNG (`createSearxngClient` → LAN `http://192.168.0.177:8888`)  
**Active code:** `U:\mansion` (`docs/RESEARCH-CRITIC-CONTRACT.md` + `src/modules/research/contract.js`)  
**Companions:** [CHARTER.md](CHARTER.md) §2–4 · [ARCHITECTURE.md](ARCHITECTURE.md) EventLog · `src/modules/research/`  
**Non-goal:** no workflow DSL, no competing kernel redesign, no second source of truth

This file is the **design-record copy** inside Conclave’s `_projects/mansion/docs/`. The implementation and tests live in the sibling product repo `U:\mansion`.

---

## 1. What this is (and is not)

| Is | Is not |
|----|--------|
| A **data + event contract** for search evidence | A state machine language or plan DSL |
| **Provenance envelopes** that claims and critiques reference | A memory / RAG subsystem |
| Suggested **EventLog event types** and payloads | A new bounded context that owns policy or spawn |
| Thin **pure helpers** architecture can import | An orchestrator that runs multi-step agent graphs |

Research and critic remain ordinary agent **turns** (Conversation chat turns or Work task runs). Search is a **side effect** of those turns, not a separate workflow engine.

---

## 2. Roles (plain English)

### Research turn

1. Form one or more search **queries** from the task or chat prompt.
2. Call the **search backend** (`SearchBackend.search` — default SearXNG).
3. On completion (ok or failed), build a **search record** and append it to the EventLog **before** citing results as evidence.
4. Optionally emit **claims**: short statements, each either:
   - **cited** — every factual assertion that depends on the web is backed by one or more citation ids from that (or a prior) search record; or
   - **uncited-reasoning** — analysis, synthesis, or opinion that does not assert an external fact as retrieved.

### Critic turn

1. Read the claims (and their citation ids) under review — from the task, handoff, or prior events.
2. For each claim, resolve citations against recorded provenance (same room, via correlation / search record ids).
3. Emit **findings**: `supported` | `unsupported` | `needs-search` | `partial`, with free-text rationale. Critic may request additional search by stating `needs-search` + suggested queries; it does **not** invent a mini-language for loops.

There is **no prescribed ping-pong depth**. A room may run research alone, critic alone, or alternate turns under normal Work / Conversation commands. The contract only constrains **evidence shape** and **record landing**.

---

## 3. Search call

### Backend interface

```ts
// Conceptual — JSDoc in research/contract.js
interface SearchBackend {
  search(query: string, opts?: SearchOpts): Promise<ResearchSearchResult>;
}
```

- **Default implementation:** `createSearxngClient()` / `defaultSearxngClient()` in `U:\mansion\src\modules\research\index.js`.
- **Config:** `baseUrl` option or `MANSION_SEARXNG_URL`; default `http://192.168.0.177:8888`.
- **No secrets** in client or event payloads. Network failures return structured `ResearchSearchResult` (`ok: false`, `error` code) — they do not throw for offline/timeout.

### When to call

| Context | Allowed? | Notes |
|---------|----------|--------|
| Research agent on a board task | Yes | Preferred path; results land as domain events |
| Critic agent needing more evidence | Yes | Prefer stating `needs-search` first; may call search if the run is authorized |
| Chat-only turn | Yes (read-only) | Results still go to EventLog; chat shows short human notice only |
| Hard-gated out-of-workspace / secrets | N/A | Search is outbound HTTP to configured SearXNG; not a workspace mutation |

HardGates / Authority do **not** gate routine LAN SearXNG queries under trusted-local. If a future backend requires API keys, secrets stay in process env and never enter event payloads (charter §4.4 redaction).

---

## 4. Provenance and citation

### Citation unit

Each usable hit from a completed search becomes a **citation** with a stable id **scoped to that search record** (not globally unique forever — correlate via `searchId` + `citationId`).

| Field | Meaning |
|-------|---------|
| `citationId` | Short id within the search (`c1`, `c2`, …) |
| `searchId` | Id of the search record that produced the hit |
| `url` | Source URL (required; empty URLs never become citations) |
| `title` | Page title |
| `snippet` | Snippet / content excerpt from the backend |
| `engine` / `engines` | Responding engine(s) |
| `query` | Query string that retrieved this hit |
| `retrievedAt` | ISO time when the search completed |
| `backend` | Always `"searxng"` for the default client (other backends may set their name later) |
| `baseUrl` | Backend base URL used (not a secret) |

### Claim unit

| Field | Meaning |
|-------|---------|
| `claimId` | Stable within the claims batch |
| `text` | The claim statement |
| `kind` | `cited` \| `uncited-reasoning` |
| `citationRefs` | List of `{ searchId, citationId }` — required non-empty when `kind === 'cited'` |
| `confidence` | Optional: `high` \| `medium` \| `low` |

### Inline markers (chat / handoff text)

Human-facing prose may use markers **`[c1]`**, **`[c2]`**, … matching `citationId`s from an explicit search record referenced in the same message or event correlation. Markers are display sugar; the **record** is the structured citation list, not the free text.

### Invariants

1. **No invented provenance.** A `cited` claim must only reference citation ids that exist on a prior (or same-batch) `research.search.completed` record in the room. Builders reject dangling refs; architecture should refuse to append invalid claim events.
2. **Failed search is evidence of failure, not of empty web.** `research.search.failed` lands with `error` / `errorMessage`; claims must not treat a failed search as “no sources found, therefore false.”
3. **Snippets are not full documents.** Citations carry what the backend returned; deeper fetch/read of a URL is a separate future concern and must mint its own provenance if used.
4. **Redact before persist.** No cookies, tokens, or Authorization headers in payloads.

---

## 5. Landing on the record (EventLog)

Cross-boundary effects travel as **append-only domain events** (ARCHITECTURE §3 / EventLog). Research does not own a parallel store.

### Suggested event types

| Type | When | Payload essence |
|------|------|-----------------|
| `research.search.completed` | Backend returned `ok: true` | `searchId`, query, backend, baseUrl, tookMs, citations[], raw hit count, correlation |
| `research.search.failed` | Backend returned `ok: false` | `searchId`, query, backend, baseUrl, error, errorMessage, status, tookMs, correlation |
| `research.claims.recorded` | Research turn asserts claims | `batchId`, claims[], correlation (taskId / turnId / searchIds) |
| `critic.review.recorded` | Critic finishes a review | `reviewId`, subject (claim batch or task id), findings[], correlation |

### Correlation (required habit, not a DSL)

Every research/critic event SHOULD carry correlation ids so lineage is replayable:

```text
roomId (EventLog stamp)
actor: { kind: 'agent', id: agentId }
correlation: {
  taskId?, turnId?, executionId?,
  searchIds?: string[],
  claimsBatchId?, reviewId?
}
```

### Chat vs record

- **EventLog** = system of truth for searches, citations, claims, findings.
- **Chat lane** = short human-readable notices (e.g. “Searched X — 5 hits” or “3 claims, 2 supported”). Do **not** dump full JSON result arrays into chat (ARCHITECTURE messages-vs-events rule).

### Projection (optional later)

A read model such as `research_searches` / `research_citations` may be projected from these events. Until then, consumers may list events by type. Projection ownership would sit with EventLog projections or a thin research read helper — **not** a dual-write SoT.

---

## 6. Critic findings shape

| Field | Meaning |
|-------|---------|
| `findingId` | Stable within the review |
| `claimId` | Claim under review (or null for holistic notes) |
| `verdict` | `supported` \| `unsupported` \| `partial` \| `needs-search` |
| `rationale` | Why |
| `usedCitationRefs` | Citations the critic actually checked |
| `suggestedQueries` | If `needs-search`, optional strings for a follow-up research turn |

Critic **does not** mutate claims in place. Corrections are new events (append-only).

---

## 7. Module placement

| Piece | Path | Owns |
|-------|------|------|
| SearXNG client | `U:\mansion\src\modules\research\index.js` | HTTP JSON search |
| Contract builders + types | `U:\mansion\src\modules\research\contract.js` | Pure provenance / event payload builders |
| This document | `docs/RESEARCH-CRITIC-CONTRACT.md` (both repos) | Normative contract |
| EventLog append | existing `eventlog` + host/services | Persistence / `seq` |
| When to run research vs critic | Work + Conversation + operator | Task assignment — **not** this module |

Architecture adoption checklist:

1. Import builders; do not re-encode provenance ad hoc in adapters.
2. After `client.search(...)`, call `buildSearchRecord` → append `research.search.*`.
3. Before publishing cited claims, `validateClaimCitations`.
4. Critic turns call `buildCriticReview` → append `critic.review.recorded`.
5. Leave workflow order to the operator and board — no built-in loop runner here.

---

## 8. Explicit non-goals

- No multi-step “research graph” or YAML workflow language.
- No automatic infinite research↔critic loops.
- No embedding index / memory write path (memory remains deferred; when added it must be provenance-bearing per CHARTER).
- No competing Runtime / EventLog redesign.
- No requirement that every agent turn search the web.

---

## 9. Verify

```powershell
cd U:\mansion
npm test
# Contract unit tests: research-contract.test.js
# Client tests: research-searxng.test.js
Test-Path docs\RESEARCH-CRITIC-CONTRACT.md
```

**One-line export:** research calls SearXNG, cites only recorded hits, critic scores claims against that provenance, and everything lands as append-only EventLog events — no DSL, no second store.
