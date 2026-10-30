import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { accountId, sceneKey, fail, json } from './store.js';
import { snapshotJson } from './migration-snapshot.js';
import { planLegacyQq } from './migration-plan.js';

const APPLICATION_ID = 0x51514d47;
const digest = value => createHash('sha256').update(json(value, 16 * 1024 * 1024)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// Isolated staging database, deliberately NOT a UnifiedStore. Nothing here can
// activate a runtime, send a message, alter old files or release manual pause.
export class MigrationStage {
  constructor({ file, verifyPrivate }) {
    if (typeof verifyPrivate !== 'function' || verifyPrivate(path.dirname(file)) !== true) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
    for (let directory = path.resolve(path.dirname(file)); ; directory = path.dirname(directory)) {
      const parent = fs.lstatSync(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw fail('MIGRATION_UNSAFE_DIRECTORY');
      if (directory === path.dirname(directory)) break;
    }
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('MIGRATION_UNSAFE_FILE');
    }
    this.db = new DatabaseSync(file);
    try {
      const id = this.db.prepare('PRAGMA application_id').get().application_id;
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if ((id !== 0 && id !== APPLICATION_ID) || (id === 0 && (version || tables.length)) || (id === APPLICATION_ID && version !== 1)) throw fail('INVALID_STORE');
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (!id) this.transaction(() => this.db.exec(`
        CREATE TABLE batches(account TEXT PRIMARY KEY, snapshot TEXT UNIQUE NOT NULL, source_paused INTEGER NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE messages(account TEXT NOT NULL REFERENCES batches(account), scene TEXT NOT NULL, source_id TEXT NOT NULL,
          legacy_seq INTEGER NOT NULL, read_state TEXT NOT NULL CHECK(read_state IN ('read','unread','unknown')), payload TEXT NOT NULL,
          PRIMARY KEY(account,scene,source_id), UNIQUE(account,scene,legacy_seq));
        CREATE TABLE scenes(account TEXT NOT NULL REFERENCES batches(account), scene TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,scene));
        CREATE TABLE preserved(account TEXT NOT NULL REFERENCES batches(account), category TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,category));
        CREATE TABLE delta_events(account TEXT NOT NULL REFERENCES batches(account), scene TEXT NOT NULL, source_id TEXT NOT NULL,
          kind TEXT NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL, at INTEGER NOT NULL,
          PRIMARY KEY(account,scene,source_id,kind));
        CREATE TABLE delta_actions(account TEXT NOT NULL REFERENCES batches(account), id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(account,id));
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
      `));
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); if (result?.then) throw fail('ASYNC_TRANSACTION'); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  importSnapshot(handle, { now = Date.now(), checkpoint = () => {} } = {}) {
    // snapshotJson only accepts the loader's unforgeable, account-attested handle.
    const social = snapshotJson(handle, 'social-v2.json'), sessions = snapshotJson(handle, 'sessions.json');
    if (!object(sessions?.sessions)) throw fail('MIGRATION_INVALID_SOURCE');
    const plan = planLegacyQq({ account: handle.account, snapshotAccount: handle.account,
      snapshotId: handle.snapshotId, social, sessions: sessions.sessions, now });
    if (plan.blockers.length) throw fail('MIGRATION_CONFLICT');
    const qzone = snapshotJson(handle, 'qzone.json');
    if (qzone !== null && (qzone.version !== 1 || !object(qzone.accounts))) throw fail('MIGRATION_INVALID_SOURCE');
    const check = value => { if (checkpoint(value)?.then) throw fail('ASYNC_TRANSACTION'); };
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT snapshot FROM batches WHERE account=?').get(handle.account);
      if (existing) {
        if (existing.snapshot !== handle.snapshotId) throw fail('MIGRATION_DIFFERENT_SNAPSHOT');
        return { status: 'already-staged', snapshotId: handle.snapshotId };
      }
      this.db.prepare('INSERT INTO batches VALUES(?,?,?,?)').run(handle.account, handle.snapshotId, Number(plan.paused), now);
      const insert = this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)');
      for (const scene of plan.scenes) {
        const source = social.conversations[scene.key];
        // Keep non-operational local context and exact preferences; no agent token.
        const context = { legacySessionId: scene.legacySessionId, preferences: scene.preferences, timer: scene.timer,
          legacyReadThroughSeq: scene.legacyReadThroughSeq, lastLegacySeq: scene.lastLegacySeq,
          activeTopics: source.activeTopics ?? [], pendingThoughts: source.pendingThoughts ?? [], memberImpressions: source.memberImpressions ?? {} };
        this.db.prepare('INSERT INTO scenes VALUES(?,?,?)').run(handle.account, scene.key, json(context));
        for (const event of scene.events) {
          const originals = [...source.recentMessages, ...source.unread].filter(row => row.seq === event.legacySeq);
          const extras = row => ({ media: row.media ?? [], forwardIds: row.forwardIds ?? [],
            plain: row.plain ?? '', quoteTargetIsSelf: row.quoteTargetIsSelf === true });
          const extra = extras(originals[0]);
          if (originals.some(row => digest(extras(row)) !== digest(extra))) throw fail('MIGRATION_CONFLICT');
          insert.run(handle.account, scene.key, event.sourceId, event.legacySeq, event.readState, json({ ...event, ...extra }));
          check({ phase: 'message', key: scene.key, seq: event.legacySeq });
        }
      }
      const save = (category, value) => this.db.prepare('INSERT INTO preserved VALUES(?,?,?)').run(handle.account, category, json(value, 16 * 1024 * 1024));
      // Preserve the account partition, including distinct own-post/comment read
      // state and uncertain writes. Do not synthesize acknowledgment or retries.
      save('qzone', qzone?.accounts[handle.account] ?? null);
      save('role', snapshotJson(handle, 'current-role.json'));
      save('initial-prompts', snapshotJson(handle, 'initial-prompts.json'));
      save('session-index', sessions.sessions);
      save('qzone-session-index', snapshotJson(handle, 'qzone-session.json'));
      save('mode', snapshotJson(handle, 'mode.json'));
      save('warnings', plan.warnings);
      check({ phase: 'before-commit' });
      return { status: 'staged', snapshotId: handle.snapshotId, scenes: plan.scenes.length,
        messages: plan.scenes.reduce((total, scene) => total + scene.events.length, 0), operational: false };
    });
  }
  exportForImport(account) {
    accountId(account);
    return this.transaction(() => {
      const batch = this.db.prepare('SELECT * FROM batches WHERE account=?').get(account);
      if (!batch) throw fail('MIGRATION_SNAPSHOT_REQUIRED');
      if (this.db.prepare('SELECT 1 FROM delta_events WHERE account=? LIMIT 1').get(account)
          || this.db.prepare('SELECT 1 FROM delta_actions WHERE account=? LIMIT 1').get(account)) throw fail('MIGRATION_DELTA_REQUIRES_RECONCILIATION');
      return { batch, messages: this.db.prepare('SELECT * FROM messages WHERE account=? ORDER BY scene,legacy_seq').all(account),
        scenes: this.db.prepare('SELECT * FROM scenes WHERE account=? ORDER BY scene').all(account),
        preserved: this.db.prepare('SELECT * FROM preserved WHERE account=? ORDER BY category').all(account) };
    });
  }
  appendDelta(account, event) {
    accountId(account); sceneKey(event?.scene);
    if (typeof event.sourceId !== 'string' || !event.sourceId || event.sourceId.length > 1000
        || typeof event.kind !== 'string' || !event.kind || event.kind.length > 100 || !Number.isSafeInteger(event.at)) throw fail('MIGRATION_INVALID_SOURCE');
    const payload = json(event.payload), fingerprint = digest([event.payload, event.at]);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT fingerprint FROM delta_events WHERE account=? AND scene=? AND source_id=? AND kind=?')
        .get(account, event.scene, event.sourceId, event.kind);
      if (existing) { if (existing.fingerprint !== fingerprint) throw fail('MIGRATION_CONFLICT'); return false; }
      this.db.prepare('INSERT INTO delta_events VALUES(?,?,?,?,?,?,?)').run(account, event.scene, event.sourceId, event.kind, payload, fingerprint, event.at);
      return true;
    });
  }
  action(account, id, status) {
    accountId(account);
    if (typeof id !== 'string' || !id || !['succeeded', 'rejected', 'unknown'].includes(status)) throw fail('MIGRATION_INVALID_SOURCE');
    // Unknown can be resolved only with operator-verified evidence by a future
    // adapter. This archive never upgrades an outcome on its own.
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT status FROM delta_actions WHERE account=? AND id=?').get(account, id);
      if (existing && existing.status !== status) throw fail('MIGRATION_CONFLICT');
      this.db.prepare('INSERT OR IGNORE INTO delta_actions VALUES(?,?,?)').run(account, id, status);
    });
  }
  rollbackPlan(account) {
    accountId(account);
    return this.transaction(() => this._rollbackPlan(account));
  }
  _rollbackPlan(account) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE account=?').get(account);
    if (!batch) throw fail('MIGRATION_SNAPSHOT_REQUIRED');
    const deltas = this.db.prepare('SELECT scene,source_id,kind,payload,at FROM delta_events WHERE account=? ORDER BY at,scene,source_id,kind').all(account);
    const uncertain = this.db.prepare("SELECT id FROM delta_actions WHERE account=? AND status='unknown'").all(account).map(row => row.id);
    const conflicts = [];
    const incoming = [];
    for (const delta of deltas) {
      const base = this.db.prepare('SELECT payload FROM messages WHERE account=? AND scene=? AND source_id=?').get(account, delta.scene, delta.source_id);
      // Legacy text is truncated: equality of a prefix does NOT establish that
      // a new event is the same original message. Require explicit reconciliation.
      if (base) conflicts.push({ key: delta.scene, sourceId: delta.source_id, reason: 'LEGACY_ID_REQUIRES_RECONCILIATION' });
      else incoming.push({ key: delta.scene, sourceId: delta.source_id, kind: delta.kind, payload: JSON.parse(delta.payload), at: delta.at });
    }
    return { dryRun: true, applicable: false, account, snapshotId: batch.snapshot, sourcePaused: !!batch.source_paused,
      incoming, uncertainActionIds: uncertain, conflicts,
      requirements: ['QUIESCE_UNIFIED_RUNTIME', 'MERGE_NOT_OVERWRITE_OLD_STATE', 'RECONCILE_READ_RECEIPTS', 'PRESERVE_ACTION_LEDGER'] };
  }
}
