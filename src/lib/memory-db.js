import { DatabaseSync } from 'node:sqlite';
import { id as generateId, now } from './utils.js';

export class MemoryDb {
  /**
   * @param {string} dbPath - Filepath to SQLite database, or ':memory:'
   */
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);

    // Enable WAL mode for concurrency and performance (unless in-memory)
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    // Enable foreign keys for referential integrity
    this.db.exec('PRAGMA foreign_keys = ON;');
    this._inTransaction = false;
  }

  /**
   * Close the database connection
   */
  close() {
    this.db.close();
  }

  /**
   * Run a function inside an SQLite transaction
   * @param {function(MemoryDb): any} fn
   */
  transaction(fn) {
    if (this._inTransaction) {
      return fn(this);
    }
    this._inTransaction = true;
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const result = fn(this);
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    } finally {
      this._inTransaction = false;
    }
  }


  /**
   * Initialize the schema and FTS virtual tables
   */
  init() {
    const schemaVersion = Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0);
    if (schemaVersion > 1) {
      throw new Error(`Memory database schema ${schemaVersion} is newer than this Conclave build supports`);
    }
    this.transaction(() => {
      // 1. Workspaces
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT,
          path TEXT,
          repositoryIdentity TEXT,
          createdAt TEXT NOT NULL
        );
      `);

      // 2. Rooms
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          workspaceId TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          createdAt TEXT NOT NULL
        );
      `);

      // 3. Messages (Tier 1 Verbatim History)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          sourceType TEXT NOT NULL CHECK (sourceType IN ('user', 'agent', 'system')),
          sourceId TEXT,
          sourceNameSnapshot TEXT,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          contentHash TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          parentMessageId TEXT REFERENCES messages(id) ON DELETE SET NULL,
          threadRootId TEXT REFERENCES messages(id) ON DELETE SET NULL,
          taskId TEXT,
          chatTurnId TEXT,
          executionId TEXT,
          correlationId TEXT,
          causationId TEXT,
          createdAt TEXT,
          timestampStatus TEXT NOT NULL DEFAULT 'valid' CHECK (timestampStatus IN ('valid', 'source-invalid', 'source-missing', 'legacy-invalid', 'legacy-missing')),
          finalizedAt TEXT,
          redactionState TEXT NOT NULL DEFAULT 'none' CHECK (redactionState IN ('none', 'redacted', 'revision-required')),
          deletedAt TEXT
        );
      `);

      // Indexing message sequences for fast retrieval and pagination
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(roomId, sequence);
      `);

      // 4. Message Revisions
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS message_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          content TEXT NOT NULL,
          contentHash TEXT NOT NULL,
          actorId TEXT,
          reason TEXT,
          createdAt TEXT NOT NULL
        );
      `);

      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_message_revisions_uniq ON message_revisions(messageId, revision);
      `);

      // 5. Summary Checkpoints (Tier 2 Checkpoints)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS summary_checkpoints (
          id TEXT PRIMARY KEY,
          roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'stale', 'superseded')),
          fromSequenceExclusive INTEGER NOT NULL,
          throughSequenceInclusive INTEGER NOT NULL,
          sourceDigest TEXT NOT NULL,
          content TEXT NOT NULL,
          contentHash TEXT NOT NULL,
          producerType TEXT,
          producerId TEXT,
          generatedAt TEXT NOT NULL,
          staleReason TEXT
        );
      `);

      // 6. Summary Rollups (Tier 2 Rollups)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS summary_rollups (
          id TEXT PRIMARY KEY,
          roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'stale', 'superseded')),
          throughSequenceInclusive INTEGER NOT NULL,
          structuredStateDigest TEXT NOT NULL,
          ledgerDigest TEXT NOT NULL,
          content TEXT NOT NULL,
          contentHash TEXT NOT NULL,
          producerType TEXT,
          producerId TEXT,
          generatedAt TEXT NOT NULL,
          staleReason TEXT
        );
      `);

      // 7. Summary Sources
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS summary_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          checkpointId TEXT NOT NULL REFERENCES summary_checkpoints(id) ON DELETE CASCADE,
          sourceMessageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE
        );
      `);

      // 8. Summary Jobs
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS summary_jobs (
          id TEXT PRIMARY KEY,
          roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          fromSequenceExclusive INTEGER NOT NULL,
          throughSequenceInclusive INTEGER NOT NULL,
          sourceDigest TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          availableAt TEXT NOT NULL,
          leaseOwner TEXT,
          leaseExpiresAt TEXT,
          lastError TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
      `);

      // 9. Memory Items (Tier 3 Curated Facts Ledger / Nodes)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_items (
          id TEXT PRIMARY KEY,
          roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          workspaceId TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          kind TEXT NOT NULL CHECK (kind IN ('decision', 'requirement', 'preference', 'constraint', 'fact', 'hypothesis', 'question', 'evidence', 'risk', 'disagreement', 'rejected-approach')),
          title TEXT NOT NULL,
          statement TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('proposed', 'observed', 'verified', 'accepted', 'rejected', 'disputed', 'superseded', 'stale')),
          scope TEXT NOT NULL DEFAULT 'room' CHECK (scope IN ('room', 'workspace')),
          pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
          applicability TEXT, -- JSON structure
          authorType TEXT,
          authorId TEXT,
          ownerId TEXT,
          confidenceLabel TEXT,
          supportState TEXT NOT NULL DEFAULT 'available' CHECK (supportState IN ('available', 'partial', 'unavailable', 'compromised')),
          verificationRuleId TEXT,
          validFrom TEXT,
          reviewAfter TEXT,
          expiresAt TEXT,
          supersedesItemId TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
          supersededByItemId TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
      `);

      // 10. Memory Item Revisions
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_item_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          itemId TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          title TEXT NOT NULL,
          statement TEXT NOT NULL,
          status TEXT NOT NULL,
          actorId TEXT,
          reason TEXT,
          createdAt TEXT NOT NULL
        );
      `);

      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_item_revisions_uniq ON memory_item_revisions(itemId, version);
      `);

      // 11. Memory Sources (Provenance metadata)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          itemId TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          sourceType TEXT NOT NULL CHECK (sourceType IN ('message', 'task', 'execution', 'evidence', 'audit', 'memory')),
          sourceId TEXT NOT NULL,
          sourceRevision INTEGER,
          sourceHash TEXT,
          excerpt TEXT,
          supportRole TEXT NOT NULL DEFAULT 'required' CHECK (supportRole IN ('required', 'supplemental')),
          supportState TEXT NOT NULL DEFAULT 'available' CHECK (supportState IN ('available', 'retention-pruned', 'redacted', 'missing', 'hash-mismatch')),
          supportChangedAt TEXT NOT NULL,
          supportChangeReason TEXT
        );
      `);

      // 12. Memory Connections (Edges in the memory graph)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_connections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sourceId TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          targetId TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          relationship TEXT NOT NULL CHECK (relationship IN ('relates_to', 'derived_from', 'contradicts', 'evolved_into', 'belongs_to', 'informed_by', 'disagrees-with')),
          createdAt TEXT NOT NULL,
          UNIQUE(sourceId, targetId, relationship)
        );
      `);

      // 13. Context Receipts
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS context_receipts (
          id TEXT PRIMARY KEY,
          roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          executionId TEXT NOT NULL,
          assemblerVersion TEXT NOT NULL,
          estimatorVersion TEXT NOT NULL,
          assemblerConfigHash TEXT NOT NULL,
          roomVersion INTEGER,
          workspaceSnapshotId TEXT,
          memoryVersion INTEGER,
          promptTemplateHash TEXT NOT NULL,
          contextPackageHash TEXT NOT NULL,
          totalCharacters INTEGER NOT NULL,
          summaryCoverageThroughSequence INTEGER,
          createdAt TEXT NOT NULL
        );
      `);

      // 14. Context Receipt Entries
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS context_receipt_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          receiptId TEXT NOT NULL REFERENCES context_receipts(id) ON DELETE CASCADE,
          tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
          objectId TEXT NOT NULL,
          revision INTEGER,
          hash TEXT,
          reason TEXT NOT NULL,
          characters INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'selected' CHECK (status IN ('selected', 'omitted'))
        );
      `);

      // 15. Virtual FTS5 Tables
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          id UNINDEXED,
          content
        );
      `);

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
          id UNINDEXED,
          title,
          statement
        );
      `);

      // Triggers for syncing FTS tables
      // Messages FTS Triggers
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS t_messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(id, content) VALUES (new.id, new.content);
        END;
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS t_messages_ad AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE id = old.id;
        END;
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS t_messages_au AFTER UPDATE OF content ON messages BEGIN
          UPDATE messages_fts SET content = new.content WHERE id = old.id;
        END;
      `);

      // Memory Items FTS Triggers
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS t_memory_items_ai AFTER INSERT ON memory_items BEGIN
          INSERT INTO memory_items_fts(id, title, statement) VALUES (new.id, new.title, new.statement);
        END;
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS t_memory_items_ad AFTER DELETE ON memory_items BEGIN
          DELETE FROM memory_items_fts WHERE id = old.id;
        END;
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS t_memory_items_au AFTER UPDATE OF title, statement ON memory_items BEGIN
          UPDATE memory_items_fts SET title = new.title, statement = new.statement WHERE id = old.id;
        END;
      `);

      // The sidecar is still experimental and rebuildable from JSON, but its
      // additive migrations must remain restart-idempotent. Prototype databases
      // created before pinned-priority support are upgraded in place.
      const memoryItemColumns = new Set(
        this.db.prepare('PRAGMA table_info(memory_items)').all().map((column) => column.name)
      );
      if (!memoryItemColumns.has('pinned')) {
        this.db.exec('ALTER TABLE memory_items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));');
      }
      this.db.exec('PRAGMA user_version = 1;');
    });
  }

  // --- Workspaces ---
  saveWorkspace(workspace) {
    const stmt = this.db.prepare(`
      INSERT INTO workspaces (id, name, path, repositoryIdentity, createdAt)
      VALUES (:id, :name, :path, :repositoryIdentity, :createdAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        repositoryIdentity = excluded.repositoryIdentity;
    `);
    const timestamp = workspace.createdAt || now();
    stmt.run({
      id: workspace.id,
      name: workspace.name || null,
      path: workspace.path || null,
      repositoryIdentity: workspace.repositoryIdentity || null,
      createdAt: timestamp
    });
  }

  getWorkspace(id) {
    const stmt = this.db.prepare('SELECT * FROM workspaces WHERE id = ?');
    return stmt.get(id) || null;
  }

  // --- Rooms ---
  saveRoom(room) {
    const stmt = this.db.prepare(`
      INSERT INTO rooms (id, name, workspaceId, createdAt)
      VALUES (:id, :name, :workspaceId, :createdAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        workspaceId = excluded.workspaceId;
    `);
    const timestamp = room.createdAt || now();
    stmt.run({
      id: room.id,
      name: room.name,
      workspaceId: room.workspaceId || null,
      createdAt: timestamp
    });
  }

  getRoom(id) {
    const stmt = this.db.prepare('SELECT * FROM rooms WHERE id = ?');
    return stmt.get(id) || null;
  }

  // --- Messages (Tier 1) ---
  saveMessage(msg) {
    return this.transaction(() => {
      const existing = this.getMessage(msg.id);
      const timestamp = msg.createdAt || now();

      if (!existing) {
        // Insert message
        const stmtInsert = this.db.prepare(`
          INSERT INTO messages (
            id, roomId, sequence, sourceType, sourceId, sourceNameSnapshot, type, content, contentHash,
            revision, parentMessageId, threadRootId, taskId, chatTurnId, executionId, correlationId,
            causationId, createdAt, timestampStatus, finalizedAt, redactionState, deletedAt
          ) VALUES (
            :id, :roomId, :sequence, :sourceType, :sourceId, :sourceNameSnapshot, :type, :content, :contentHash,
            :revision, :parentMessageId, :threadRootId, :taskId, :chatTurnId, :executionId, :correlationId,
            :causationId, :createdAt, :timestampStatus, :finalizedAt, :redactionState, :deletedAt
          )
        `);

        stmtInsert.run({
          id: msg.id,
          roomId: msg.roomId,
          sequence: msg.sequence,
          sourceType: msg.sourceType,
          sourceId: msg.sourceId || null,
          sourceNameSnapshot: msg.sourceNameSnapshot || null,
          type: msg.type,
          content: msg.content,
          contentHash: msg.contentHash,
          revision: msg.revision || 1,
          parentMessageId: msg.parentMessageId || null,
          threadRootId: msg.threadRootId || null,
          taskId: msg.taskId || null,
          chatTurnId: msg.chatTurnId || null,
          executionId: msg.executionId || null,
          correlationId: msg.correlationId || null,
          causationId: msg.causationId || null,
          createdAt: timestamp,
          timestampStatus: msg.timestampStatus || 'valid',
          finalizedAt: msg.finalizedAt || null,
          redactionState: msg.redactionState || 'none',
          deletedAt: msg.deletedAt || null
        });

        // Insert initial revision
        const stmtRev = this.db.prepare(`
          INSERT INTO message_revisions (messageId, revision, content, contentHash, actorId, reason, createdAt)
          VALUES (:messageId, :revision, :content, :contentHash, :actorId, :reason, :createdAt)
        `);
        stmtRev.run({
          messageId: msg.id,
          revision: msg.revision || 1,
          content: msg.content,
          contentHash: msg.contentHash,
          actorId: msg.sourceId || null,
          reason: 'initial creation',
          createdAt: timestamp
        });

        return 1;
      } else {
        // Check if content changed
        const isContentDifferent = existing.content !== msg.content;
        const nextRevision = isContentDifferent ? (existing.revision + 1) : existing.revision;

        const stmtUpdate = this.db.prepare(`
          UPDATE messages SET
            roomId = :roomId,
            sequence = :sequence,
            sourceType = :sourceType,
            sourceId = :sourceId,
            sourceNameSnapshot = :sourceNameSnapshot,
            type = :type,
            content = :content,
            contentHash = :contentHash,
            revision = :revision,
            parentMessageId = :parentMessageId,
            threadRootId = :threadRootId,
            taskId = :taskId,
            chatTurnId = :chatTurnId,
            executionId = :executionId,
            correlationId = :correlationId,
            causationId = :causationId,
            timestampStatus = :timestampStatus,
            finalizedAt = :finalizedAt,
            redactionState = :redactionState,
            deletedAt = :deletedAt
          WHERE id = :id
        `);

        stmtUpdate.run({
          id: msg.id,
          roomId: msg.roomId,
          sequence: msg.sequence,
          sourceType: msg.sourceType,
          sourceId: msg.sourceId || null,
          sourceNameSnapshot: msg.sourceNameSnapshot || null,
          type: msg.type,
          content: msg.content,
          contentHash: msg.contentHash,
          revision: nextRevision,
          parentMessageId: msg.parentMessageId || null,
          threadRootId: msg.threadRootId || null,
          taskId: msg.taskId || null,
          chatTurnId: msg.chatTurnId || null,
          executionId: msg.executionId || null,
          correlationId: msg.correlationId || null,
          causationId: msg.causationId || null,
          timestampStatus: msg.timestampStatus || 'valid',
          finalizedAt: msg.finalizedAt || null,
          redactionState: msg.redactionState || 'none',
          deletedAt: msg.deletedAt || null
        });

        if (isContentDifferent) {
          const stmtRev = this.db.prepare(`
            INSERT INTO message_revisions (messageId, revision, content, contentHash, actorId, reason, createdAt)
            VALUES (:messageId, :revision, :content, :contentHash, :actorId, :reason, :createdAt)
          `);
          stmtRev.run({
            messageId: msg.id,
            revision: nextRevision,
            content: msg.content,
            contentHash: msg.contentHash,
            actorId: msg.sourceId || null,
            reason: msg.editReason || 'content update',
            createdAt: now()
          });
        }

        return nextRevision;
      }
    });
  }

  getMessage(id) {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ?');
    const msg = stmt.get(id);
    return msg || null;
  }

  getMessageRevisions(messageId) {
    const stmt = this.db.prepare('SELECT * FROM message_revisions WHERE messageId = ? ORDER BY revision ASC');
    return stmt.all(messageId);
  }

  deleteMessage(id) {
    const stmt = this.db.prepare('UPDATE messages SET deletedAt = ? WHERE id = ?');
    return stmt.run(now(), id).changes;
  }

  /**
   * Hard-delete a message and cascaded revisions/FTS rows (forget / AC-12).
   * Prefer this over soft-delete when content must leave every retrieval surface.
   */
  purgeMessage(id) {
    const stmt = this.db.prepare('DELETE FROM messages WHERE id = ?');
    return stmt.run(id).changes;
  }

  /**
   * Lexical message search. Scope and soft-deletes are mandatory filters so
   * FTS cannot leak across rooms or return forgotten rows (ADR AC-10 / AC-12).
   * @param {string} query - FTS5 MATCH expression
   * @param {{ roomId?: string }} [options]
   */
  searchMessages(query, options = {}) {
    const roomId = options.roomId || null;
    if (!roomId) throw new Error('roomId is required for message search');
    const stmt = this.db.prepare(`
      SELECT m.*
      FROM messages_fts fts
      JOIN messages m ON m.id = fts.id
      WHERE messages_fts MATCH :query
        AND m.roomId = :roomId
        AND m.deletedAt IS NULL
      ORDER BY m.sequence DESC
    `);
    return stmt.all({ query, roomId });
  }

  // --- Summary Checkpoints (Tier 2) ---
  saveCheckpoint(checkpoint) {
    const stmt = this.db.prepare(`
      INSERT INTO summary_checkpoints (
        id, roomId, revision, status, fromSequenceExclusive, throughSequenceInclusive,
        sourceDigest, content, contentHash, producerType, producerId, generatedAt, staleReason
      ) VALUES (
        :id, :roomId, :revision, :status, :fromSequenceExclusive, :throughSequenceInclusive,
        :sourceDigest, :content, :contentHash, :producerType, :producerId, :generatedAt, :staleReason
      ) ON CONFLICT(id) DO UPDATE SET
        revision = excluded.revision,
        status = excluded.status,
        fromSequenceExclusive = excluded.fromSequenceExclusive,
        throughSequenceInclusive = excluded.throughSequenceInclusive,
        sourceDigest = excluded.sourceDigest,
        content = excluded.content,
        contentHash = excluded.contentHash,
        staleReason = excluded.staleReason;
    `);
    const timestamp = checkpoint.generatedAt || now();
    stmt.run({
      id: checkpoint.id,
      roomId: checkpoint.roomId,
      revision: checkpoint.revision || 1,
      status: checkpoint.status || 'current',
      fromSequenceExclusive: checkpoint.fromSequenceExclusive,
      throughSequenceInclusive: checkpoint.throughSequenceInclusive,
      sourceDigest: checkpoint.sourceDigest,
      content: checkpoint.content,
      contentHash: checkpoint.contentHash,
      producerType: checkpoint.producerType || null,
      producerId: checkpoint.producerId || null,
      generatedAt: timestamp,
      staleReason: checkpoint.staleReason || null
    });
  }

  getCheckpoint(id) {
    const stmt = this.db.prepare('SELECT * FROM summary_checkpoints WHERE id = ?');
    return stmt.get(id) || null;
  }

  // --- Summary Rollups (Tier 2) ---
  saveRollup(rollup) {
    const stmt = this.db.prepare(`
      INSERT INTO summary_rollups (
        id, roomId, revision, status, throughSequenceInclusive, structuredStateDigest,
        ledgerDigest, content, contentHash, producerType, producerId, generatedAt, staleReason
      ) VALUES (
        :id, :roomId, :revision, :status, :throughSequenceInclusive, :structuredStateDigest,
        :ledgerDigest, :content, :contentHash, :producerType, :producerId, :generatedAt, :staleReason
      ) ON CONFLICT(id) DO UPDATE SET
        revision = excluded.revision,
        status = excluded.status,
        throughSequenceInclusive = excluded.throughSequenceInclusive,
        structuredStateDigest = excluded.structuredStateDigest,
        ledgerDigest = excluded.ledgerDigest,
        content = excluded.content,
        contentHash = excluded.contentHash,
        staleReason = excluded.staleReason;
    `);
    const timestamp = rollup.generatedAt || now();
    stmt.run({
      id: rollup.id,
      roomId: rollup.roomId,
      revision: rollup.revision || 1,
      status: rollup.status || 'current',
      throughSequenceInclusive: rollup.throughSequenceInclusive,
      structuredStateDigest: rollup.structuredStateDigest,
      ledgerDigest: rollup.ledgerDigest,
      content: rollup.content,
      contentHash: rollup.contentHash,
      producerType: rollup.producerType || null,
      producerId: rollup.producerId || null,
      generatedAt: timestamp,
      staleReason: rollup.staleReason || null
    });
  }

  getRollup(id) {
    const stmt = this.db.prepare('SELECT * FROM summary_rollups WHERE id = ?');
    return stmt.get(id) || null;
  }

  getLatestRollup(roomId) {
    const stmt = this.db.prepare(`
      SELECT * FROM summary_rollups
      WHERE roomId = ? AND status = 'current'
      ORDER BY throughSequenceInclusive DESC, revision DESC
      LIMIT 1
    `);
    return stmt.get(roomId) || null;
  }

  // --- Summary Jobs ---
  saveSummaryJob(job) {
    const stmt = this.db.prepare(`
      INSERT INTO summary_jobs (
        id, roomId, fromSequenceExclusive, throughSequenceInclusive, sourceDigest, kind,
        status, attempts, availableAt, leaseOwner, leaseExpiresAt, lastError, createdAt, updatedAt
      ) VALUES (
        :id, :roomId, :fromSequenceExclusive, :throughSequenceInclusive, :sourceDigest, :kind,
        :status, :attempts, :availableAt, :leaseOwner, :leaseExpiresAt, :lastError, :createdAt, :updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        attempts = excluded.attempts,
        availableAt = excluded.availableAt,
        leaseOwner = excluded.leaseOwner,
        leaseExpiresAt = excluded.leaseExpiresAt,
        lastError = excluded.lastError,
        updatedAt = excluded.updatedAt;
    `);
    const timestamp = now();
    stmt.run({
      id: job.id,
      roomId: job.roomId,
      fromSequenceExclusive: job.fromSequenceExclusive,
      throughSequenceInclusive: job.throughSequenceInclusive,
      sourceDigest: job.sourceDigest,
      kind: job.kind,
      status: job.status,
      attempts: job.attempts || 0,
      availableAt: job.availableAt || timestamp,
      leaseOwner: job.leaseOwner || null,
      leaseExpiresAt: job.leaseExpiresAt || null,
      lastError: job.lastError || null,
      createdAt: job.createdAt || timestamp,
      updatedAt: timestamp
    });
  }

  getSummaryJob(id) {
    const stmt = this.db.prepare('SELECT * FROM summary_jobs WHERE id = ?');
    return stmt.get(id) || null;
  }

  // --- Memory Items (Tier 3 Nodes) ---
  rememberNode(node) {
    return this.transaction(() => {
      const existing = this.getNode(node.id);
      const timestamp = now();

      const applicabilityJson = node.applicability
        ? (typeof node.applicability === 'string' ? node.applicability : JSON.stringify(node.applicability))
        : null;

      if (!existing) {
        const stmtInsert = this.db.prepare(`
          INSERT INTO memory_items (
            id, roomId, workspaceId, kind, title, statement, status, scope, pinned, applicability,
            authorType, authorId, ownerId, confidenceLabel, supportState, verificationRuleId,
            validFrom, reviewAfter, expiresAt, supersedesItemId, supersededByItemId, version,
            createdAt, updatedAt
          ) VALUES (
            :id, :roomId, :workspaceId, :kind, :title, :statement, :status, :scope, :pinned, :applicability,
            :authorType, :authorId, :ownerId, :confidenceLabel, :supportState, :verificationRuleId,
            :validFrom, :reviewAfter, :expiresAt, :supersedesItemId, :supersededByItemId, :version,
            :createdAt, :updatedAt
          )
        `);

        stmtInsert.run({
          id: node.id,
          roomId: node.roomId,
          workspaceId: node.workspaceId || null,
          kind: node.kind,
          title: node.title,
          statement: node.statement,
          status: node.status,
          scope: node.scope || 'room',
          pinned: node.pinned ? 1 : 0,
          applicability: applicabilityJson,
          authorType: node.authorType || null,
          authorId: node.authorId || null,
          ownerId: node.ownerId || null,
          confidenceLabel: node.confidenceLabel || null,
          supportState: node.supportState || 'available',
          verificationRuleId: node.verificationRuleId || null,
          validFrom: node.validFrom || null,
          reviewAfter: node.reviewAfter || null,
          expiresAt: node.expiresAt || null,
          supersedesItemId: node.supersedesItemId || null,
          supersededByItemId: node.supersededByItemId || null,
          version: node.version || 1,
          createdAt: node.createdAt || timestamp,
          updatedAt: node.updatedAt || timestamp
        });

        // Insert initial revision
        const stmtRev = this.db.prepare(`
          INSERT INTO memory_item_revisions (itemId, version, title, statement, status, actorId, reason, createdAt)
          VALUES (:itemId, :version, :title, :statement, :status, :actorId, :reason, :createdAt)
        `);
        stmtRev.run({
          itemId: node.id,
          version: node.version || 1,
          title: node.title,
          statement: node.statement,
          status: node.status,
          actorId: node.authorId || null,
          reason: 'initial curation',
          createdAt: timestamp
        });

        return 1;
      } else {
        const isDifferent = existing.title !== node.title ||
                            existing.statement !== node.statement ||
                            existing.status !== node.status;
        const requestedVersion = Number.isInteger(node.version) && node.version > 0 ? node.version : 0;
        const nextVersion = Math.max(
          existing.version + (isDifferent ? 1 : 0),
          requestedVersion
        );

        const stmtUpdate = this.db.prepare(`
          UPDATE memory_items SET
            roomId = :roomId,
            workspaceId = :workspaceId,
            kind = :kind,
            title = :title,
            statement = :statement,
            status = :status,
            scope = :scope,
            pinned = :pinned,
            applicability = :applicability,
            authorType = :authorType,
            authorId = :authorId,
            ownerId = :ownerId,
            confidenceLabel = :confidenceLabel,
            supportState = :supportState,
            verificationRuleId = :verificationRuleId,
            validFrom = :validFrom,
            reviewAfter = :reviewAfter,
            expiresAt = :expiresAt,
            supersedesItemId = :supersedesItemId,
            supersededByItemId = :supersededByItemId,
            version = :version,
            updatedAt = :updatedAt
          WHERE id = :id
        `);

        stmtUpdate.run({
          id: node.id,
          roomId: node.roomId,
          workspaceId: node.workspaceId || null,
          kind: node.kind,
          title: node.title,
          statement: node.statement,
          status: node.status,
          scope: node.scope || 'room',
          pinned: node.pinned ? 1 : 0,
          applicability: applicabilityJson,
          authorType: node.authorType || null,
          authorId: node.authorId || null,
          ownerId: node.ownerId || null,
          confidenceLabel: node.confidenceLabel || null,
          supportState: node.supportState || 'available',
          verificationRuleId: node.verificationRuleId || null,
          validFrom: node.validFrom || null,
          reviewAfter: node.reviewAfter || null,
          expiresAt: node.expiresAt || null,
          supersedesItemId: node.supersedesItemId || null,
          supersededByItemId: node.supersededByItemId || null,
          version: nextVersion,
          updatedAt: timestamp
        });

        if (isDifferent) {
          const stmtRev = this.db.prepare(`
            INSERT INTO memory_item_revisions (itemId, version, title, statement, status, actorId, reason, createdAt)
            VALUES (:itemId, :version, :title, :statement, :status, :actorId, :reason, :createdAt)
          `);
          stmtRev.run({
            itemId: node.id,
            version: nextVersion,
            title: node.title,
            statement: node.statement,
            status: node.status,
            actorId: node.authorId || null,
            reason: node.updateReason || 'revision update',
            createdAt: timestamp
          });
        }

        return nextVersion;
      }
    });
  }

  getNode(id) {
    const stmt = this.db.prepare('SELECT * FROM memory_items WHERE id = ?');
    const node = stmt.get(id);
    if (!node) return null;
    node.pinned = node.pinned === 1;
    if (node.applicability) {
      try {
        node.applicability = JSON.parse(node.applicability);
      } catch {
        // Keep as string if parsing fails
      }
    }
    return node;
  }

  deleteNode(id) {
    const stmt = this.db.prepare('DELETE FROM memory_items WHERE id = ?');
    return stmt.run(id).changes;
  }

  /**
   * Lexical memory-item search. Optional roomId binds scope (ADR AC-10).
   * @param {string} query - FTS5 MATCH expression
   * @param {{ roomId?: string }} [options]
   */
  searchNodes(query, options = {}) {
    const roomId = options.roomId || null;
    if (!roomId) throw new Error('roomId is required for memory search');
    const sql = `
      SELECT m.*
      FROM memory_items_fts fts
      JOIN memory_items m ON m.id = fts.id
      WHERE memory_items_fts MATCH :query
        AND m.roomId = :roomId
      ORDER BY m.updatedAt DESC
    `;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all({ query, roomId });
    return rows.map(node => {
      node.pinned = node.pinned === 1;
      if (node.applicability) {
        try {
          node.applicability = JSON.parse(node.applicability);
        } catch {
          // Ignore
        }
      }
      return node;
    });
  }

  // --- Connections ---
  connectNodes(sourceId, targetId, relationship) {
    const endpoints = this.db.prepare('SELECT id, roomId FROM memory_items WHERE id IN (?, ?)').all(sourceId, targetId);
    if (endpoints.length !== (sourceId === targetId ? 1 : 2)) {
      throw new Error('Both memory items must exist before they can be connected');
    }
    if (new Set(endpoints.map((item) => item.roomId)).size !== 1) {
      throw new Error('Memory connections cannot cross room boundaries');
    }
    const stmt = this.db.prepare(`
      INSERT INTO memory_connections (sourceId, targetId, relationship, createdAt)
      VALUES (:sourceId, :targetId, :relationship, :createdAt)
      ON CONFLICT(sourceId, targetId, relationship) DO UPDATE SET
        createdAt = excluded.createdAt;
    `);
    stmt.run({
      sourceId,
      targetId,
      relationship,
      createdAt: now()
    });
  }

  getConnections(nodeId) {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_connections
      WHERE sourceId = :nodeId OR targetId = :nodeId
    `);
    return stmt.all({ nodeId });
  }

  disconnectNodes(sourceId, targetId, relationship) {
    const stmt = this.db.prepare(`
      DELETE FROM memory_connections
      WHERE sourceId = :sourceId AND targetId = :targetId AND relationship = :relationship
    `);
    return stmt.run({ sourceId, targetId, relationship }).changes;
  }

  // --- Provenance / Sources ---
  addNodeSource(src) {
    const stmt = this.db.prepare(`
      INSERT INTO memory_sources (
        itemId, sourceType, sourceId, sourceRevision, sourceHash, excerpt,
        supportRole, supportState, supportChangedAt, supportChangeReason
      ) VALUES (
        :itemId, :sourceType, :sourceId, :sourceRevision, :sourceHash, :excerpt,
        :supportRole, :supportState, :supportChangedAt, :supportChangeReason
      );
    `);
    stmt.run({
      itemId: src.itemId,
      sourceType: src.sourceType,
      sourceId: src.sourceId,
      sourceRevision: src.sourceRevision || null,
      sourceHash: src.sourceHash || null,
      excerpt: src.excerpt || null,
      supportRole: src.supportRole || 'required',
      supportState: src.supportState || 'available',
      supportChangedAt: src.supportChangedAt || now(),
      supportChangeReason: src.supportChangeReason || null
    });
  }

  getNodeSources(itemId) {
    const stmt = this.db.prepare('SELECT * FROM memory_sources WHERE itemId = ?');
    return stmt.all(itemId);
  }

  // --- Context Receipts ---
  saveContextReceipt(receipt, entries) {
    this.transaction(() => {
      const stmtRec = this.db.prepare(`
        INSERT INTO context_receipts (
          id, roomId, executionId, assemblerVersion, estimatorVersion, assemblerConfigHash,
          roomVersion, workspaceSnapshotId, memoryVersion, promptTemplateHash, contextPackageHash,
          totalCharacters, summaryCoverageThroughSequence, createdAt
        ) VALUES (
          :id, :roomId, :executionId, :assemblerVersion, :estimatorVersion, :assemblerConfigHash,
          :roomVersion, :workspaceSnapshotId, :memoryVersion, :promptTemplateHash, :contextPackageHash,
          :totalCharacters, :summaryCoverageThroughSequence, :createdAt
        )
      `);

      const timestamp = receipt.createdAt || now();

      stmtRec.run({
        id: receipt.id,
        roomId: receipt.roomId,
        executionId: receipt.executionId,
        assemblerVersion: receipt.assemblerVersion,
        estimatorVersion: receipt.estimatorVersion,
        assemblerConfigHash: receipt.assemblerConfigHash,
        roomVersion: receipt.roomVersion || null,
        workspaceSnapshotId: receipt.workspaceSnapshotId || null,
        memoryVersion: receipt.memoryVersion || null,
        promptTemplateHash: receipt.promptTemplateHash,
        contextPackageHash: receipt.contextPackageHash,
        totalCharacters: receipt.totalCharacters,
        summaryCoverageThroughSequence: receipt.summaryCoverageThroughSequence || null,
        createdAt: timestamp
      });

      const stmtEntry = this.db.prepare(`
        INSERT INTO context_receipt_entries (
          receiptId, tier, objectId, revision, hash, reason, characters, status
        ) VALUES (
          :receiptId, :tier, :objectId, :revision, :hash, :reason, :characters, :status
        )
      `);

      for (const entry of entries) {
        stmtEntry.run({
          receiptId: receipt.id,
          tier: entry.tier,
          objectId: entry.objectId,
          revision: entry.revision || null,
          hash: entry.hash || null,
          reason: entry.reason,
          characters: entry.characters,
          status: entry.status || 'selected'
        });
      }
    });
  }

  getContextReceipt(id) {
    const stmtRec = this.db.prepare('SELECT * FROM context_receipts WHERE id = ?');
    const receipt = stmtRec.get(id);
    if (!receipt) return null;

    const stmtEntries = this.db.prepare('SELECT * FROM context_receipt_entries WHERE receiptId = ?');
    receipt.entries = stmtEntries.all(id);
    return receipt;
  }
}
