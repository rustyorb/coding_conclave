# Mansion Memory Subsystem — Design

**Status:** design proposal (requirements-level ADR; no implementation scheduled — see §10 C-M1)
**Date:** 2026-07-17
**Companions:** [CHARTER.md](CHARTER.md) §2–4 · [ARCHITECTURE.md](ARCHITECTURE.md) (EventLog, store slices) · [LIVING-ROOM-BRIEF.md](LIVING-ROOM-BRIEF.md) §3–4 (attachments) · [V1-LESSONS.md](V1-LESSONS.md) (dual-store scar)
**Autopsied:** `github.com/rustyorb/meminimus` @ `master` (`antigravity-memory`, 545-line MCP server) — §3
**Non-goal:** no memory framework adoption, no external services, no second source of truth, no auto-extraction pipeline day-1

This file is the design-record copy inside Conclave's `_projects/mansion/docs/`. Any implementation
lands in the sibling product repo `U:\mansion` — and only after the coordinator schedules it (§10).

---

## 1. What memory is in the Mansion

Memory is the room's accumulated, queryable knowledge: durable facts about the project, the
operator, the agents, and past work — surviving process restarts and session resets, retrievable
in small, relevant, provenance-bearing slices instead of by replaying the whole event log.

The charter constrains the shape before any schema is drawn (CHARTER §2 non-goals):

> memory, when it comes, enters as a **provenance-bearing read model — not a second source of truth**.

That sentence is the architecture. Concretely:

1. **The EventLog remains the single source of truth.** Every memory mutation is first a domain
   event (`memory.fact.stored`, `memory.fact.invalidated`, …). The memory tables are
   **projections** of those events, the same way `tasks` or `approvals` are.
2. **Memory is rebuildable.** Dropping every `memory_*` table and re-projecting from the event
   log loses nothing but cached embeddings (recomputed) and access counters (advisory). This is
   the test that memory has not become a second SoT — and it is a day-1 test (§11).
3. **Every fact knows where it came from.** Agent, room, event `seq`, and optionally chat turn,
   task, and attachment. A fact that cannot cite its origin does not get stored.
4. **Nothing is ever deleted.** Facts are invalidated with a timestamp and a reason, exactly as
   Conclave's approvals expire rather than vanish. History stays queryable.

### Why SQLite, not a framework

The room already reviewed the landscape (Mem0, Zep/Graphiti, Letta, Cognee, LangMem). Two results
drive the decision:

- **Reliable retrieval beats tool sophistication.** Letta's plain-filesystem agents scored 74% on
  LoCoMo, beating Mem0's specialized memory tools at 68.5%. The heavyweight frameworks buy
  ingest pipelines and managed infrastructure, not retrieval quality we can't get locally.
- **The semantics worth having are Graphiti's, and they are a schema, not a dependency.**
  Bi-temporal validity, invalidate-don't-delete, provenance on every fact (Zep beats Mem0 by ~15
  points on LongMemEval on the strength of exactly these). We steal the semantics wholesale and
  skip the Python sidecar — every heavyweight option is a Python service, which is the wrong
  bolt-on for a Node kernel.

So: **one SQLite file, FTS5 for keyword search, a nullable embedding column for semantic search,
zero external services.** The mansion already runs on Node's built-in `node:sqlite` for its
event-sourced store; memory uses the same engine and (proposed, §10 C-M2) the same database file.

---

## 2. Scope

**In scope (this design):** fact storage, bi-temporal validity, invalidation/supersession,
provenance, room-scoped hybrid retrieval under a token budget, attachment anchoring for
living-room uploads, a minimal store/query/invalidate API, event-log integration.

**Out of scope day-1 (deferred until earned, per CHARTER §2):** automatic fact extraction from
chat/runs, summarization/consolidation pipelines, cross-room memory sharing, an MCP surface for
external agents (meminimus proves the shape is easy to add later — §3), community/cluster
detection, at-rest encryption (§3, deliberate divergence).

