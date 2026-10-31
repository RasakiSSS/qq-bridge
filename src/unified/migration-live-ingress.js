import { createHash } from 'node:crypto';
import { fail } from './store.js';
import { importMigrationFriendRequest, verifyMigrationFriendRequest } from './migration-friend-request.js';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = (payload, at) => createHash('sha256').update(JSON.stringify([canonical(payload), at])).digest('hex');

// Host-only replay after cutover. The durable journal remains the ingress
// authority, including while DSH/runtime is offline. Never routes back to legacy.
export function replayUnifiedIngress({ journal, store, current, wakeAllowed, limit = 100, checkpoint = () => {} }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || typeof wakeAllowed !== 'function') throw fail('MIGRATION_HOST_ADAPTER_REQUIRED');
  const check = () => {
    const barrier = journal.assertReady(current);
    const batch = store.db.prepare('SELECT snapshot,phase FROM migration_imports WHERE account=?').get(current.account);
    const raw = store.db.prepare("SELECT payload FROM migration_preserved WHERE account=? AND category='cutover'").get(current.account);
    if (!batch || batch.phase !== 'ready' || !raw) throw fail('MIGRATION_PENDING');
    const decision = JSON.parse(raw.payload);
    if (batch.snapshot !== barrier.snapshot || decision.snapshotId !== barrier.snapshot || decision.account !== current.account
      || decision.epoch !== current.epoch || decision.route !== 'unified' || !Number.isSafeInteger(decision.ingressThrough)
      || decision.ingressThrough < 0 || barrier.transferred < decision.ingressThrough) throw fail('MIGRATION_SOURCE_CHANGED');
    return { barrier, decision };
  };
  const { barrier, decision } = check();
  const receiptKey = row => `live-ingress:${barrier.snapshot}:${row.seq}`;
  const verify = row => {
    if (fingerprint(JSON.parse(row.payload), row.at) !== row.fingerprint) throw fail('MIGRATION_CONFLICT');
    const receipt = store.db.prepare('SELECT payload FROM migration_preserved WHERE account=? AND category=?').get(current.account, receiptKey(row));
    if (!receipt) return false;
    const data = JSON.parse(receipt.payload);
    if (row.kind === 'friend-request') {
      if (data.fingerprint !== row.fingerprint) throw fail('MIGRATION_CONFLICT');
      return verifyMigrationFriendRequest(store, current.account, row, data.requestId);
    }
    const event = store.db.prepare('SELECT * FROM events WHERE seq=?').get(data.eventSeq);
    if (data.fingerprint !== row.fingerprint || !event || event.account !== current.account || event.scene !== row.scene
      || event.source_id !== row.source_id || event.kind !== row.kind || fingerprint(JSON.parse(event.payload), event.at) !== row.fingerprint) throw fail('MIGRATION_CONFLICT');
    return true;
  };
  // Check committed prefix so a missing/replaced target can never skip arrivals.
  for (const row of journal.db.prepare('SELECT * FROM incoming WHERE seq>? AND seq<=? ORDER BY seq').iterate(decision.ingressThrough, barrier.transferred)) {
    if (!verify(row)) throw fail('MIGRATION_DELTA_REQUIRES_RECONCILIATION');
  }
  const rows = journal.db.prepare('SELECT * FROM incoming WHERE seq>? ORDER BY seq LIMIT ?').all(barrier.transferred, limit);
  let imported = 0, duplicate = 0;
  for (const row of rows) {
    check();
    const inserted = store.transaction(() => {
      check();
      if (verify(row)) return false;
      if (row.kind === 'friend-request') {
        const requestId = importMigrationFriendRequest(store, current.account, row);
        store.db.prepare('INSERT INTO migration_preserved VALUES(?,?,?)').run(current.account, receiptKey(row), JSON.stringify({ requestId, fingerprint: row.fingerprint }));
        check(); return true;
      }
      const payload = JSON.parse(row.payload);
      if (!['message', 'qzone-feed', 'qzone-comment'].includes(row.kind) || typeof payload.text !== 'string'
        || payload.originalUnavailable === true || fingerprint(payload, row.at) !== row.fingerprint) throw fail('MIGRATION_DELTA_REQUIRES_RECONCILIATION');
      // Overlap with a pre-cutover preview requires source recovery, not a guess.
      const previous = store.db.prepare('SELECT 1 FROM events WHERE account=? AND scene=? AND source_id=? AND kind=?')
        .get(current.account, row.scene, row.source_id, row.kind);
      if (previous) throw fail('MIGRATION_DELTA_REQUIRES_RECONCILIATION');
      const wake = wakeAllowed({ ...row, payload });
      if (typeof wake !== 'boolean') throw fail('MIGRATION_INVALID_WAKE');
      const self = row.kind === 'message' ? payload.isSelf === true : row.kind === 'qzone-feed' && payload.authorQQ === current.account;
      store.scene(current.account, row.scene);
      const seq = Number(store.db.prepare('INSERT INTO events(account,scene,source_id,kind,payload,at,unread,wake,notified) VALUES(?,?,?,?,?,?,?,?,0)')
        .run(current.account, row.scene, row.source_id, row.kind, row.payload, row.at, Number(!self), Number(!self && wake)).lastInsertRowid);
      store.db.prepare('INSERT INTO migration_preserved VALUES(?,?,?)')
        .run(current.account, receiptKey(row), JSON.stringify({ eventSeq: seq, fingerprint: row.fingerprint }));
      check(); return true;
    });
    // The target commits before the journal cursor; an interrupted call replays
    // its receipt rather than inserting twice or altering an existing read state.
    if (checkpoint({ phase: 'destination-committed', seq: row.seq })?.then) throw fail('ASYNC_TRANSACTION');
    journal.transaction(() => {
      check();
      journal.db.prepare('UPDATE barrier SET transferred=MAX(transferred,?) WHERE id=1').run(row.seq);
    });
    if (inserted) imported++; else duplicate++;
  }
  return { imported, duplicate, pending: journal.db.prepare('SELECT COUNT(*) AS n FROM incoming WHERE seq>(SELECT transferred FROM barrier)').get().n };
}

// Append succeeds before any target access. A failed replay propagates to the
// host for reporting/retry, but the event itself is already durable.
export function persistUnifiedIngress(options, event) {
  const receipt = options.journal.append(options.current, event);
  return { receipt, replay: replayUnifiedIngress(options) };
}
