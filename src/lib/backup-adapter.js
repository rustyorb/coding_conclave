import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const BACKUP_VERSION = 2;
const ALL_TABLES = [
  'workspaces',
  'rooms',
  'messages',
  'message_revisions',
  'summary_checkpoints',
  'summary_rollups',
  'summary_sources',
  'summary_jobs',
  'memory_items',
  'memory_item_revisions',
  'memory_sources',
  'memory_connections',
  'context_receipts',
  'context_receipt_entries'
];

function requireBackupEnvelope(value) {
  if (!value || typeof value !== 'object' || value.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version; expected ${BACKUP_VERSION}`);
  }
  if (!['graph', 'all'].includes(value.type) || !value.data || typeof value.data !== 'object') {
    throw new Error('Invalid backup envelope');
  }
  return value;
}

export class BackupAdapter {
  /**
   * @param {object} options
   * @param {object} options.db - An instance of MemoryDb
   * @param {string} options.passphrase - Password/passphrase used for key derivation
   */
  constructor({ db, passphrase }) {
    if (!db) throw new Error('MemoryDb instance is required');
    if (!passphrase || typeof passphrase !== 'string') {
      throw new Error('Encryption passphrase is required and must be a string');
    }
    this.db = db;
    this.passphrase = passphrase;
  }

  /**
   * Serialize Tier 3 memory graph (nodes, connections, sources) to a JSON string
   * @param {string} [roomId] - Optional filter by roomId
   * @returns {string} Serialized JSON
   */
  serializeGraph(roomId = null) {
    const rawDb = this.db.db;

    let items;
    let revisions;
    let connections;
    let sources;

    if (roomId) {
      const stmtItems = rawDb.prepare('SELECT * FROM memory_items WHERE roomId = ?');
      items = stmtItems.all(roomId);

      const itemIds = items.map(item => item.id);
      if (itemIds.length > 0) {
        // Prepare placeholders for IN clause
        const placeholders = itemIds.map(() => '?').join(',');
        
        // Room-filtered graph exports never include a dangling or cross-room
        // edge: both endpoints must be part of the exported item set.
        const stmtConns = rawDb.prepare(`
          SELECT * FROM memory_connections 
          WHERE sourceId IN (${placeholders}) AND targetId IN (${placeholders})
        `);
        connections = stmtConns.all(...itemIds, ...itemIds);

        revisions = rawDb.prepare(`
          SELECT * FROM memory_item_revisions
          WHERE itemId IN (${placeholders})
          ORDER BY itemId, version
        `).all(...itemIds);

        // Find sources linked to itemIds
        const stmtSources = rawDb.prepare(`
          SELECT * FROM memory_sources 
          WHERE itemId IN (${placeholders})
        `);
        sources = stmtSources.all(...itemIds);
      } else {
        revisions = [];
        connections = [];
        sources = [];
      }
    } else {
      items = rawDb.prepare('SELECT * FROM memory_items').all();
      revisions = rawDb.prepare('SELECT * FROM memory_item_revisions ORDER BY itemId, version').all();
      connections = rawDb.prepare('SELECT * FROM memory_connections').all();
      sources = rawDb.prepare('SELECT * FROM memory_sources').all();
    }

    // Parse applicability JSON strings
    items.forEach(item => {
      if (item.applicability && typeof item.applicability === 'string') {
        try {
          item.applicability = JSON.parse(item.applicability);
        } catch {
          // Keep as string if parsing fails
        }
      }
    });

    return JSON.stringify({
      version: BACKUP_VERSION,
      type: 'graph',
      exportedAt: new Date().toISOString(),
      roomId,
      data: {
        items,
        revisions,
        connections,
        sources
      }
    });
  }

  /**
   * Serialize all memory database tables to a JSON string
   * @returns {string} Serialized JSON
   */
  serializeAll() {
    const rawDb = this.db.db;
    const data = {};
    for (const table of ALL_TABLES) {
      const stmt = rawDb.prepare(`SELECT * FROM ${table}`);
      data[table] = stmt.all();
    }

    // Parse applicability in memory_items if present
    if (data.memory_items) {
      data.memory_items.forEach(item => {
        if (item.applicability && typeof item.applicability === 'string') {
          try {
            item.applicability = JSON.parse(item.applicability);
          } catch {
            // Keep as string
          }
        }
      });
    }

    return JSON.stringify({
      version: BACKUP_VERSION,
      type: 'all',
      exportedAt: new Date().toISOString(),
      data
    });
  }

  /**
   * Encrypt a string using AES-256-GCM and a key derived from passphrase via scrypt
   * @param {string} plaintext - Data to encrypt
   * @returns {Buffer} Concatenated binary data: [salt(16) | iv(12) | authTag(16) | ciphertext(...)]
   */
  encrypt(plaintext) {
    const salt = crypto.randomBytes(16);
    // Key derivation: 256-bit key (32 bytes)
    const key = crypto.scryptSync(this.passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let ciphertext = cipher.update(plaintext, 'utf8');
    ciphertext = Buffer.concat([ciphertext, cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([salt, iv, authTag, ciphertext]);
  }

  /**
   * Decrypt a Buffer containing the encrypted backup payload
   * @param {Buffer|string} encryptedData - Buffer or Base64/Hex string representing the encrypted payload
   * @returns {string} Plaintext decrypted string
   */
  decrypt(encryptedData) {
    let buffer;
    if (typeof encryptedData === 'string') {
      // Auto-detect base64 or hex format
      if (/^[0-9a-fA-F]+$/.test(encryptedData)) {
        buffer = Buffer.from(encryptedData, 'hex');
      } else {
        buffer = Buffer.from(encryptedData, 'base64');
      }
    } else if (Buffer.isBuffer(encryptedData)) {
      buffer = encryptedData;
    } else {
      throw new Error('Encrypted data must be a Buffer or an encoded string');
    }

    if (buffer.length < 44) {
      throw new Error('Invalid encrypted backup payload (too short)');
    }

    const salt = buffer.subarray(0, 16);
    const iv = buffer.subarray(16, 28);
    const authTag = buffer.subarray(28, 44);
    const ciphertext = buffer.subarray(44);

    const key = crypto.scryptSync(this.passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    try {
      let plaintext = decipher.update(ciphertext);
      plaintext = Buffer.concat([plaintext, decipher.final()]);
      return plaintext.toString('utf8');
    } catch (err) {
      throw new Error('Decryption failed: signature validation failed (likely incorrect passphrase or corrupted data)');
    }
  }

  /**
   * Push payload to a designated file or HTTP destination
   * @param {Buffer} payload - Encrypted binary backup payload
   * @param {object} destination
   * @param {string} destination.type - 'file' or 'http'
   * @param {string} [destination.path] - Absolute or relative filepath (required for 'file')
   * @param {string} [destination.url] - URL endpoint to POST payload (required for 'http')
   * @param {object} [destination.headers] - Custom HTTP headers to send (for 'http')
   */
  async push(payload, destination) {
    if (!destination || typeof destination !== 'object') {
      throw new Error('Destination configuration is required and must be an object');
    }

    if (destination.type === 'file') {
      if (!destination.path) {
        throw new Error('Destination file path is required');
      }
      const absolutePath = path.resolve(destination.path);
      // Ensure parent directory exists
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      const temporaryPath = `${absolutePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temporaryPath, payload, { mode: 0o600 });
        await fs.rename(temporaryPath, absolutePath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
      return { success: true, path: absolutePath, bytes: payload.length };
    }

    if (destination.type === 'http') {
      if (!destination.url) {
        throw new Error('Destination URL is required');
      }
      const target = new URL(destination.url);
      const loopback = ['127.0.0.1', '::1', 'localhost'].includes(target.hostname.toLowerCase());
      if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) {
        throw new Error('Remote backup destinations require HTTPS (HTTP is allowed only for loopback testing)');
      }
      if (target.username || target.password) {
        throw new Error('Backup destination credentials must be supplied as headers, not embedded in the URL');
      }
      const headers = {
        'Content-Type': 'application/octet-stream',
        ...destination.headers
      };

      const response = await fetch(target, {
        method: 'POST',
        headers,
        body: payload
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`HTTP push failed with status ${response.status}`);
      }

      return { success: true, url: destination.url, status: response.status, bytes: payload.length };
    }

    throw new Error(`Unsupported destination type: ${destination.type}`);
  }

  /**
   * Run serialization, encryption, and push in one workflow
   * @param {object} options
   * @param {string} [options.type] - 'graph' or 'all' (default: 'graph')
   * @param {string} [options.roomId] - Optional filter by room (only for 'graph')
   * @param {object} options.destination - Destination object
   * @returns {Promise<object>} Result metadata
   */
  async runBackup({ type = 'graph', roomId = null, destination } = {}) {
    let plaintext;
    if (type === 'graph') {
      plaintext = this.serializeGraph(roomId);
    } else if (type === 'all') {
      plaintext = this.serializeAll();
    } else {
      throw new Error(`Unsupported backup type: ${type}`);
    }

    const encrypted = this.encrypt(plaintext);
    const pushResult = await this.push(encrypted, destination);

    return {
      timestamp: new Date().toISOString(),
      type,
      roomId,
      encryptedBytes: encrypted.length,
      ...pushResult
    };
  }

  /**
   * Restore database state from a decrypted JSON backup string
   * @param {string} serializedStr - Decrypted JSON backup string
   */
  restore(serializedStr) {
    const backupObj = requireBackupEnvelope(JSON.parse(serializedStr));
    const { type, data } = backupObj;
    const rawDb = this.db.db;

    return this.db.transaction(() => {
      if (type === 'graph') {
        const { items, revisions, connections, sources } = data;
        for (const [name, rows] of Object.entries({ items, revisions, connections, sources })) {
          if (!Array.isArray(rows)) throw new Error(`Graph backup is missing ${name}`);
        }
        if (backupObj.roomId && items.some((item) => item.roomId !== backupObj.roomId)) {
          throw new Error('Graph backup contains items outside its declared room scope');
        }

        // Clean existing records to avoid conflicts on compound columns and duplicate references
        if (items.length > 0) {
          const itemIds = items.map(item => item.id);
          const placeholders = itemIds.map(() => '?').join(',');

          // Delete sources linked to these items
          rawDb.prepare(`DELETE FROM memory_sources WHERE itemId IN (${placeholders})`).run(...itemIds);

          // Delete connections where source or target is in itemIds
          rawDb.prepare(`
            DELETE FROM memory_connections 
            WHERE sourceId IN (${placeholders}) OR targetId IN (${placeholders})
          `).run(...itemIds, ...itemIds);

          // Delete the items themselves
          rawDb.prepare(`DELETE FROM memory_items WHERE id IN (${placeholders})`).run(...itemIds);
        }

        // Insert memory items
        for (const item of items) {
          const applicabilityJson = item.applicability
            ? (typeof item.applicability === 'string' ? item.applicability : JSON.stringify(item.applicability))
            : null;
          rawDb.prepare(`
            INSERT INTO memory_items (
              id, roomId, workspaceId, kind, title, statement, status, scope, pinned,
              applicability, authorType, authorId, ownerId, confidenceLabel,
              supportState, verificationRuleId, validFrom, reviewAfter, expiresAt,
              supersedesItemId, supersededByItemId, version, createdAt, updatedAt
            ) VALUES (
              :id, :roomId, :workspaceId, :kind, :title, :statement, :status, :scope, :pinned,
              :applicability, :authorType, :authorId, :ownerId, :confidenceLabel,
              :supportState, :verificationRuleId, :validFrom, :reviewAfter, :expiresAt,
              :supersedesItemId, :supersededByItemId, :version, :createdAt, :updatedAt
            )
          `).run({
            id: item.id,
            roomId: item.roomId,
            workspaceId: item.workspaceId || null,
            kind: item.kind,
            title: item.title,
            statement: item.statement,
            status: item.status,
            scope: item.scope || 'room',
            pinned: item.pinned ? 1 : 0,
            applicability: applicabilityJson,
            authorType: item.authorType || null,
            authorId: item.authorId || null,
            ownerId: item.ownerId || null,
            confidenceLabel: item.confidenceLabel || null,
            supportState: item.supportState || 'available',
            verificationRuleId: item.verificationRuleId || null,
            validFrom: item.validFrom || null,
            reviewAfter: item.reviewAfter || null,
            expiresAt: item.expiresAt || null,
            supersedesItemId: item.supersedesItemId || null,
            supersededByItemId: item.supersededByItemId || null,
            version: item.version,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt
          });
        }

        for (const revision of revisions) {
          rawDb.prepare(`
            INSERT INTO memory_item_revisions (
              id, itemId, version, title, statement, status, actorId, reason, createdAt
            ) VALUES (
              :id, :itemId, :version, :title, :statement, :status, :actorId, :reason, :createdAt
            )
          `).run(revision);
        }

        // Insert connections
        for (const conn of connections) {
          rawDb.prepare(`
            INSERT INTO memory_connections (sourceId, targetId, relationship, createdAt)
            VALUES (:sourceId, :targetId, :relationship, :createdAt)
            ON CONFLICT(sourceId, targetId, relationship) DO UPDATE SET
              createdAt = excluded.createdAt
          `).run({
            sourceId: conn.sourceId,
            targetId: conn.targetId,
            relationship: conn.relationship,
            createdAt: conn.createdAt
          });
        }

        // Insert sources
        for (const src of sources) {
          rawDb.prepare(`
            INSERT INTO memory_sources (
              itemId, sourceType, sourceId, sourceRevision, sourceHash, excerpt,
              supportRole, supportState, supportChangedAt, supportChangeReason
            ) VALUES (
              :itemId, :sourceType, :sourceId, :sourceRevision, :sourceHash, :excerpt,
              :supportRole, :supportState, :supportChangedAt, :supportChangeReason
            )
          `).run({
            itemId: src.itemId,
            sourceType: src.sourceType,
            sourceId: src.sourceId,
            sourceRevision: src.sourceRevision || null,
            sourceHash: src.sourceHash || null,
            excerpt: src.excerpt || null,
            supportRole: src.supportRole || 'required',
            supportState: src.supportState || 'available',
            supportChangedAt: src.supportChangedAt || null,
            supportChangeReason: src.supportChangeReason || null
          });
        }
      } else if (type === 'all') {
        const unknownTables = Object.keys(data).filter((table) => !ALL_TABLES.includes(table));
        if (unknownTables.length) throw new Error(`Backup contains unsupported tables: ${unknownTables.join(', ')}`);
        for (const table of ALL_TABLES) {
          if (!Array.isArray(data[table])) throw new Error(`Full backup is missing table ${table}`);
        }

        // Clear children first, including tables that were empty in the backup,
        // so restore is an exact snapshot rather than a stale-row merge.
        for (const table of [...ALL_TABLES].reverse()) {
          rawDb.prepare(`DELETE FROM ${table}`).run();
        }

        for (const table of ALL_TABLES) {
          const rows = data[table];
          const allowedColumns = new Set(rawDb.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));

          for (const row of rows) {
            const columns = Object.keys(row);
            if (columns.length === 0) continue;
            const unknownColumns = columns.filter((column) => !allowedColumns.has(column));
            if (unknownColumns.length) {
              throw new Error(`Backup table ${table} contains unsupported columns: ${unknownColumns.join(', ')}`);
            }

            const placeholders = columns.map(col => `:${col}`).join(', ');
            const colList = columns.join(', ');

            const params = {};
            for (const col of columns) {
              const val = row[col];
              if (val !== null && typeof val === 'object') {
                params[col] = JSON.stringify(val);
              } else {
                params[col] = val;
              }
            }

            rawDb.prepare(`
              INSERT INTO ${table} (${colList})
              VALUES (${placeholders})
            `).run(params);
          }
        }
      }

      const integrity = rawDb.prepare('PRAGMA integrity_check').get();
      if (integrity?.integrity_check !== 'ok') throw new Error('Restored database failed integrity_check');
      return { success: true, type };
    });
  }
}