---

## 3. Meminimus autopsy

`rustyorb/meminimus` is a single-file (~545 lines) MCP stdio server: an in-memory JS object graph
of typed memory nodes and labeled edges, JSON-serialized and AES-256-GCM-encrypted to two files
on every write. 4 commits, no tests, no schema migrations, one open PR. It is a seed, not a
foundation — but it is the right language (Node) and it independently arrived at several of the
same semantics Graphiti did. What survives the autopsy:

### Salvaged (semantics and vocabulary)

| Meminimus piece | Evidence | Becomes in Mansion |
|-----------------|----------|--------------------|
| **Deprecate, never delete** — `forget` sets `deprecated`, `deprecatedAt`, `deprecationReason`; no delete op exists | `index.js:291-302` | The invalidation model (§4): boolean `deprecated` upgraded to bi-temporal `valid_until` + `invalidated_at` + reason |
| **Evolution preserves history** — `evolve` pushes `{previousContent, changedAt, reason}` before overwriting | `index.js:236-254` | `supersede()` (§8): new fact row + old fact invalidated with `superseded_by` link — history as rows, not embedded arrays |
| **Typed memories** — `entity \| episode \| knowledge \| procedure \| reflection` | `index.js:358` | The `kind` column, same five values (§4). The vocabulary maps cleanly: episode = something that happened in the room, procedure = "when X, do Y", reflection = an agent's own synthesis |
| **Labeled edge vocabulary** — `relates_to, derived_from, contradicts, evolved_into, belongs_to, informed_by` | `index.js:263-266` | `memory_links.rel`, same six values (§4). `contradicts` and `evolved_into` are precisely the Graphiti invalidation/supersession lens, discovered independently |
| **Salience + access tracking** — salience 0–1, `lastAccessed`, `accessCount`; recall sorts salience-then-recency | `index.js:123-196` | Ranking inputs (§6). Access metadata kept, but updated off the read path (see scars) |
| **`reflect` = match + 1-hop traversal** — direct hits plus their graph neighbors | `index.js:200-232` | The optional 1-hop link expansion in `query()` when token budget remains (§6) |
| **MCP-compatible surface** — six tools over stdio | `index.js:347-441` | Not day-1, but proof the store/query/invalidate API re-exposes as a thin MCP adapter later with no redesign |

### Rejected (mechanics — designed out, not fixed)

| Scar | Evidence | Why it dies |
|------|----------|-------------|
| **Full-store rewrite on every operation** — `save()` re-encrypts and rewrites both entire files; called from `remember`, `evolve`, `connect`, `forget`, **and `recall`** | `index.js:114-119`, `189` | O(n) write amplification per op; no atomic rename or fsync, so a crash mid-`save` corrupts the entire store. SQLite's WAL replaces all of it |
| **Reads mutate state** — `recall` updates access metadata then rewrites the store | `index.js:183-189` | A query must never be a write on the hot path. Access counters become an async, batched, advisory update (§6) |
| **Substring-only search** — `content.toLowerCase().includes(q)` | `index.js:167-175` | No ranking, no stemming, no phrase queries, no semantic recall. FTS5 (BM25) + embedding column replace it |
| **Whole graph in process memory** | `index.js:60-91` | No scale story; SQLite pages instead |
| **Encryption with the key beside the data** — `.key` in the same directory as the `.enc` files | `index.js:20`, `26-37` | In meminimus's threat model (memory files pushed to public GitHub) this made sense. In the Mansion's trusted-local model (CHARTER §4) it inverts: the perimeter is trusted, the operator must be able to inspect their own system's memory, and a lost key bricks the store (Conclave's per-boot-token trap, again). **Deliberate divergence: no at-rest encryption. Secret-safety is redaction-before-persist plus the `secrets` hard gate** |
| **Provenance is one free-text `source` field** | `index.js:123`, `362` | Structured provenance (agent, room, seq, turn, task, attachment) is the point of this design |
| **Temporality is `created`/`lastAccessed` only** | `index.js:127-138` | No valid-time axis at all; a fact that stops being true can only be deprecated wholesale. Bi-temporal columns replace it |
| **No tests, no migrations, singleton globals** | repo-wide | Mansion modules are pure, injected, and tested from day 1 |

