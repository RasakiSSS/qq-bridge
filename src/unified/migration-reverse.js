import { accountId, fail } from './store.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectLegacyQzone } from './migration-qzone.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const assertReverseIdle = (store, account) => {
  if (store.db.prepare('SELECT 1 FROM runtime_owners WHERE account=? AND owner_id IS NOT NULL').get(account)
    || store.db.prepare("SELECT 1 FROM dispatches WHERE account=? AND status IN ('preparing','dispatching','accepted','unknown')").get(account)
    || store.db.prepare("SELECT 1 FROM actions WHERE account=? AND status IN ('preparing','dispatching','unknown')").get(account)
    || store.db.prepare("SELECT 1 FROM summary_jobs WHERE account=? AND phase IN ('preparing','dispatching','accepted','unknown')").get(account)) throw fail('MIGRATION_NOT_QUIESCED');
};

// One-file host commit, under an externally held exclusive/quiesced lease.
// Retain a durable original next to the destination before replacing it. This
// deliberately does not release any ingress barrier or restart the old runtime.
export function writeLegacyQqRollback({ file, expectedBytes, projection, assertExclusive, checkpoint = () => {} }) {
  const check = () => {
    if (typeof assertExclusive !== 'function' || assertExclusive() !== true) throw fail('MIGRATION_EXCLUSIVE_REQUIRED');
  };
  check();
  if (!Buffer.isBuffer(expectedBytes) || !projection?.social || projection.operational !== false) throw fail('MIGRATION_INVALID_SOURCE');
  // The old loader saves these bounded arrays immediately. Refuse rather than
  // write a document which will silently lose rows on its first old-mode load.
  if (Object.values(projection.social.conversations || {}).some(row => row.unread?.length > 100 || row.recentMessages?.length > 200)) throw fail('MIGRATION_LEGACY_CAPACITY_EXCEEDED');
  const target = path.resolve(file);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('MIGRATION_INVALID_SOURCE');
  const expected = hash(expectedBytes);
  const verify = () => {
    check();
    const current = fs.lstatSync(target);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) throw fail('MIGRATION_INVALID_SOURCE');
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
export function projectLegacyQqRollback({ store, account, social, assertExclusive, createScene }) {
  accountId(account);
  const check = () => {
    if (typeof assertExclusive !== 'function' || assertExclusive() !== true) throw fail('MIGRATION_EXCLUSIVE_REQUIRED');
  };
  check();
  return store.transaction(() => {
    assertReverseIdle(store, account);
    const batch = store.db.prepare('SELECT * FROM migration_imports WHERE account=?').get(account);
    if (!batch) throw fail('MIGRATION_SNAPSHOT_REQUIRED');
    if (!social || typeof social.paused !== 'boolean' || !social.conversations || Array.isArray(social.conversations)) throw fail('MIGRATION_INVALID_SOURCE');
    const result = structuredClone(social);
    result.paused = !!store.account(account).paused;
    for (const scene of store.db.prepare("SELECT scene,preferences FROM scenes WHERE account=? AND scene!='qzone'").all(account)) {
      const target = result.conversations[scene.scene], wake = JSON.parse(scene.preferences).wakeConfig;
      if (target && wake) target.wakeConfig = { ...target.wakeConfig, ...wake,
        triggers: { ...target.wakeConfig?.triggers, ...wake.triggers } };
    }
    const events = store.db.prepare("SELECT e.*,s.legacy_seq FROM events e LEFT JOIN migration_sources s ON s.account=e.account AND s.scene=e.scene AND s.source_id=e.source_id WHERE e.account=? AND e.kind='message' AND e.scene!='qzone' ORDER BY e.seq").all(account);
    let appended = 0, acknowledged = 0;
    for (const event of events) {
      let state = result.conversations[event.scene];
      if (!state && typeof createScene === 'function') {
        state = result.conversations[event.scene] = structuredClone(createScene(event.scene));
        const preferences = store.db.prepare('SELECT preferences FROM scenes WHERE account=? AND scene=?').get(account, event.scene);
        const wake = JSON.parse(preferences?.preferences || '{}').wakeConfig;
        if (wake) state.wakeConfig = structuredClone(wake);
      }
      // New scenes require the bridge's actual default-state factory. Never
      // manufacture partial state that would drop settings on the next save.
      if (!state || !Array.isArray(state.recentMessages) || !Array.isArray(state.unread)
          || !Number.isSafeInteger(state.lastUnreadSeq) || !Number.isSafeInteger(state.lastReadThroughSeq)) throw fail('MIGRATION_REVERSE_SCENE_REQUIRED');
      const legacyWithoutId = event.legacy_seq > 0 && event.source_id === `legacy:${batch.snapshot}:${event.scene}:${event.legacy_seq}`;
      const matches = row => legacyWithoutId ? !row.messageId && row.seq === event.legacy_seq : String(row.messageId ?? '') === event.source_id;
      const candidates = [...state.recentMessages, ...state.unread].filter(matches);
      let row = candidates[0];
      if (candidates.some(item => item.seq !== row.seq || item.text !== row.text)) throw fail('MIGRATION_CONFLICT');
      if (event.legacy_seq > 0) {
        const original = JSON.parse(event.payload);
        if (!row || row.seq !== event.legacy_seq || row.text !== original.text || row.time !== event.at) throw fail('MIGRATION_CONFLICT');
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
        state.unread = state.unread.filter(item => !(item.seq === row.seq && matches(item)));
        acknowledged += before - state.unread.length;
      }
    }
    check();
    return { social: result, snapshotId: batch.snapshot, appended, acknowledged, operational: false };
  });
}

// Reverse the account partition only. Posting/reply actions are never replayed;
// their existing write records and uncertain outcomes remain untouched.
export function projectLegacyQzoneRollback({ store, account, qzone, assertExclusive }) {
  accountId(account);
  const check = () => {
    if (typeof assertExclusive !== 'function' || assertExclusive() !== true) throw fail('MIGRATION_EXCLUSIVE_REQUIRED');
  };
  check();
  return store.transaction(() => {
    assertReverseIdle(store, account);
    const batch = store.db.prepare('SELECT snapshot FROM migration_imports WHERE account=?').get(account);
    if (!batch) throw fail('MIGRATION_SNAPSHOT_REQUIRED');
    const source = qzone?.accounts?.[account];
    if (!source) throw fail('MIGRATION_REVERSE_SCENE_REQUIRED');
    const original = new Map(projectLegacyQzone(account, source).map(row => [row.sourceId, row]));
    const result = structuredClone(qzone), data = result.accounts[account];
    data.knownPosts ??= {};
    let appended = 0, acknowledged = 0;
    const rows = store.db.prepare("SELECT * FROM events WHERE account=? AND scene='qzone' ORDER BY seq").all(account);
    for (const event of rows) {
      if (!['qzone-feed', 'qzone-comment'].includes(event.kind)) throw fail('MIGRATION_DELTA_REQUIRES_RECONCILIATION');
      const payload = JSON.parse(event.payload), existing = original.get(event.source_id);
      if (typeof payload.text !== 'string' || !Number.isSafeInteger(event.at) || event.at <= 0) throw fail('MIGRATION_INVALID_SOURCE');
      if (existing && (existing.kind !== event.kind || existing.at !== event.at || existing.payload.text !== payload.text)) throw fail('MIGRATION_CONFLICT');
      if (existing && ['authorQQ', 'ownerQQ', 'media', 'mentions'].some(key => Object.hasOwn(payload, key)
          && canonical(existing.payload[key]) !== canonical(payload[key]))) throw fail('MIGRATION_CONFLICT');
      if (!existing && payload.originalUnavailable === true) throw fail('MIGRATION_CONFLICT');
      if (event.kind === 'qzone-feed') {
        const match = /^post:([1-9]\d{0,19}):(.+)$/.exec(event.source_id);
        if (!match || match[1] !== payload.authorQQ || (payload.tid && payload.tid !== match[2])) throw fail('MIGRATION_CONFLICT');
        const row = existing?.payload ?? { ...payload, key: event.source_id, authorQQ: match[1], tid: match[2], content: payload.text, time: event.at / 1000 };
        if (!existing) {
          data.knownPosts[row.key] = row;
          if (row.authorQQ === account) data.ownPosts.push(row);
          else if (event.unread && !data.seenFeeds.includes(row.key)) data.pendingFeeds.push(row);
          appended++;
        }
        if (!event.unread || row.authorQQ === account) {
          const before = data.pendingFeeds.length;
          data.pendingFeeds = data.pendingFeeds.filter(item => item.key !== row.key);
          acknowledged += before - data.pendingFeeds.length;
          if (!data.seenFeeds.includes(row.key)) data.seenFeeds.push(row.key);
        }
      } else {
        let parts;
        try { parts = JSON.parse(event.source_id); } catch { throw fail('MIGRATION_CONFLICT'); }
        if (!Array.isArray(parts) || parts.length !== 4 || parts.some(p => typeof p !== 'string')
            || JSON.stringify(parts) !== event.source_id || parts[0] !== payload.ownerQQ
            || (payload.tid && payload.tid !== parts[1]) || (payload.commentId && payload.commentId !== parts[3])
            || (payload.parentId !== undefined && payload.parentId !== parts[2])) throw fail('MIGRATION_CONFLICT');
        if (!existing) {
          data.comments[event.source_id] = { ...payload, key: event.source_id, ownerQQ: parts[0], tid: parts[1],
            parentId: parts[2], commentId: parts[3], content: payload.text, time: event.at, status: event.unread ? 'new' : 'read' };
          appended++;
        } else if (!event.unread && data.comments[event.source_id].status === 'new') {
          data.comments[event.source_id].status = 'read'; acknowledged++;
        }
      }
    }
    // The actual old projection validates keys, authors and time units again.
    projectLegacyQzone(account, data);
    check();
    return { qzone: result, snapshotId: batch.snapshot, appended, acknowledged, operational: false };
  });
}
