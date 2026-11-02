import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail } from './store.js';
import { MigrationIngress } from './migration-ingress.js';
import { replayUnifiedIngress } from './migration-live-ingress.js';
import { migrationFriendRequest } from './migration-friend-request.js';

// Only a previously accepted, account-bound cutover can reopen this route.
// The current login selects the installation; it cannot attest a legacy snapshot.
export function openCutoverInbox({ store, account, file, assertOwner, verifyPrivate, excluded, wakeAllowed }) {
  const batches = store.db.prepare('SELECT * FROM migration_imports').all();
  const st = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
  if (!batches.length && !st) return null;
  const batch = batches.find(b => b.account === account);
  if (!batch || !st || !st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || excluded(file) !== true) throw fail('MIGRATION_SOURCE_CHANGED');
  if (batch.phase !== 'ready') throw fail('MIGRATION_PENDING');
  const decision = JSON.parse(store.db.prepare("SELECT payload FROM migration_preserved WHERE account=? AND category='cutover'").get(account)?.payload ?? 'null');
  if (!decision?.provenance || decision.account !== account || decision.snapshotId !== batch.snapshot || decision.route !== 'unified') throw fail('MIGRATION_SOURCE_CHANGED');
  if (!verifyPrivate(path.dirname(file)) || !verifyPrivate(file)) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  const guard = () => {
    assertOwner();
    const disk = fs.lstatSync(file, { bigint: true });
    if (disk.dev !== st.dev || disk.ino !== st.ino || disk.nlink !== 1n || !disk.isFile()) throw fail('MIGRATION_SOURCE_CHANGED');
    return true;
  };
  guard();
  // Never initialize an empty/wrong replacement file as a new journal.
  const probe = new DatabaseSync(file, { readOnly: true });
  try {
    if (probe.prepare('PRAGMA application_id').get().application_id !== 0x51514d49) throw fail('MIGRATION_SOURCE_CHANGED');
  } finally { probe.close(); }
  const current = { account, sourceAccount: account, epoch: decision.epoch, provenance: decision.provenance };
  const journal = new MigrationIngress({ file, assertExclusive: guard, verifyPrivate });
  const options = { journal, store, current, wakeAllowed };
  let pending = true;
  function replay() {
    guard();
    if (pending) pending = replayUnifiedIngress(options).pending > 0;
    return pending;
  }
  try { replay(); } catch (error) { journal.close(); throw error; }
  function persist(event) {
    journal.append(current, event);
    pending = true; replay();
  }
  return { replay, close: () => journal.close(),
    ingest({ key, sourceId, kind = 'message', at, payload }) {
      guard();
      if (key === 'qzone') {
        const mapped = store.db.prepare("SELECT * FROM migration_sources WHERE account=? AND scene='qzone' AND source_id=?").get(account, sourceId);
        const prior = mapped && JSON.parse(mapped.payload);
        if (prior?.payload?.originalUnavailable === true) {
          const { originalUnavailable, ...preview } = prior.payload;
          // Recollection of an identical archived preview is not a new
          // event or evidence of a complete original. Preserve the read flag.
          if (prior.sourceId !== sourceId || prior.kind !== kind || prior.at !== at || !isDeepStrictEqual(preview, JSON.parse(JSON.stringify(payload)))) throw fail('MIGRATION_CONFLICT');
          if (mapped.event_seq !== null) {
            const stored = store.db.prepare("SELECT * FROM events WHERE seq=? AND account=? AND scene='qzone' AND kind=? AND source_id=?")
              .get(mapped.event_seq, account, kind, sourceId);
            if (!stored || stored.at !== at || !isDeepStrictEqual(JSON.parse(stored.payload), prior.payload)) throw fail('MIGRATION_CONFLICT');
          }
          return;
        }
      }
      persist({ account, scene: key, sourceId, kind, at, payload });
    },
    friendRequest(event) {
      const row = { scene: 'private:' + event.user_id, at: Number(event.time) * 1000, payload: JSON.stringify(event) };
      const { id } = migrationFriendRequest(account, row);
      persist({ account, scene: row.scene, sourceId: id, kind: 'friend-request', at: row.at, payload: event });
      return { id, status: store.db.prepare('SELECT status FROM friend_requests WHERE account=? AND id=?').get(account, id)?.status ?? 'queued' };
    },
  };
}
