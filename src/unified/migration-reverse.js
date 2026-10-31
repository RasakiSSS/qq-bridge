import { accountId, fail } from './store.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

// One-file host commit, under an externally held exclusive/quiesced lease.
// Retain a durable original next to the destination before replacing it. This
// deliberately does not release any ingress barrier or restart the old runtime.
export function writeLegacyQqRollback({ file, expectedBytes, projection, assertExclusive, checkpoint = () => {} }) {
  const check = () => {
    if (typeof assertExclusive !== 'function' || assertExclusive() !== true) throw fail('MIGRATION_EXCLUSIVE_REQUIRED');
  };
  check();
  if (!Buffer.isBuffer(expectedBytes) || !projection?.social || projection.operational !== false) throw fail('MIGRATION_INVALID_SOURCE');
  const target = path.resolve(file);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('MIGRATION_INVALID_SOURCE');
  const expected = hash(expectedBytes);
  const verify = () => {
    check();
    if (hash(fs.readFileSync(target)) !== expected) throw fail('MIGRATION_CONFLICT');
  };
  verify();
  const backup = `${target}.rollback-original-${randomUUID()}`;
  const temporary = `${target}.rollback-next-${randomUUID()}`;
  const next = Buffer.from(JSON.stringify(projection.social));
  const durable = (name, bytes) => {
    const fd = fs.openSync(name, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  try {
    durable(backup, expectedBytes);
    durable(temporary, next);
    if (checkpoint({ phase: 'prepared', backup, temporary })?.then) throw fail('ASYNC_TRANSACTION');
    verify();
    fs.renameSync(temporary, target);
    if (hash(fs.readFileSync(target)) !== hash(next)) throw fail('MIGRATION_WRITE_VERIFY_FAILED');
    return { file: target, backup, beforeHash: expected, afterHash: hash(next), operational: false };
  } finally {
    // Keep the original even on failure; never remove a recovery copy.
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

// Host-only QQ reverse projection. Produces a new document, never overwrites
// the source. Qzone and action evidence stay in the ledger until their adapters
// can restore them; callers must not treat this projection as activation.
export function projectLegacyQqRollback({ store, account, social, assertExclusive }) {
  accountId(account);
  const check = () => {
    if (typeof assertExclusive !== 'function' || assertExclusive() !== true) throw fail('MIGRATION_EXCLUSIVE_REQUIRED');
  };
  check();
  return store.transaction(() => {
    const batch = store.db.prepare('SELECT * FROM migration_imports WHERE account=?').get(account);
    if (!batch) throw fail('MIGRATION_SNAPSHOT_REQUIRED');
    if (!social || typeof social.paused !== 'boolean' || !social.conversations || Array.isArray(social.conversations)) throw fail('MIGRATION_INVALID_SOURCE');
    const result = structuredClone(social);
    const events = store.db.prepare("SELECT e.*,s.legacy_seq FROM events e LEFT JOIN migration_sources s ON s.account=e.account AND s.scene=e.scene AND s.source_id=e.source_id WHERE e.account=? AND e.kind='message' AND e.scene!='qzone' ORDER BY e.seq").all(account);
    let appended = 0, acknowledged = 0;
    for (const event of events) {
      const state = result.conversations[event.scene];
      // New scenes require the bridge's actual default-state factory. Never
      // manufacture partial state that would drop settings on the next save.
      if (!state || !Array.isArray(state.recentMessages) || !Array.isArray(state.unread)
          || !Number.isSafeInteger(state.lastUnreadSeq) || !Number.isSafeInteger(state.lastReadThroughSeq)) throw fail('MIGRATION_REVERSE_SCENE_REQUIRED');
      const candidates = [...state.recentMessages, ...state.unread].filter(row => String(row.messageId ?? '') === event.source_id);
      let row = candidates[0];
      if (candidates.some(item => item.seq !== row.seq || item.text !== row.text)) throw fail('MIGRATION_CONFLICT');
      if (event.legacy_seq > 0) {
        if (!row || row.seq !== event.legacy_seq) throw fail('MIGRATION_CONFLICT');
      } else {
        const payload = JSON.parse(event.payload);
        if (payload.originalUnavailable === true || typeof payload.text !== 'string' || !Number.isSafeInteger(event.at) || event.at <= 0) throw fail('MIGRATION_INVALID_SOURCE');
        const mapped = { ...payload, messageId: event.source_id, userId: payload.senderQQ ?? payload.userId ?? '', time: event.at };
        if (row && Object.keys(mapped).filter(key => key !== 'seq').some(key => canonical(row[key]) !== canonical(mapped[key]))) throw fail('MIGRATION_CONFLICT');
        if (!row) {
          const seq = Math.max(state.lastUnreadSeq, ...state.recentMessages.map(m => m.seq || 0), ...state.unread.map(m => m.seq || 0)) + 1;
          if (!Number.isSafeInteger(seq)) throw fail('MIGRATION_INVALID_SOURCE');
          row = { ...mapped, seq };
          state.recentMessages.push(row);
          state.lastUnreadSeq = seq;
          if (event.unread) state.unread.push(row);
          appended++;
        }
      }
      if (!event.unread) {
        // Exact IDs only. Keep the old contiguous watermark conservative:
        // reading a later message must not acknowledge earlier unread rows.
        const before = state.unread.length;
        state.unread = state.unread.filter(item => !(item.seq === row.seq && String(item.messageId ?? '') === event.source_id));
        acknowledged += before - state.unread.length;
      }
    }
    check();
    return { social: result, snapshotId: batch.snapshot, appended, acknowledged, operational: false };
  });
}
