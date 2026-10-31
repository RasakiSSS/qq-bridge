import { createHash } from 'node:crypto';
import { accountId, sceneKey, fail, json } from './store.js';
import { importMigrationFriendRequest, verifyMigrationFriendRequest } from './migration-friend-request.js';

const hash = value => createHash('sha256').update(json(value)).digest('hex');

// Reconcile only new, exact incoming IDs into a still-fenced isolated target.
// Overlap with a truncated legacy source requires separate original recovery.
// This never activates the account or applies/retries an outgoing action.
export function importMigrationDeltas({ store, stage, account, assertExclusive, checkpoint = () => {} }) {
  accountId(account);
  const check = () => { if (typeof assertExclusive !== 'function' || assertExclusive() !== true) throw fail('MIGRATION_EXCLUSIVE_REQUIRED'); };
  check();
  const input = stage.exportDeltas(account);
  return store.transaction(() => {
    check();
    const batch = store.db.prepare('SELECT snapshot,phase FROM migration_imports WHERE account=?').get(account);
    if (!batch || batch.snapshot !== input.batch.snapshot || input.batch.account !== account) throw fail('MIGRATION_SNAPSHOT_REQUIRED');
    if (batch.phase !== 'staged') throw fail('MIGRATION_NOT_QUIESCED');
    let imported = 0, duplicate = 0;
    for (const row of input.events) {
      sceneKey(row.scene);
      if (!['message', 'qzone-feed', 'qzone-comment', 'friend-request'].includes(row.kind)
          || ((row.kind.startsWith('qzone-')) !== (row.scene === 'qzone'))
          || !Number.isSafeInteger(row.at) || row.at <= 0 || typeof row.source_id !== 'string'
          || !row.source_id || row.source_id.length > 512) throw fail('MIGRATION_DELTA_REQUIRES_RECONCILIATION');
      const payload = JSON.parse(row.payload);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.originalUnavailable === true
          || (row.kind !== 'friend-request' && typeof payload.text !== 'string')) throw fail('MIGRATION_DELTA_REQUIRES_RECONCILIATION');
      const fingerprint = hash([payload, row.at]);
      if (fingerprint !== row.fingerprint) throw fail('MIGRATION_CONFLICT');
      const category = `delta:${hash([row.scene, row.source_id, row.kind])}`;
      const receipt = store.db.prepare('SELECT payload FROM migration_preserved WHERE account=? AND category=?').get(account, category);
      if (receipt) {
        if (JSON.parse(receipt.payload).fingerprint !== fingerprint) throw fail('MIGRATION_CONFLICT');
        if (row.kind === 'friend-request') verifyMigrationFriendRequest(store, account, row, JSON.parse(receipt.payload).requestId);
        duplicate++; continue;
      }
      if (row.kind === 'friend-request') {
        const requestId = importMigrationFriendRequest(store, account, row);
        store.db.prepare('INSERT INTO migration_preserved VALUES(?,?,?)').run(account, category, json({ fingerprint, requestId }));
        if (checkpoint({ phase: 'friend-request', requestId })?.then) throw fail('ASYNC_TRANSACTION');
        imported++; continue;
      }
      if (store.db.prepare('SELECT 1 FROM migration_sources WHERE account=? AND scene=? AND source_id=?').get(account, row.scene, row.source_id)
          || store.db.prepare('SELECT 1 FROM events WHERE account=? AND scene=? AND source_id=?').get(account, row.scene, row.source_id)) throw fail('MIGRATION_DELTA_REQUIRES_RECONCILIATION');
      store.scene(account, row.scene);
      const isSelf = row.kind === 'message' ? payload.isSelf === true : row.kind === 'qzone-feed' && payload.authorQQ === account;
      const seq = Number(store.db.prepare('INSERT INTO events(account,scene,source_id,kind,payload,at,unread,wake,notified) VALUES(?,?,?,?,?,?,?,0,0)')
        .run(account, row.scene, row.source_id, row.kind, row.payload, row.at, Number(!isSelf)).lastInsertRowid);
      store.db.prepare('INSERT INTO migration_sources VALUES(?,?,?,?,?,?,?)')
        .run(account, row.scene, row.source_id, 0, seq, isSelf ? 'read' : 'unread', row.payload);
      store.db.prepare('INSERT INTO migration_preserved VALUES(?,?,?)').run(account, category, json({ fingerprint, seq }));
      if (checkpoint({ phase: 'event', seq })?.then) throw fail('ASYNC_TRANSACTION');
      imported++;
    }
    // Preserve irreversible/unknown outcome evidence, never create send work.
    for (const action of input.actions) {
      const category = `delta-action:${hash(action.id)}`;
      const value = json({ id: action.id, status: action.status });
      const previous = store.db.prepare('SELECT payload FROM migration_preserved WHERE account=? AND category=?').get(account, category);
      if (previous && previous.payload !== value) throw fail('MIGRATION_CONFLICT');
      store.db.prepare('INSERT OR IGNORE INTO migration_preserved VALUES(?,?,?)').run(account, category, value);
    }
    check();
    return { imported, duplicate, actionsPreserved: input.actions.length, phase: 'staged', operational: false };
  });
}
