import { snapshotIdentity } from './migration-snapshot.js';
import { importMigrationDeltas } from './migration-delta.js';
import { fail } from './store.js';
import { projectLegacyQzone } from './migration-qzone.js';
const equivalent = (a, b) => JSON.stringify(a, sortKeys) === JSON.stringify(b, sortKeys);
const sortKeys = (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;

// Host-only cutover commit. The lease must cover legacy writers AND ingress
// routing for the whole synchronous call. No model/console tool exposes this.
// The durable cutover record records the intended recovery target; the journal
// is retained. The host must honor it and route subsequent arrivals to unified.
export function activateStagedMigration({ store, stage, journal, handle, lease, now = Date.now() }) {
  const identity = snapshotIdentity(handle), account = identity.account;
  const check = () => {
    const current = lease?.assert();
    if (!current || current.then || current.quiesced !== true) throw fail('MIGRATION_NOT_QUIESCED');
    if (current.account !== account || current.sourceAccount !== account || current.epoch !== identity.epoch
        || current.provenance !== identity.provenance) throw fail('MIGRATION_SOURCE_CHANGED');
    const barrier = journal.assertReady(current);
    if (barrier.snapshot !== handle.snapshotId) throw fail('MIGRATION_DIFFERENT_SNAPSHOT');
    if (journal.db.prepare('SELECT 1 FROM incoming WHERE seq>? LIMIT 1').get(barrier.transferred)) throw fail('MIGRATION_INGRESS_PENDING');
    // Revalidate the entire transferred prefix against its destination.
    journal.transfer(current, stage);
    return barrier;
  };
  if (!Number.isSafeInteger(now) || now <= 0) throw fail('INVALID_CLOCK');
  check();
  const batch = store.db.prepare('SELECT * FROM migration_imports WHERE account=?').get(account);
  if (!batch || batch.snapshot !== handle.snapshotId) throw fail('MIGRATION_DIFFERENT_SNAPSHOT');
  if (batch.phase !== 'staged') throw fail('MIGRATION_ALREADY_ACTIVATED');
  const idle = () => {
    if (store.db.prepare('SELECT 1 FROM runtime_owners WHERE account=? AND owner_id IS NOT NULL').get(account)
      || store.db.prepare("SELECT 1 FROM dispatches WHERE account=? AND status IN ('preparing','dispatching','accepted','unknown')").get(account)
      || store.db.prepare("SELECT 1 FROM actions WHERE account=? AND status IN ('preparing','dispatching','unknown')").get(account)
      || store.db.prepare("SELECT 1 FROM summary_jobs WHERE account=? AND phase IN ('preparing','dispatching','accepted','unknown')").get(account)) throw fail('MIGRATION_NOT_QUIESCED');
  };
  idle();
  const delta = stage.exportDeltas(account);
  if (delta.actions.some(row => row.status === 'unknown')) throw fail('MIGRATION_ACTION_UNRESOLVED');
  importMigrationDeltas({ store, stage, account, assertExclusive: () => { check(); return true; } });
  return store.transaction(() => {
    const barrier = check(); idle();
    const base = stage.exportBaseForImport(account);
    for (const row of base.messages) {
      const mapped = store.db.prepare('SELECT * FROM migration_sources WHERE account=? AND scene=? AND source_id=?').get(account, row.scene, row.source_id);
      if (!mapped || mapped.legacy_seq !== row.legacy_seq || mapped.read_state !== row.read_state || mapped.payload !== row.payload
          || (row.read_state !== 'unknown' && !store.db.prepare('SELECT 1 FROM events WHERE seq=? AND account=? AND scene=? AND source_id=?').get(mapped.event_seq, account, row.scene, row.source_id))) throw fail('MIGRATION_CONFLICT');
      if (mapped.event_seq !== null) {
        const event = store.db.prepare('SELECT * FROM events WHERE seq=?').get(mapped.event_seq), payload = JSON.parse(row.payload);
        if (event.kind !== 'message' || event.at !== payload.at || !equivalent(JSON.parse(event.payload), { ...payload, originalUnavailable: true })) throw fail('MIGRATION_CONFLICT');
      }
    }
    for (const row of delta.events) {
      const event = store.db.prepare('SELECT * FROM events WHERE account=? AND scene=? AND source_id=? AND kind=?').get(account, row.scene, row.source_id, row.kind);
      if (!event || event.at !== row.at || !equivalent(JSON.parse(event.payload), JSON.parse(row.payload))) throw fail('MIGRATION_CONFLICT');
    }
    for (const row of base.preserved) {
      if (store.db.prepare('SELECT payload FROM migration_preserved WHERE account=? AND category=?').get(account, row.category)?.payload !== row.payload) throw fail('MIGRATION_CONFLICT');
    }
    const qzone = base.preserved.find(row => row.category === 'qzone');
    for (const row of projectLegacyQzone(account, qzone ? JSON.parse(qzone.payload) : null)) {
      const mapped = store.db.prepare('SELECT * FROM migration_sources WHERE account=? AND scene=? AND source_id=?').get(account, 'qzone', row.sourceId);
      if (!mapped || mapped.read_state !== row.readState || mapped.payload !== JSON.stringify(row)) throw fail('MIGRATION_CONFLICT');
      if (row.readState !== 'unknown' && row.at !== null) {
        const event = store.db.prepare('SELECT * FROM events WHERE seq=?').get(mapped.event_seq);
        if (!event || event.account !== account || event.scene !== 'qzone' || event.source_id !== row.sourceId
          || event.kind !== row.kind || event.at !== row.at || event.payload !== JSON.stringify(row.payload)) throw fail('MIGRATION_CONFLICT');
      }
    }
    for (const row of base.scenes) {
      const context = JSON.parse(row.payload);
      const preference = store.db.prepare('SELECT preferences FROM scenes WHERE account=? AND scene=?').get(account, row.scene);
      if (!preference || JSON.stringify(JSON.parse(preference.preferences).wakeConfig) !== JSON.stringify(context.preferences)) throw fail('MIGRATION_CONFLICT');
      if (context.timer) {
        const timer = store.db.prepare('SELECT token,due_at FROM wake_timers WHERE account=? AND scene=?').get(account, row.scene);
        if (!timer || timer.token !== context.timer.sourceId || timer.due_at !== context.timer.dueAt) throw fail('MIGRATION_CONFLICT');
      }
    }
    const record = { snapshotId: handle.snapshotId, account, epoch: identity.epoch, ingressThrough: barrier.transferred, at: now, route: 'unified' };
    store.db.prepare('INSERT INTO migration_preserved VALUES(?,?,?)').run(account, 'cutover', JSON.stringify(record));
    store.db.prepare("UPDATE migration_imports SET phase='ready' WHERE account=? AND phase='staged'").run(account);
    // Preserve manual pause. Imported backlog is a wake candidate, still subject
    // to normal scene preferences, peak rules and the shared scheduler.
    store.db.prepare('UPDATE accounts SET paused=? WHERE account=?').run(batch.source_paused, account);
    store.db.prepare('UPDATE events SET wake=1 WHERE account=? AND unread=1').run(account);
    check();
    return { phase: 'ready', paused: !!batch.source_paused, ...record };
  });
}
