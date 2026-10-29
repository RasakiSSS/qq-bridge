// Internal storage for the opt-in unified runtime. No production singleton.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const APPLICATION_ID = 0x51515541;
export const fail = (code, message = code) => Object.assign(new Error(message), { code });
export function accountId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw fail('INVALID_ACCOUNT');
  return value;
}
export function sceneKey(value) {
  if (typeof value !== 'string' || !/^(?:qzone|(?:group|private):[1-9]\d{0,19})$/.test(value)) throw fail('INVALID_SCENE');
  return value;
}
export function json(value, maxBytes = 131072) {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > maxBytes) throw fail('INPUT_TOO_LARGE');
  return encoded;
}

export class UnifiedStore {
  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      const id = this.db.prepare('PRAGMA application_id').get().application_id;
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if ((id !== 0 && id !== APPLICATION_ID) || (id === 0 && (tables.length || version !== 0))
          || (id === APPLICATION_ID && ![1, 2, 3, 4].includes(version))) throw fail('INVALID_STORE', '账本身份或版本不匹配，保留原文件');
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
      if (id === 0) this.transaction(() => this.db.exec(`
        CREATE TABLE accounts (
          account TEXT PRIMARY KEY, permission TEXT NOT NULL DEFAULT 'v3' CHECK(permission IN ('v1','v2','v3')),
          paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
          current_scene TEXT, generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0), session_id TEXT,
          retry_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE scenes (
          account TEXT NOT NULL REFERENCES accounts(account), scene TEXT NOT NULL, preferences TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY(account,scene));
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, scene TEXT NOT NULL,
          source_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL,
          unread INTEGER NOT NULL DEFAULT 1, wake INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0,
          UNIQUE(account,scene,source_id,kind), FOREIGN KEY(account,scene) REFERENCES scenes(account,scene));
        CREATE INDEX events_unread ON events(account,scene,unread,seq);
        CREATE INDEX events_wake ON events(account,notified,wake,seq);
        CREATE TABLE receipts (
          id TEXT PRIMARY KEY, account TEXT NOT NULL, scene TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('skip','read','summary')),
          status TEXT NOT NULL CHECK(status IN ('pending','ready','delivered','acked')),
          result TEXT, created INTEGER NOT NULL,
          FOREIGN KEY(account,scene) REFERENCES scenes(account,scene));
        CREATE TABLE receipt_events (
          receipt TEXT NOT NULL REFERENCES receipts(id), seq INTEGER NOT NULL REFERENCES events(seq),
          covered INTEGER NOT NULL DEFAULT 0 CHECK(covered IN (0,1)),
          PRIMARY KEY(receipt,seq));
        CREATE TABLE dispatches (
          id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(account), session_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('preparing','dispatching','accepted','unknown','completed','rejected','deferred')),
          content TEXT, created INTEGER NOT NULL);
        CREATE UNIQUE INDEX one_active_dispatch ON dispatches(account)
          WHERE status IN ('preparing','dispatching','accepted','unknown');
        CREATE TABLE dispatch_events (
          dispatch TEXT NOT NULL REFERENCES dispatches(id), seq INTEGER NOT NULL REFERENCES events(seq),
          PRIMARY KEY(dispatch,seq));
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
      `));
      // Opening a known version must validate its shape rather than silently recreate tables.
      this.db.prepare('SELECT permission,paused,current_scene,generation,session_id,retry_at,failures FROM accounts LIMIT 0').all();
      this.db.prepare('SELECT unread,wake,notified FROM events LIMIT 0').all();
      this.db.prepare('SELECT status,content FROM dispatches LIMIT 0').all();
      this.db.prepare(`SELECT r.status,r.result,re.covered,s.preferences,de.seq FROM receipts r
        JOIN receipt_events re ON re.receipt=r.id JOIN scenes s ON s.account=r.account AND s.scene=r.scene
        JOIN dispatch_events de ON de.seq=re.seq LIMIT 0`).all();
      // Additive migration: never reset existing inboxes, permissions or sessions.
      if (version < 2) this.transaction(() => this.db.exec(`
        CREATE TABLE session_bindings (
          account TEXT PRIMARY KEY REFERENCES accounts(account), session_id TEXT NOT NULL UNIQUE,
          workspace_id TEXT NOT NULL, preset TEXT NOT NULL,
          create_attempted INTEGER NOT NULL DEFAULT 0 CHECK(create_attempted IN (0,1)),
          status TEXT NOT NULL CHECK(status IN ('creating','bound')));
        CREATE TABLE actions (
          account TEXT NOT NULL REFERENCES accounts(account), session_id TEXT NOT NULL, call_id TEXT NOT NULL,
          operation TEXT NOT NULL, target TEXT, fingerprint TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('preparing','dispatching','unknown','succeeded','rejected','deferred')),
          result TEXT, created INTEGER NOT NULL,
          PRIMARY KEY(account,session_id,call_id));
        CREATE TABLE permission_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL REFERENCES accounts(account),
          before_level TEXT NOT NULL, after_level TEXT NOT NULL, source TEXT NOT NULL,
          at INTEGER NOT NULL);
        CREATE TABLE runtime_owners (
          account TEXT PRIMARY KEY REFERENCES accounts(account), owner_id TEXT,
          pid INTEGER, host TEXT, generation INTEGER NOT NULL);
        PRAGMA user_version=2;
      `));
      this.db.prepare('SELECT account,session_id,workspace_id,preset,status,create_attempted FROM session_bindings LIMIT 0').all();
      this.db.prepare('SELECT account,session_id,call_id,operation,target,fingerprint,status,result,created FROM actions LIMIT 0').all();
      this.db.prepare('SELECT account,before_level,after_level,source,at FROM permission_audit LIMIT 0').all();
      this.db.prepare('SELECT account,owner_id,pid,host,generation FROM runtime_owners LIMIT 0').all();
      if (version < 3) this.transaction(() => this.db.exec(`
        CREATE TABLE attention_waits (
          account TEXT PRIMARY KEY REFERENCES accounts(account), since_seq INTEGER NOT NULL,
          started INTEGER NOT NULL);
        CREATE TABLE wake_timers (
          account TEXT NOT NULL, scene TEXT NOT NULL, token TEXT NOT NULL, due_at INTEGER NOT NULL,
          event_seq INTEGER REFERENCES events(seq),
          PRIMARY KEY(account,scene), FOREIGN KEY(account,scene) REFERENCES scenes(account,scene));
        PRAGMA user_version=3;
      `));
      this.db.prepare('SELECT account,since_seq,started FROM attention_waits LIMIT 0').all();
      this.db.prepare('SELECT account,scene,token,due_at,event_seq FROM wake_timers LIMIT 0').all();
      if (version < 4) this.transaction(() => this.db.exec(`
        CREATE TABLE friend_requests (
          account TEXT NOT NULL REFERENCES accounts(account), id TEXT NOT NULL, payload TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','failed','unknown')),
          created INTEGER NOT NULL, PRIMARY KEY(account,id));
        PRAGMA user_version=4;
      `));
      this.db.prepare('SELECT account,id,payload,status,created FROM friend_requests LIMIT 0').all();
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      if (value && typeof value.then === 'function') throw fail('ASYNC_TRANSACTION');
      this.db.exec('COMMIT');
      return value;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  account(account) {
    accountId(account);
    this.db.prepare('INSERT OR IGNORE INTO accounts(account) VALUES(?)').run(account);
    const value = this.db.prepare('SELECT * FROM accounts WHERE account=?').get(account);
    if (value.current_scene !== null) sceneKey(value.current_scene);
    return value;
  }
  scene(account, key) {
    this.account(account); sceneKey(key);
    this.db.prepare('INSERT OR IGNORE INTO scenes(account,scene) VALUES(?,?)').run(account, key);
  }
  append({ account, scene, sourceId, kind = 'message', payload, at = Date.now(), wake = true }) {
    accountId(account); sceneKey(scene);
    if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 512
        || typeof kind !== 'string' || !/^[a-z][a-z0-9:_-]{0,63}$/.test(kind)
        || !Number.isSafeInteger(at) || typeof wake !== 'boolean'
        || payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw fail('INVALID_EVENT');
    const body = json(payload);
    return this.transaction(() => {
      this.scene(account, scene);
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO events(account,scene,source_id,kind,payload,at,wake)
        VALUES(?,?,?,?,?,?,?)`).run(account, scene, sourceId, kind, body, at, Number(wake));
      const event = this.db.prepare('SELECT * FROM events WHERE account=? AND scene=? AND source_id=? AND kind=?')
        .get(account, scene, sourceId, kind);
      return { inserted: inserted.changes === 1, event };
    });
  }
  unread(account, scene, limit = 30) {
    // Full messages, bounded response. A single admitted event always fits;
    // large batches become smaller pages rather than truncating acknowledged data.
    const rows = this.db.prepare('SELECT * FROM events WHERE account=? AND scene=? AND unread=1 ORDER BY seq LIMIT ?').iterate(account, scene, limit);
    const result = []; let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(row.payload) + 128;
      if (bytes + size > 196608) break;
      bytes += size; result.push(row);
    }
    return result;
  }
  counts(account) {
    return this.db.prepare(`SELECT s.scene,COUNT(e.seq) AS unread FROM scenes s LEFT JOIN events e
      ON e.account=s.account AND e.scene=s.scene AND e.unread=1 WHERE s.account=? GROUP BY s.scene ORDER BY s.scene`).all(account);
  }
  receipt(account, scene, kind, events, now, status = 'delivered') {
    const id = randomUUID();
    this.db.prepare('INSERT INTO receipts(id,account,scene,kind,status,created) VALUES(?,?,?,?,?,?)')
      .run(id, account, scene, kind, status, now);
    if (events === null && kind === 'skip') {
      this.db.prepare(`INSERT INTO receipt_events(receipt,seq,covered)
        SELECT ?,seq,1 FROM events WHERE account=? AND scene=? AND unread=1`).run(id, account, scene);
      return id;
    }
    const insert = this.db.prepare(`INSERT INTO receipt_events(receipt,seq,covered)
      SELECT ?,seq,? FROM events WHERE seq=? AND account=? AND scene=?`);
    for (const event of events) {
      if (insert.run(id, Number(kind !== 'summary'), event.seq, account, scene).changes !== 1) throw fail('INVALID_RECEIPT_RANGE');
    }
    return id;
  }
  active(account) {
    return this.db.prepare("SELECT * FROM dispatches WHERE account=? AND status IN ('preparing','dispatching','accepted','unknown')").get(account);
  }
  dispatch(id) { return this.db.prepare('SELECT * FROM dispatches WHERE id=?').get(id); }
  dispatchEvents(id) {
    return this.db.prepare('SELECT e.* FROM events e JOIN dispatch_events d ON d.seq=e.seq WHERE d.dispatch=? ORDER BY e.seq').all(id);
  }
  // A terminal acknowledgement must identify this exact request, never merely a recent turn/end.
  confirm(id, sessionId, outcome) {
    if (!['accepted', 'completed'].includes(outcome)) throw fail('INVALID_CONFIRMATION');
    return this.transaction(() => {
      const row = this.dispatch(id);
      if (!row || row.session_id !== sessionId) throw fail('INVALID_CONFIRMATION');
      if (row.status === 'completed') return row;
      if (!['dispatching', 'accepted', 'unknown'].includes(row.status)) throw fail('INVALID_CONFIRMATION');
      this.db.prepare('UPDATE dispatches SET status=? WHERE id=?').run(outcome, id);
      this.db.prepare('UPDATE accounts SET failures=0,retry_at=0 WHERE account=?').run(row.account);
      this.db.prepare('UPDATE events SET notified=1 WHERE seq IN (SELECT seq FROM dispatch_events WHERE dispatch=?)').run(id);
      if (row.status !== 'accepted') this.db.prepare('DELETE FROM attention_waits WHERE account=? AND started<=?').run(row.account, row.created);
      return this.dispatch(id);
    });
  }
}
