import { createHash } from 'node:crypto';
import { accountId, sceneKey, fail, json } from './store.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const natural = value => Number.isSafeInteger(value) && value >= 0;

// Pure, host-only planning; does not open a database, read production files,
// contact QQ/DSH, or authorize applying a migration. Account provenance must be
// supplied by the future quiesced snapshot collector, not inferred from peers.
export function planLegacyQq({ account, snapshotAccount, snapshotId, social, sessions = {}, now = Date.now() }) {
  accountId(account);
  if (snapshotAccount !== account) throw fail('MIGRATION_ACCOUNT_UNVERIFIED');
  if (typeof snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotId)) throw fail('MIGRATION_SNAPSHOT_REQUIRED');
  if (!record(social) || !record(social.conversations) || !record(sessions) || !Number.isFinite(now)) throw fail('MIGRATION_INVALID_SOURCE');
  const scenes = [], blockers = [], warnings = [];
  for (const [key, source] of Object.entries(social.conversations)) {
    sceneKey(key);
    if (key === 'qzone' || !record(source) || !Array.isArray(source.unread) || !Array.isArray(source.recentMessages)
        || !natural(source.lastUnreadSeq) || !natural(source.lastReadThroughSeq)
        || source.lastReadThroughSeq > source.lastUnreadSeq) throw fail('MIGRATION_INVALID_SOURCE');
    const bySeq = new Map(), unread = new Set();
    for (const [list, pending] of [[source.recentMessages, false], [source.unread, true]]) {
      for (const row of list) {
        if (!record(row) || !natural(row.seq) || row.seq === 0 || row.seq > source.lastUnreadSeq
            || typeof row.text !== 'string' || !Number.isFinite(row.time)) throw fail('MIGRATION_INVALID_SOURCE');
        // Legacy persisted text is already a 200-character preview. Never label
        // it as recovered original text or use it to acknowledge missing tails.
        const event = { legacySeq: row.seq, messageId: row.messageId == null ? null : String(row.messageId),
          senderQQ: row.userId == null ? null : String(row.userId), sender: String(row.sender || ''),
          text: row.text, tail: typeof row.tail === 'string' ? row.tail : '',
          at: row.time, isSelf: row.isSelf === true, originalUnavailable: true };
        const existing = bySeq.get(row.seq);
        if (existing && hash(existing) !== hash(event)) blockers.push({ key, seq: row.seq, reason: 'CONFLICTING_COPY' });
        else bySeq.set(row.seq, event);
        if (pending) {
          unread.add(row.seq);
          if (row.seq <= source.lastReadThroughSeq || row.isSelf === true) blockers.push({ key, seq: row.seq, reason: 'UNREAD_CONFLICT' });
        }
      }
    }
    // Source IDs alone can collide across restarted sequences. Check rather
    // than silently choosing a copy; the importer must reconcile live IDs too.
    const ids = new Set();
    const events = [...bySeq.values()].sort((a, b) => a.legacySeq - b.legacySeq).map(row => {
      if (row.messageId && ids.has(row.messageId)) blockers.push({ key, seq: row.legacySeq, reason: 'DUPLICATE_MESSAGE_ID' });
      if (row.messageId) ids.add(row.messageId);
      return { ...row, unread: unread.has(row.legacySeq),
        readState: unread.has(row.legacySeq) ? 'unread' : row.isSelf || row.legacySeq <= source.lastReadThroughSeq ? 'read' : 'unknown',
        sourceId: row.messageId || `legacy:${snapshotId}:${key}:${row.legacySeq}` };
    });
    const wake = source.wakeConfig;
    if (!record(wake)) throw fail('MIGRATION_INVALID_SOURCE');
    const preferences = {};
    for (const name of ['mode', 'infinite', 'sleepUntil', 'triggers']) if (Object.hasOwn(wake, name)) preferences[name] = JSON.parse(json(wake[name], 8192));
    let timer = null;
    if (wake.infinite === false) {
      const dueAt = typeof wake.sleepUntil === 'string' ? Date.parse(wake.sleepUntil) : NaN;
      if (!Number.isFinite(dueAt)) blockers.push({ key, reason: 'INVALID_SLEEP_DEADLINE' });
      else timer = { dueAt, overdue: dueAt <= now, sourceId: `legacy-timer:${hash([account, key, dueAt])}` };
    }
    if (source.lastUnreadSeq > bySeq.size) warnings.push({ key, reason: 'PRUNED_HISTORY_NOT_RECOVERABLE' });
    if (events.length) warnings.push({ key, reason: 'LEGACY_PREVIEWS_REQUIRE_EXPLICIT_SKIP_OR_SOURCE_RECOVERY' });
    if (source.activeTopics?.length || source.pendingThoughts?.length || Object.keys(source.memberImpressions || {}).length)
      warnings.push({ key, reason: 'LOCAL_MEMORY_REQUIRES_EVIDENCE_MAPPING' });
    scenes.push({ key, legacySessionId: typeof sessions[key] === 'string' ? sessions[key] : null,
      legacyReadThroughSeq: source.lastReadThroughSeq, lastLegacySeq: source.lastUnreadSeq,
      preferences, timer, events });
  }
  return { version: 1, account, snapshotId, dryRun: true, applicable: false,
    paused: social.paused === true, scenes, blockers, warnings,
    requires: ['QUIESCED_ACCOUNT_BOUND_SNAPSHOT', 'ATOMIC_IMPORT_LEDGER', 'LIVE_MESSAGE_RECONCILIATION', 'QZONE_READ_MAPPING', 'ROLLBACK_REHEARSAL'] };
}
