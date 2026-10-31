import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { accountId, sceneKey, fail, json } from './store.js';
import { snapshotIdentity } from './migration-snapshot.js';

const APPLICATION_ID = 0x51514d49;
function identity(value) {
  accountId(value?.account);
  if (value.sourceAccount !== value.account || typeof value.provenance !== 'string' || !value.provenance
      || typeof value.epoch !== 'string' || !value.epoch) throw fail('MIGRATION_ACCOUNT_UNVERIFIED');
  return { account: value.account, sourceAccount: value.sourceAccount, provenance: value.provenance, epoch: value.epoch };
}
const canonical = (value, depth = 0) => {
  if (depth > 32) throw fail('MIGRATION_INVALID_SOURCE');
  if (Array.isArray(value)) return value.map(v => canonical(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k], depth + 1)]));
  return value;
};

// Private, host-only WAL. Created BEFORE a snapshot exists. No runtime session,
// action replay, deletion, automatic unlock or model-facing access is provided.
export class MigrationIngress {
  constructor({ file, verifyPrivate, assertExclusive }) {
    if (typeof assertExclusive !== 'function') throw fail('MIGRATION_EXCLUSIVE_REQUIRED');
    this.assertExclusive = assertExclusive;
    this.check();
    if (typeof verifyPrivate !== 'function' || verifyPrivate(path.dirname(file)) !== true) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
    for (let current = path.resolve(path.dirname(file)); ; current = path.dirname(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('MIGRATION_UNSAFE_DIRECTORY');
      if (current === path.dirname(current)) break;
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
      if ((id !== 0 && id !== APPLICATION_ID) || (id === 0 && (version || tables.length))
          || (id === APPLICATION_ID && version !== 1)) throw fail('INVALID_STORE');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
      if (!id) this.transaction(() => this.db.exec(`
        CREATE TABLE barrier(id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, snapshot TEXT, transferred INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE incoming(seq INTEGER PRIMARY KEY, scene TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL,
          payload TEXT NOT NULL, at INTEGER NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(scene,source_id,kind));
        CREATE TABLE conflicts(seq INTEGER NOT NULL REFERENCES incoming(seq), fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
          at INTEGER NOT NULL, PRIMARY KEY(seq,fingerprint));
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
      `));
    } catch (error) { this.db.close(); throw error; }
  }
  check() { if (this.assertExclusive() !== true) throw fail('MIGRATION_EXCLUSIVE_REQUIRED'); }
  close() { this.db.close(); }
  transaction(fn) {
    this.check(); this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(); if (result?.then) throw fail('ASYNC_TRANSACTION');
      this.check(); this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  active() { return !!this.db.prepare('SELECT 1 FROM barrier').get(); }
  assertIdentity(current) {
    this.check();
    const expected = json(identity(current));
    const row = this.db.prepare('SELECT * FROM barrier WHERE id=1').get();
    if (!row) throw fail('MIGRATION_BARRIER_REQUIRED');
    if (row.identity !== expected) throw fail('MIGRATION_SOURCE_CHANGED');
    return row;
  }
  assertReady(current) {
    const row = this.assertIdentity(current);
    if (this.db.prepare('SELECT 1 FROM conflicts LIMIT 1').get()) throw fail('MIGRATION_CONFLICT');
    return row;
  }
  begin(current) {
    const encoded = json(identity(current));
    return this.transaction(() => {
      if (this.active()) { this.assertIdentity(current); return false; }
      this.db.prepare('INSERT INTO barrier(id,identity) VALUES(1,?)').run(encoded); return true;
    });
  }
  append(current, event) {
    sceneKey(event?.scene);
    if (event.account !== current.account || typeof event.sourceId !== 'string' || !event.sourceId || event.sourceId.length > 512
        || !['message', 'qzone-feed', 'qzone-comment', 'friend-request'].includes(event.kind)
        || !Number.isSafeInteger(event.at) || event.at <= 0 || !event.payload || typeof event.payload !== 'object'
        || Array.isArray(event.payload) || ((event.kind.startsWith('qzone-')) !== (event.scene === 'qzone'))) throw fail('MIGRATION_INVALID_SOURCE');
    const payload = json(canonical(JSON.parse(json(event.payload))));
    const fingerprint = createHash('sha256').update(json([JSON.parse(payload), event.at])).digest('hex');
    const result = this.transaction(() => {
      this.assertIdentity(current);
      const row = this.db.prepare('SELECT seq,fingerprint FROM incoming WHERE scene=? AND source_id=? AND kind=?').get(event.scene, event.sourceId, event.kind);
      if (row) {
        if (row.fingerprint !== fingerprint) {
          this.db.prepare('INSERT OR IGNORE INTO conflicts VALUES(?,?,?,?)').run(row.seq, fingerprint, payload, event.at);
          return { conflict: true };
        }
        return { seq: row.seq, duplicate: true, durable: true };
      }
      const seq = Number(this.db.prepare('INSERT INTO incoming(scene,source_id,kind,payload,at,fingerprint) VALUES(?,?,?,?,?,?)')
        .run(event.scene, event.sourceId, event.kind, payload, event.at, fingerprint).lastInsertRowid);
      return { seq, duplicate: false, durable: true };
    });
    if (result.conflict) throw fail('MIGRATION_CONFLICT');
    return result;
  }
  bindSnapshot(current, handle) {
    // Also verify authenticity; a matching-looking object is not a snapshot.
    const attested = snapshotIdentity(handle);
    return this.transaction(() => {
      const row = this.assertReady(current);
      if (handle.account !== current.account) throw fail('MIGRATION_ACCOUNT_UNVERIFIED');
      if (attested.epoch !== current.epoch || attested.provenance !== current.provenance) throw fail('MIGRATION_SOURCE_CHANGED');
      if (row.snapshot && row.snapshot !== handle.snapshotId) throw fail('MIGRATION_DIFFERENT_SNAPSHOT');
      this.db.prepare('UPDATE barrier SET snapshot=? WHERE id=1').run(handle.snapshotId);
    });
  }
  transfer(current, stage, { limit = 100, checkpoint = () => {} } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('MIGRATION_INVALID_SOURCE');
    const barrier = this.assertReady(current);
    const batch = stage.db.prepare('SELECT snapshot FROM batches WHERE account=?').get(current.account);
    if (!barrier.snapshot || batch?.snapshot !== barrier.snapshot) throw fail('MIGRATION_SNAPSHOT_REQUIRED');
    // A different staging file may contain the same snapshot but none of the
    // earlier transfers. Never let our cursor silently skip those messages.
    const receipt = stage.db.prepare('SELECT fingerprint FROM delta_events WHERE account=? AND scene=? AND source_id=? AND kind=?');
    for (const done of this.db.prepare('SELECT * FROM incoming WHERE seq<=? ORDER BY seq').iterate(barrier.transferred)) {
      if (receipt.get(current.account, done.scene, done.source_id, done.kind)?.fingerprint !== done.fingerprint) throw fail('MIGRATION_DELTA_REQUIRES_RECONCILIATION');
    }
    const rows = this.db.prepare('SELECT * FROM incoming WHERE seq>? ORDER BY seq LIMIT ?').all(barrier.transferred, limit);
    for (const row of rows) {
      this.assertReady(current);
      stage.appendDelta(current.account, { scene: row.scene, sourceId: row.source_id, kind: row.kind, payload: JSON.parse(row.payload), at: row.at });
      // Destination commits first. A crash before cursor commit retries the
      // exact same source key; stage's dedup makes this safe without 2PC.
      if (checkpoint({ phase: 'destination-committed', seq: row.seq })?.then) throw fail('ASYNC_TRANSACTION');
      this.transaction(() => {
        this.assertReady(current);
        this.db.prepare('UPDATE barrier SET transferred=MAX(transferred,?) WHERE id=1').run(row.seq);
      });
    }
    return { transferred: rows.length, pending: this.db.prepare('SELECT COUNT(*) AS n FROM incoming WHERE seq>(SELECT transferred FROM barrier)').get().n };
  }
}

// Event-loop adapter for a future bridge maintenance route. Every relevant
// legacy writer/dispatch must pass runLegacy, every admitted inbound pass ingest.
// It is intentionally NOT enabled in bridge.js until those call sites are audited.
export function createMigrationBarrier({ journal, currentIdentity, assertLegacyIdle, flushLegacy, replayPersisted, timeoutMs = 30000 }) {
  if (![currentIdentity, assertLegacyIdle, flushLegacy].every(fn => typeof fn === 'function')) throw fail('MIGRATION_HOST_ADAPTER_REQUIRED');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail('MIGRATION_INVALID_TIMEOUT');
  if (replayPersisted !== undefined && typeof replayPersisted !== 'function') throw fail('MIGRATION_HOST_ADAPTER_REQUIRED');
  const running = new Set();
  let acquiring = false;
  function track(operation) {
    // Register before invoking callbacks, even if they re-enter acquire().
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    running.add(promise);
    Promise.resolve().then(operation).then(resolve, reject);
    promise.then(() => running.delete(promise), () => running.delete(promise));
    return promise;
  }
  return {
    runLegacy(operation) {
      if (journal.active()) throw fail('MIGRATION_PENDING');
      return track(operation);
    },
    ingest(event, legacyDelivery) {
      if (journal.active()) {
        const receipt = journal.append(currentIdentity(), event);
        // Persist before any target access. The optional host hook can select
        // ready cutover on restart; failures never route the event to legacy.
        return replayPersisted ? track(async () => ({ ...receipt, replay: await replayPersisted() })) : Promise.resolve(receipt);
      }
      return track(() => legacyDelivery(event));
    },
    async acquire() {
      if (acquiring) throw fail('MIGRATION_LEASE_BUSY');
      acquiring = true;
      const deadline = performance.now() + timeoutMs;
      const remaining = () => {
        const value = deadline - performance.now();
        if (value <= 0) throw fail('MIGRATION_QUIESCE_TIMEOUT');
        return value;
      };
      const wait = async promise => {
        let timer;
        try {
          const value = await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(fail('MIGRATION_QUIESCE_TIMEOUT')), remaining());
          })]);
          remaining(); return value;
        } finally { clearTimeout(timer); }
      };
      try {
        const expected = identity(currentIdentity());
        journal.begin(expected); // Durable routing barrier precedes every await.
        await wait(Promise.all([...running]));
        journal.assertReady(currentIdentity());
        // Timed-out external callbacks remain tracked. A retry must drain them
        // before it can claim quiescence, even if the caller has stopped waiting.
        remaining();
        if (await wait(track(assertLegacyIdle)) !== true) throw fail('LEGACY_SESSION_BUSY');
        journal.assertReady(currentIdentity());
        remaining();
        if (await wait(track(flushLegacy)) !== true) throw fail('MIGRATION_NOT_QUIESCED');
        journal.assertReady(currentIdentity());
        let released = false;
        return {
          assert() {
            if (released || running.size) throw fail('MIGRATION_NOT_QUIESCED');
            journal.assertReady(currentIdentity());
            return { ...expected, quiesced: true };
          },
          release() { if (!released) { released = true; acquiring = false; } },
        };
      } catch (error) { acquiring = false; throw error; }
      // release/failure never clears persisted routing or manual pause. An
      // explicit verified activation/rollback procedure must decide what follows.
    },
  };
}
