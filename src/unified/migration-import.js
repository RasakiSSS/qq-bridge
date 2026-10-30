import { accountId, sceneKey, fail, json } from './store.js';
import { projectLegacyQzone } from './migration-qzone.js';

// Host-only offline import. Must not be exposed to model tools or run against an
// active installation. The source staging database and old files remain intact.
export function importStagedMigration({ store, stage, account, assertExclusive, now = Date.now(), checkpoint = () => {} }) {
  accountId(account);
  const check = () => { if (typeof assertExclusive !== 'function' || assertExclusive() !== true) throw fail('MIGRATION_EXCLUSIVE_REQUIRED'); };
  check();
  const input = stage.exportForImport(account);
  if (input.batch.account !== account || !/^[a-f0-9]{64}$/.test(input.batch.snapshot)) throw fail('MIGRATION_ACCOUNT_UNVERIFIED');
  if (!Number.isSafeInteger(now)) throw fail('INVALID_CLOCK');
  return store.transaction(() => {
    check();
    const existing = store.db.prepare('SELECT snapshot,phase FROM migration_imports WHERE account=?').get(account);
    if (existing) {
      if (existing.snapshot !== input.batch.snapshot) throw fail('MIGRATION_DIFFERENT_SNAPSHOT');
      return { status: 'already-imported', phase: existing.phase, snapshotId: existing.snapshot };
    }
    // No merge into a used ledger, including a runtime that has merely claimed
    // ownership. Live cutover reconciliation requires a separate explicit step.
    if (store.db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) throw fail('MIGRATION_TARGET_NOT_EMPTY');
    store.account(account);
    store.db.prepare('UPDATE accounts SET paused=1 WHERE account=?').run(account);
    store.db.prepare("INSERT INTO migration_imports VALUES(?,?,'staged',?,?)").run(account, input.batch.snapshot, input.batch.source_paused, now);
    const preserve = (category, payload) => store.db.prepare('INSERT INTO migration_preserved VALUES(?,?,?)').run(account, category, payload);
    for (const row of input.scenes) {
      sceneKey(row.scene); store.scene(account, row.scene);
      const context = JSON.parse(row.payload);
      store.db.prepare('UPDATE scenes SET preferences=? WHERE account=? AND scene=?').run(json({ wakeConfig: context.preferences }, 8192), account, row.scene);
      preserve(`scene:${row.scene}`, row.payload);
      if (context.timer) {
        if (!Number.isSafeInteger(context.timer.dueAt) || typeof context.timer.sourceId !== 'string') throw fail('MIGRATION_INVALID_SOURCE');
        store.db.prepare('INSERT INTO wake_timers(account,scene,token,due_at) VALUES(?,?,?,?)')
          .run(account, row.scene, context.timer.sourceId, context.timer.dueAt);
      }
    }
    for (const row of input.messages) {
      sceneKey(row.scene);
      const source = JSON.parse(row.payload);
      if (!['read', 'unread', 'unknown'].includes(row.read_state) || !Number.isSafeInteger(source.at)
          || row.source_id.length > 512 || !row.source_id) throw fail('MIGRATION_INVALID_SOURCE');
      let eventSeq = null;
      // Uncertain history is preserved for review, never guessed into either
      // read or unread and never advertised as new live input.
      if (row.read_state !== 'unknown') {
        const payload = { ...source, originalUnavailable: true };
        eventSeq = Number(store.db.prepare("INSERT INTO events(account,scene,source_id,kind,payload,at,unread,wake,notified) VALUES(?,?,?,'message',?,?,?,0,0)")
          .run(account, row.scene, row.source_id, json(payload), source.at, Number(row.read_state === 'unread')).lastInsertRowid);
      }
      store.db.prepare('INSERT INTO migration_sources VALUES(?,?,?,?,?,?,?)')
        .run(account, row.scene, row.source_id, row.legacy_seq, eventSeq, row.read_state, row.payload);
      if (checkpoint({ phase: 'message', key: row.scene, sourceId: row.source_id })?.then) throw fail('ASYNC_TRANSACTION');
    }
    for (const row of input.preserved) preserve(row.category, row.payload);
    const qzone = input.preserved.find(row => row.category === 'qzone');
    const projected = projectLegacyQzone(account, qzone ? JSON.parse(qzone.payload) : null);
    if (projected.length) store.scene(account, 'qzone');
    for (const row of projected) {
      let seq = null;
      if (row.readState !== 'unknown' && row.at !== null) {
        seq = Number(store.db.prepare('INSERT INTO events(account,scene,source_id,kind,payload,at,unread,wake,notified) VALUES(?,?,?,?,?,?,?,0,0)')
          .run(account, 'qzone', row.sourceId, row.kind, json(row.payload), row.at, Number(row.readState === 'unread')).lastInsertRowid);
      }
      // Qzone has stable keys, no legacy QQ sequence. Zero explicitly means
      // not applicable; reverse mapping must use the exact source key.
      store.db.prepare('INSERT INTO migration_sources VALUES(?,?,?,?,?,?,?)')
        .run(account, 'qzone', row.sourceId, 0, seq, row.readState, json(row));
    }
    check();
    return { status: 'imported', phase: 'staged', operational: false, snapshotId: input.batch.snapshot, messages: input.messages.length };
  });
}