---

## 4. Data model

Proposed tables (owner: the Memory module — placement flagged in §10 C-M3). SQL is illustrative;
the binding contract is the columns and their semantics.

```sql
CREATE TABLE memory_facts (
  fact_id             TEXT PRIMARY KEY,     -- uuid
  room_id             TEXT NOT NULL,        -- retrieval is room-scoped (§6)
  kind                TEXT NOT NULL
    CHECK (kind IN ('entity','episode','knowledge','procedure','reflection')),
  content             TEXT NOT NULL,        -- prose statement of the fact; REDACTED BEFORE INSERT
  salience            REAL NOT NULL DEFAULT 0.5,   -- 0..1

  -- bi-temporal axes (Graphiti semantics)
  valid_from          TEXT NOT NULL,        -- world time: when the fact became true
  valid_until         TEXT,                 -- world time: when it stopped; NULL = still true
  recorded_at         TEXT NOT NULL,        -- ingest time: when the room learned it
  invalidated_at      TEXT,                 -- ingest time: when the room learned it no longer holds
  invalidation_reason TEXT,                 -- required when invalidated (invalidate-don't-delete)
  superseded_by       TEXT REFERENCES memory_facts(fact_id),  -- set when replaced, not just retracted

  -- provenance (a fact that cannot cite its origin is not stored)
  source_agent        TEXT NOT NULL,        -- 'operator' | agent id | 'system'
  source_seq          INTEGER NOT NULL,     -- EventLog seq of the originating event (the anchor)
  turn_id             TEXT,                 -- chat turn / message, when conversational
  task_id             TEXT,                 -- board task, when work-derived
  attachment_id       TEXT,                 -- living-room upload, when attachment-derived (§7)

  -- retrieval metadata (advisory; rebuildable)
  embedding           BLOB,                 -- float32[] little-endian; NULL until computed
  embedding_model     TEXT,                 -- pinned model id; mixed-model rows never compared
  last_accessed       TEXT,
  access_count        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_facts_room_current
  ON memory_facts (room_id, valid_until, invalidated_at);

-- keyword search: external-content FTS5 table synced by triggers on memory_facts
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content, content='memory_facts', content_rowid='rowid'
);

CREATE TABLE memory_links (
  source_fact TEXT NOT NULL REFERENCES memory_facts(fact_id),
  target_fact TEXT NOT NULL REFERENCES memory_facts(fact_id),
  rel         TEXT NOT NULL
    CHECK (rel IN ('relates_to','derived_from','contradicts',
                   'evolved_into','belongs_to','informed_by')),
  created_at  TEXT NOT NULL,
  source_seq  INTEGER NOT NULL,             -- links carry provenance too
  PRIMARY KEY (source_fact, target_fact, rel)
);

CREATE TABLE memory_attachments (            -- anchor records, not blobs (§7)
  attachment_id TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL,
  message_id    TEXT,                        -- living-room message it arrived on
  source_seq    INTEGER NOT NULL,            -- EventLog anchor of the upload event
  filename      TEXT NOT NULL,
  mime          TEXT,
  bytes         INTEGER,
  content_hash  TEXT NOT NULL,               -- sha256 of blob content
  stored_path   TEXT NOT NULL,               -- where the blob actually lives (owned elsewhere)
  created_at    TEXT NOT NULL
);
```

### Bi-temporality, spelled out

