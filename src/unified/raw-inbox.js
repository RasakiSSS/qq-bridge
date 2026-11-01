import { migrationFriendRequest } from './migration-friend-request.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { accountId, sceneKey, fail } from './store.js';
import { managementCommandText } from './management.js';

// Host-only gateway spool. Short transactions; no database handle across awaits.
export function createRawInbox({ file, assertAccess, verifyPrivate, hardenFile, deliver, allowed, beforeCommand }) {
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
      db.exec('CREATE TABLE IF NOT EXISTS prepared(seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
      const result = fn(db); db.exec('COMMIT'); return result;
    } finally { db.close(); }
  }
  function capture(key, event, hold) {
    const account = accountId(String(event.self_id)), id = event.message_id ?? event.msg_id ?? event.message_seq;
    const kind = event.message_type;
    if (!['private','group'].includes(kind) || sceneKey(key) !== kind + ':' + (kind === 'private' ? event.user_id : event.group_id)
        || event.post_type !== 'message' || !(typeof id === 'string' && id.trim() || Number.isSafeInteger(id))
        || !Number.isSafeInteger(Number(event.time) * 1000) || Number(event.time) <= 0
        || !(Array.isArray(event.message) || typeof event.message === 'string')) throw fail('INVALID_RAW_EVENT');
    save(account, key, String(id), event, hold);
  }
  function captureFriend(event, hold) {
    const account = accountId(String(event.self_id)), payload = JSON.stringify(event);
    const { id } = migrationFriendRequest(account, { scene: 'private:' + event.user_id,
      payload, at: Number(event.time) * 1000 });
    save(account, 'friend-requests', id, event, hold);
  }
  function save(account, key, id, event, hold) {
    if (hold !== undefined && !/^login:[a-f0-9-]{36}$/.test(hold)) throw fail('INVALID_RAW_EVENT');
    const body = JSON.stringify(event);
    dbCall(db => {
      const stored = db.prepare('SELECT event,status FROM raw WHERE account=? AND scene=? AND source=?').get(account,key,String(id));
      if (stored) {
        const old = JSON.parse(stored.event), incoming = JSON.parse(body);
        if (String(old.user_id) !== String(event.user_id) || Number(old.time) !== Number(event.time)
            || (key === 'friend-requests' && (old.comment !== incoming.comment || old.sub_type !== incoming.sub_type))
            || !isDeepStrictEqual(old.message,incoming.message)) throw fail('RAW_EVENT_CONFLICT');
        if (stored.status.startsWith('login:')) db.prepare('UPDATE raw SET status=? WHERE account=? AND scene=? AND source=?')
          .run(hold ?? 'pending',account,key,String(id));
      } else db.prepare('INSERT INTO raw(account,scene,source,event,status) VALUES(?,?,?,?,?)').run(account,key,String(id),body,hold ?? 'pending');
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
        try {
          if (event.post_type === 'message' && managementCommandText(event) !== null) {
            // Do not consume a command merely because the migration route is not ready.
            if (beforeCommand) await beforeCommand();
            if (!allowed(account, row.scene)) { blocked.add(row.scene); continue; }
            dbCall(db => db.prepare("UPDATE raw SET status='command-started' WHERE seq=?").run(row.seq));
          }
          const prepare = async build => {
            const stored = dbCall(db => db.prepare('SELECT payload FROM prepared WHERE seq=?').get(row.seq));
            if (stored) return JSON.parse(stored.payload);
            const payload = await build();
            dbCall(db => db.prepare('INSERT INTO prepared VALUES(?,?)').run(row.seq, JSON.stringify(payload)));
            return payload;
          };
          await deliver(row.scene, event.message_type, event, prepare);
        }
        catch (error) { firstError ??= error; blocked.add(row.scene); continue; }
        dbCall(db => db.prepare("UPDATE raw SET status='done' WHERE seq=?").run(row.seq));
      }
      if (firstError) throw firstError;
    }).finally(() => { draining = undefined; });
    return draining;
  }
  return { capture, captureFriend, drain,
    observeCapture(account, hold, state, at=Date.now()) {
      accountId(account);
      if (!/^login:[a-f0-9-]{36}$/.test(hold) || !['opened','verified','unverified','failed','closed'].includes(state)
          || !Number.isSafeInteger(at) || at<=0) throw fail('INVALID_RAW_EVENT');
      dbCall(db=>{
        db.exec('CREATE TABLE IF NOT EXISTS capture_windows(account TEXT NOT NULL,generation TEXT PRIMARY KEY,opened INTEGER NOT NULL,verified INTEGER,failed INTEGER,closed INTEGER)');
        if (state==='opened') db.prepare('INSERT INTO capture_windows(account,generation,opened) VALUES(?,?,?)').run(account,hold,at);
        else {
          const column=state==='unverified'?'failed':state;
          if(db.prepare('UPDATE capture_windows SET '+column+'=COALESCE('+column+',?) WHERE account=? AND generation=?').run(at,account,hold).changes!==1) throw fail('INVALID_RAW_EVENT');
        }
      });
    },
    confirmLogin(account, hold) {
      if (!/^login:[a-f0-9-]{36}$/.test(hold)) throw fail('INVALID_RAW_EVENT');
      if (fs.existsSync(file)) dbCall(db => db.prepare("UPDATE raw SET status='pending' WHERE account=? AND status=?").run(account, hold));
      empty.delete(account);
    },
    close() { closing = true; return draining; } };
}
