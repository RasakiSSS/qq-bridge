import { createHash } from 'node:crypto';
import { normalizeFriendRequestEvent } from '../relationship-control.js';
import { fail, json } from './store.js';

// Private friend-request table only: gateway flags never enter model inboxes.
export function migrationFriendRequest(account, row) {
  const payload = JSON.parse(row.payload);
  if (String(payload.self_id) !== account || !Number.isSafeInteger(row.at) || row.at <= 0
    || Number(payload.time) * 1000 !== row.at) throw fail('MIGRATION_INVALID_SOURCE');
  let normalized;
  try { normalized = normalizeFriendRequestEvent(payload, { now: () => row.at }); }
  catch { throw fail('MIGRATION_INVALID_SOURCE'); }
  if (typeof payload.flag !== 'string' || normalized.flag !== payload.flag || row.scene !== `private:${normalized.userId}`) throw fail('MIGRATION_INVALID_SOURCE');
  const id = createHash('sha256').update(JSON.stringify([account, normalized.flag])).digest('hex');
  return { id, normalized };
}
export function verifyMigrationFriendRequest(store, account, row, id) {
  const expected = migrationFriendRequest(account, row);
  const target = store.db.prepare('SELECT payload FROM friend_requests WHERE account=? AND id=?').get(account, id);
  if (!target || id !== expected.id) throw fail('MIGRATION_CONFLICT');
  const value = JSON.parse(target.payload);
  for (const key of ['flag', 'userId', 'subType', 'comment', 'receivedAt']) {
    if (value[key] !== expected.normalized[key]) throw fail('MIGRATION_CONFLICT');
  }
  return true;
}
export function importMigrationFriendRequest(store, account, row) {
  const { id, normalized } = migrationFriendRequest(account, row);
  const existing = store.db.prepare('SELECT 1 FROM friend_requests WHERE account=? AND id=?').get(account, id);
  if (existing) verifyMigrationFriendRequest(store, account, row, id);
  else store.db.prepare("INSERT INTO friend_requests(account,id,payload,status,created) VALUES(?,?,?,'pending',?)")
    .run(account, id, json(normalized, 8192), row.at);
  // Existing accepted/rejected/unknown statuses must never become pending again.
  return id;
}
