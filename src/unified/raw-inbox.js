import { migrationFriendRequest } from './migration-friend-request.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { accountId, sceneKey, fail } from './store.js';
import { managementCommandText } from './management.js';

// Host-only gateway spool. Short transactions; no database handle across awaits.
export function createRawInbox({ file, assertAccess, verifyPrivate, hardenFile, deliver, allowed }) {
  let draining, identity, closing = false;
  const empty = new Set();
  function dbCall(fn) {
    assertAccess();
    const parent = path.dirname(file);
    if (path.relative(parent, fs.realpathSync(parent)) !== '') throw fail('UNSAFE_RAW_INBOX');
    if (!identity) {
      if (!verifyPrivate(parent)) throw fail('UNSAFE_RAW_INBOX');
      if (!fs.existsSync(file)) {
        const fd = fs.openSync(file, 'wx', 0o600);
        try { if (!hardenFile(file)?.ok) throw fail('UNSAFE_RAW_INBOX'); } finally { fs.closeSync(fd); }
      }
    }
    for (const name of [file, file + '-journal', file + '-wal', file + '-shm']) {
      const st = fs.lstatSync(name, { throwIfNoEntry: false });
      if (st && (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)) throw fail('UNSAFE_RAW_INBOX');
    }
    const stat = fs.statSync(file, { bigint: true });
    const current = stat.dev + ':' + stat.ino;
    if (identity ? current !== identity : !verifyPrivate(file)) throw fail('UNSAFE_RAW_INBOX');
    identity = current;
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      const id = db.prepare('PRAGMA application_id').get().application_id;
      if (!id && !db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()) {
        db.exec("CREATE TABLE raw(seq INTEGER PRIMARY KEY, account TEXT NOT NULL, scene TEXT NOT NULL, source TEXT NOT NULL, event TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(account,scene,source)); CREATE INDEX raw_pending ON raw(account,status,seq); PRAGMA application_id=1364349528");
      } else if (id !== 1364349528) throw fail('UNSAFE_RAW_INBOX');
      const result = fn(db); db.exec('COMMIT'); return result;
    } finally { db.close(); }
  }
  function capture(key, event) {
    const account = accountId(String(event.self_id)), id = event.message_id ?? event.msg_id ?? event.message_seq;
    const kind = event.message_type;
    if (!['private','group'].includes(kind) || sceneKey(key) !== kind + ':' + (kind === 'private' ? event.user_id : event.group_id)
        || event.post_type !== 'message' || !(typeof id === 'string' && id.trim() || Number.isSafeInteger(id))
        || !Number.isSafeInteger(Number(event.time) * 1000) || Number(event.time) <= 0
        || !(Array.isArray(event.message) || typeof event.message === 'string')) throw fail('INVALID_RAW_EVENT');
    save(account, key, String(id), event);
  }
  function captureFriend(event) {
    const account = accountId(String(event.self_id)), payload = JSON.stringify(event);
    const { id } = migrationFriendRequest(account, { scene: 'private:' + event.user_id,
      payload, at: Number(event.time) * 1000 });
    save(account, 'friend-requests', id, event);
  }
  function save(account, key, id, event) {
    const body = JSON.stringify(event);
    dbCall(db => {
      const stored = db.prepare('SELECT event FROM raw WHERE account=? AND scene=? AND source=?').get(account,key,String(id));
      if (stored) {
        const old = JSON.parse(stored.event), incoming = JSON.parse(body);
        if (String(old.user_id) !== String(event.user_id) || Number(old.time) !== Number(event.time)
            || (key === 'friend-requests' && (old.comment !== incoming.comment || old.sub_type !== incoming.sub_type))
            || !isDeepStrictEqual(old.message,incoming.message)) throw fail('RAW_EVENT_CONFLICT');
      } else db.prepare("INSERT INTO raw(account,scene,source,event,status) VALUES(?,?,?,?,'pending')").run(account,key,String(id),body);
    });
    empty.delete(account);
  }
  function drain(account) {
    if (draining) return draining;
    if (closing || !account || empty.has(account) || !fs.existsSync(file)) return Promise.resolve();
    draining = Promise.resolve().then(async () => {
      const blocked = new Set();
      let firstError;
      for (let i = 0; i < 30 && !closing; i++) {
        // Select the oldest admitted scene; a removed conversation must
        // neither advance its own receipt nor starve still-admitted scenes.
        const row = dbCall(db => {
          const heads = db.prepare("SELECT scene, MIN(seq) AS seq FROM raw WHERE account=? AND status='pending' GROUP BY scene ORDER BY seq").all(account);
          if (!heads.length) empty.add(account);
          const next = heads.find(h => !blocked.has(h.scene) && allowed(account, h.scene));
          return next && db.prepare('SELECT * FROM raw WHERE seq=?').get(next.seq);
        });
        if (!row) break;
        const event = JSON.parse(row.event);
        if (event.post_type === 'message' && managementCommandText(event) !== null) dbCall(db => db.prepare("UPDATE raw SET status='command-started' WHERE seq=?").run(row.seq));
        try { await deliver(row.scene, event.message_type, event); }
        catch (error) { firstError ??= error; blocked.add(row.scene); continue; }
        dbCall(db => db.prepare("UPDATE raw SET status='done' WHERE seq=?").run(row.seq));
      }
      if (firstError) throw firstError;
    }).finally(() => { draining = undefined; });
    return draining;
  }
  return { capture, captureFriend, drain, close() { closing = true; return draining; } };
}