Two independent time axes, because "when was it true" and "when did we know" are different
questions (this is the Graphiti steal, and it is what the room's flat files could not do):

| Axis | Columns | Question answered |
|------|---------|-------------------|
| **Valid time** (world) | `valid_from` / `valid_until` | "What port does the dev server use *now*?" / "…as of last Tuesday?" |
| **Ingest time** (room) | `recorded_at` / `invalidated_at` | "What did the room believe on July 10, before Grok corrected it?" |

Rules:

1. **A fact is *current*** iff `valid_until IS NULL AND invalidated_at IS NULL`. Default
   retrieval returns only current facts.
2. **Invalidation is the only retraction.** `invalidate()` sets `valid_until` (world time it
   stopped being true, defaulting to now), `invalidated_at` (now), and a required reason. The
   row stays; history queries still see it. There is no delete in the API. (Meminimus's
   "forgetting is a choice, not erasure," made temporal.)
3. **Supersession is invalidation plus a pointer.** When a fact is *replaced* — "the port is
   4317" → "the port is 5000" — `supersede()` stores the new fact, invalidates the old one with
   `superseded_by = new.fact_id`, and adds an `evolved_into` link. The old content is not
   rewritten (meminimus's `evolve` history, normalized into rows).
4. **Corrections are supersessions with `valid_from` in the past.** If the room learns it
   believed something false, the correcting fact's `valid_from` backdates to when reality
   changed; `recorded_at` stays honest about when the room caught up. The two axes never lie to
   cover for each other.
5. **`valid_from` defaults to `recorded_at`** when the caller states no world time.

### Embeddings

- Nullable by design. **FTS5/BM25 is the day-1 retrieval path**; rows work with `embedding IS
  NULL` forever. Semantic search is an enhancement, not a dependency.
- When enabled: one local model (e.g. an ONNX MiniLM via `transformers.js` or `fastembed`), run
  in-process — **no external embedding service**. The model id is pinned per row in
  `embedding_model`; rows embedded by different models are never compared (vector spaces are not
  interchangeable), and a model change means a background re-embed, not a silent mix.
- Vectors are compared by brute-force cosine over the room-scoped candidate set in JS. At
  single-operator room scale (thousands of facts, not millions) this is milliseconds and needs
  no native vector extension. If scale ever demands `sqlite-vec`, the column format already fits.
- Lost embeddings are a non-event: they are cache, recomputed from `content` (§1 rebuildability).

---

## 5. Event-log integration (read-model discipline)

Every memory mutation flows through the same one-write-transaction-per-command path as every
other module (ARCHITECTURE §3.1):

| Command | Domain event | Projection effect |
|---------|--------------|-------------------|
| `store()` | `memory.fact.stored` (payload: full fact incl. provenance) | INSERT into `memory_facts` (+FTS) |
| `invalidate()` | `memory.fact.invalidated` (payload: fact_id, valid_until, reason, superseded_by?) | UPDATE the row's temporal columns |
| `supersede()` | `memory.fact.stored` + `memory.fact.invalidated` + `memory.link.added` | INSERT + UPDATE + link INSERT |
| `link()` | `memory.link.added` | INSERT into `memory_links` |
| `anchorAttachment()` | `memory.attachment.anchored` | INSERT into `memory_attachments` |

Notes:

- **The UPDATE does not violate append-only.** The append-only guarantee (CHARTER §4.4) binds
  the *event log*; `memory_facts` is a projection, and projections replay. Re-projecting from
  seq 0 reproduces the tables exactly (minus embedding/access caches). Explicitly flagged for
  review anyway — §10 C-M5.
- **Redaction before persist** (CHARTER §4.4) applies to fact content and event payloads alike:
  the same redactor Runtime uses on streamed output runs on `content` before either the event or
  the row is written. Secrets never become facts.
- **Queries emit no events.** Reads are reads. `last_accessed`/`access_count` updates are
  batched, asynchronous, advisory, and excluded from the event log — they are ranking hints, not
  history (designing out the meminimus read-that-writes scar).
- **Correlation:** memory events carry `taskId`/`turnId` in the existing correlation envelope
  where applicable; `factId`/`attachmentId` ride in the payload unless Codex's envelope grows
  fields for them (§10 C-M4).

---

## 6. Retrieval: room-scoped, budgeted, hybrid

The retrieval contract in one sentence: **give me the most relevant current facts for this room,
as prose with provenance, costing at most N tokens.**

```
query({
  roomId,                  // required — retrieval never crosses rooms
  text,                    // the question / topic
  tokenBudget,             // required — hard cap on returned content size
  kinds?,                  // filter: ['procedure','knowledge',...]
  asOf?,                   // time-travel: world-time instant (default: now)
  believedAt?,             // time-travel: ingest-time instant (default: now)
  includeInvalidated?,     // default false
  expandLinks?,            // default true: 1-hop neighbors if budget remains
  limit?                   // candidate cap before packing (default 50)
})
→ { facts: PackedFact[], spentTokens, candidatesConsidered, truncated }
```

**Pipeline:**

1. **Scope.** `room_id = ?` always. Temporal filter from `asOf`/`believedAt`:
   `valid_from <= asOf AND (valid_until IS NULL OR valid_until > asOf)`, and
   `recorded_at <= believedAt AND (invalidated_at IS NULL OR invalidated_at > believedAt)`.
   Defaults reduce to "current facts only."
2. **Candidates, two ways.** (a) FTS5 MATCH with BM25 rank; (b) if the store has embeddings and
   an embedder is configured, cosine over the scoped set. Union, dedupe by `fact_id`.
3. **Score.** Weighted blend — normalized BM25 + cosine (when present) + `salience` + recency
   decay on `recorded_at` (+ small `access_count` prior). Exact weights are an implementation
   tunable; the contract is the *inputs*, all of which the schema carries.
4. **Pack under budget.** Greedy by score; facts are packed **whole or not at all** (estimate
   ~4 chars/token). Each packed fact renders as prose plus a provenance line:
   `— stored by grok (seq 4412, task_7019ff5b, 2026-07-17)`, and carries `attachment_id` anchors
   for the UI (§7). `truncated: true` signals more relevant facts existed than budget allowed.
5. **Expand, if room remains.** With leftover budget and `expandLinks`, pull 1-hop
   `memory_links` neighbors of packed facts (meminimus `reflect`), scored and packed the same
   way, marked `via: 'link'`.
6. **Empty-result fallback.** Zero candidates → retry once with widened scope (drop `kinds`,
   relax to OR-of-terms). Still zero → return empty, honestly. Never fabricate.

**Callers:** the host injecting a memory slice into an agent's generated system prompt
(ARCHITECTURE §6 "prompt injection tax" — the token budget exists precisely so this injection has
a fixed, small ceiling), agents answering with citations, the living-room UI showing "what the
room knows about X." All get the same function; nobody gets an unbudgeted dump.

---

## 7. Attachment anchoring (living-room uploads)

The living room makes attachments first-class chat citizens (LIVING-ROOM-BRIEF §3–4): staged in a
tray, bound into the EventLog on send, referenced inline via `@name`. Memory's job is to make
facts *about* those uploads durable and traceable — not to become a blob store.

- **On upload**, the owning module (Conversation/Workspace — ownership flagged, §10 C-M6) stores
  the blob and appends the upload event. Memory's `anchorAttachment()` records the anchor row:
  filename, mime, size, `content_hash` (sha256), `stored_path`, `message_id`, `source_seq`.
- **Facts reference, blobs stay put.** A fact derived from an upload — "the schema diagram
  `@mansion-erd.png` defines the seven store slices" — carries `attachment_id`. Fact `content`
  is always prose *about* the attachment; binary content is never inlined into facts or events.
- **The hash is the identity.** If the file at `stored_path` is later moved or edited, the
  anchor's `content_hash` still identifies exactly what the room saw when the fact was formed —
  provenance that survives workspace churn. Re-uploading identical bytes can dedupe to the same
  hash.
- **Retrieval round-trips to the UI.** A packed fact's `attachment_id` lets the living room
  render the chip/lightbox link beside the fact, mirroring the brief's `@`-reference anchoring
  (§4) — click the citation, see the artifact.
- **Invalidation semantics apply unchanged**: an upload superseded by a newer version invalidates
  dependent facts via `supersede()`; the old anchor and old facts remain for history queries.

---

## 8. API (minimal, complete)

Domain command/query interface, ARCHITECTURE §4 conventions (types conceptual; not HTTP routes).
Six calls; the first three are the subsystem.

```ts
// ── core ─────────────────────────────────────────────────────────────────────
store(input: {
  roomId: string;
  kind: 'entity' | 'episode' | 'knowledge' | 'procedure' | 'reflection';
  content: string;                    // redacted before persist
  provenance: {
    agent: string;                    // 'operator' | agent id | 'system'
    seq: number;                      // originating EventLog seq — required
    turnId?: string;
    taskId?: string;
    attachmentId?: string;
  };
  salience?: number;                  // 0..1, default 0.5
  validFrom?: string;                 // default: now (recorded_at)
  links?: Array<{ targetFactId: string; rel: LinkRel }>;
}): Fact

query(input: QueryInput): QueryResult          // §6 — read-only, budgeted, room-scoped

invalidate(input: {
  factId: string;
  reason: string;                     // required — invalidate-don't-delete
  validUntil?: string;                // world time it stopped being true; default now
  supersededBy?: string;              // when a replacement fact exists
}): Fact

// ── conveniences (compose the core) ──────────────────────────────────────────
supersede(input: { factId: string; replacement: Omit<StoreInput,'roomId'>; reason: string })
  : { old: Fact; new: Fact }          // store + invalidate + evolved_into link, one transaction

link(sourceFactId: string, targetFactId: string, rel:
  'relates_to' | 'derived_from' | 'contradicts' |
  'evolved_into' | 'belongs_to' | 'informed_by',
  provenance: { seq: number }): Link

anchorAttachment(input: {
  roomId: string; messageId?: string; seq: number;
  filename: string; mime?: string; bytes?: number;
  contentHash: string; storedPath: string;
}): AttachmentAnchor
```

**Deliberate absences:** no `delete` (invalidate is the only retraction); no `update`/`evolve`
mutating content in place (supersede replaces; history stays); no unscoped or unbudgeted query
shape; no bulk import (facts enter one provenance-bearing event at a time); no auto-extraction
hook (day-1 writes are explicit calls by agents/operator — e.g. a `/remember` slash command in
the living room — because CHARTER §2 defers memory *pipelines* until earned, and an explicit
write path is how the schema earns trust before extraction automates it).

---

## 9. What this deliberately does not build

| Not built | Why |
|-----------|-----|
| External services (vector DBs, embedding APIs, Python sidecars) | One SQLite file, in-process; the room's whole review pointed here |
| At-rest encryption | Trusted-local charter; operator inspectability; no key-loss bricking (§3) |
| Auto-extraction from chat/runs | Deferred until the explicit write path proves the schema (CHARTER §2) |
| Summarization / consolidation pipeline | Invalidate-don't-delete keeps the store honest first; consolidation is a later, evidence-driven add |
| Cross-room / cross-instance memory | Room-scoped by contract; sharing is a future charter question, not a column |
| Graph community detection, multi-hop traversal engines | 1-hop link expansion covers the observed need; deeper traversal is speculative |
| MCP server surface | Later thin adapter over this API if/when external agents need it (meminimus shape) |

---

## 10. Conflicts flagged for Codex review (not resolved here)

Per room protocol these are surfaced for the coordinator/architecture review, **not** decided
unilaterally by this doc:

- **C-M1 — Phase scheduling.** ARCHITECTURE §2 lists "Memory / summary pipeline" as an
  intentional phase-0 **non-module** ("re-implement only when needed; ADR requirements, not
  code"), and BUILD-PLAN M1–M3 contain no memory milestone. This doc is exactly that
  requirements-level ADR — but *when* memory becomes a milestone is Codex's call. No
  implementation should start from this doc alone.
- **C-M2 — Physical store placement.** ARCHITECTURE §1 rule 2: "One durable store + append-only
  event log. No dual JSON/SQLite SoT." Proposal: the `memory_*` tables live **in the same SQLite
  file** as the event log, as projections — no second store. Alternative (separate
  `memory.db` as a disposable projection cache) is defensible but smells like Conclave's dual-store
  scar (V1-LESSONS). Codex's kernel/outbox blueprint owns store layout; needs their sign-off.
- **C-M3 — Module ownership.** ARCHITECTURE §2 has no Memory module, and Coordination explicitly
  does *not* own "embeddings/memory." Options: (a) a new `Memory` bounded context alongside the
  eleven; (b) memory as a projection family inside EventLog with a service API. This doc assumes
  (a) for naming but the blueprint under adversarial review may reshape it.
- **C-M4 — Event envelope.** The `DomainEvent.correlation` shape (ARCHITECTURE §4.9) has
  `taskId | executionId | approvalId` only. Memory events want `factId`/`attachmentId`
  correlation. Payload-carried ids work day-1; envelope growth is Codex's namespace to rule on.
- **C-M5 — Projection UPDATE vs append-only instincts.** Invalidation UPDATEs a projection row
  (`valid_until`, `invalidated_at`). The event log stays append-only and replay reproduces the
  table, so the charter guarantee holds — but anyone reading "events are never updated or
  deleted" (CHARTER §4.4) deserves this called out explicitly rather than discovered in review.
- **C-M6 — Attachment blob ownership.** LIVING-ROOM-BRIEF binds uploads into "the room's
  EventLog record and conversation stream" but no module currently owns attachment blobs.
  Proposal: Conversation (or Workspace) owns blob + upload record; Memory owns only anchor rows
  (§7). Needs an owner in the architecture doc either way.

---

## 11. Day-1 tests (when scheduled)

Domain-first, no HTTP, matching ARCHITECTURE §9 style:

1. **Rebuild-from-log** — store/invalidate/supersede a mixed history; drop `memory_*`; replay
   events; tables match (embeddings/access counters exempt). *The read-model guarantee.*
2. **Invalidate-don't-delete** — invalidated fact absent from default query; present with
   `includeInvalidated`/historical `asOf`; row count never decreases; no delete path exists.
3. **Bi-temporal time travel** — a fact superseded with backdated `valid_from`: `asOf` last week
   returns the old truth; `believedAt` before the correction returns what the room *believed*;
   the axes answer differently and correctly.
4. **Supersession chain** — supersede twice; walking `superseded_by`/`evolved_into` reproduces
   full history with reasons; exactly one current fact remains.
5. **Room scoping** — facts in room B never surface for room A, under every query shape.
6. **Token budget honored** — budget of N: packed facts' estimated tokens ≤ N; facts whole,
   never clipped mid-content; `truncated` set iff candidates were dropped for budget.
7. **Redaction before persist** — a `content` containing a planted secret pattern lands redacted
   in both the event payload and the row; FTS cannot find the raw secret.
8. **Provenance required** — `store()` without `provenance.seq`/`agent` throws; every persisted
   fact joins back to a real event.
9. **Attachment anchoring** — fact with `attachment_id` round-trips hash + `message_id`; blob
   content appears nowhere in fact/event.
10. **FTS5 availability** — the bundled `node:sqlite` build actually has FTS5 compiled in
    (assert at module init, fail loud) — an assumption this doc refuses to bake in silently.
11. **Reads don't write** — `query()` appends no events and holds no write transaction; access
    metadata updates are observably deferred.

---

## 12. One-line export

**Memory = one SQLite file under the living-room floor: bi-temporal facts that are invalidated,
never deleted; every fact cites its agent, seq, turn, and attachment; retrieval is room-scoped
prose under a hard token budget; the event log stays the only truth and the whole thing replays
from it.**
