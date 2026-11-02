import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fail } from './store.js';

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// No expiry-based stealing: a slow but live process must keep its ownership.
// Foreign hosts, reused PIDs and unverifiable process state fail closed.
export class UnifiedOwner {
  #closed = false;
  constructor({ store, account, pid = process.pid, host = os.hostname(), processAlive = alive }) {
    this.store = store; this.account = account; this.id = randomUUID();
    this.generation = store.transaction(() => {
      store.account(account);
      const old = store.db.prepare('SELECT * FROM runtime_owners WHERE account=?').get(account);
      if (old?.owner_id && (old.host !== host || processAlive(old.pid) !== false)) throw fail('RUNTIME_ALREADY_OWNED');
      const generation = (old?.generation ?? 0) + 1;
      store.db.prepare(`INSERT INTO runtime_owners(account,owner_id,pid,host,generation) VALUES(?,?,?,?,?)
        ON CONFLICT(account) DO UPDATE SET owner_id=excluded.owner_id,pid=excluded.pid,host=excluded.host,generation=excluded.generation`)
        .run(account, this.id, pid, host, generation);
      return generation;
    });
  }
  assert() {
    if (this.#closed) throw fail('RUNTIME_NOT_OWNER');
    const row = this.store.db.prepare('SELECT owner_id,generation FROM runtime_owners WHERE account=?').get(this.account);
    if (row?.owner_id !== this.id || row.generation !== this.generation) throw fail('RUNTIME_NOT_OWNER');
  }
  release() {
    if (this.#closed) return;
    this.store.db.prepare('UPDATE runtime_owners SET owner_id=NULL,pid=NULL,host=NULL WHERE account=? AND owner_id=? AND generation=?')
      .run(this.account, this.id, this.generation);
    this.#closed = true;
  }
}
