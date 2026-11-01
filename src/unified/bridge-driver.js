import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fail } from './store.js';

// Bridge event-loop adapter. No model work until start/tick is explicitly called.
// Ingest can open the durable inbox while DSH is offline or manually paused.
export function createUnifiedBridgeDriver({ createHost, ready, replayPersisted, log = () => {}, intervalMs = 1000 }) {
  let host, opening, ticking, timer, closing = false, closePromise, restored = false, lastErrorAt = -Infinity;
  const report = () => {
    if (Date.now() - lastErrorAt >= 60000) { lastErrorAt = Date.now(); log('[unified] 统一运行暂不可用，消息保留；请检查本机状态，不会退回旧模型调度'); }
  };
  async function ensure() {
    if (closing) throw fail('RUNTIME_CLOSED');
    if (host) return host;
    if (!opening) {
      opening = Promise.resolve().then(createHost).then(value => { host = value; return value; })
        .finally(() => { opening = undefined; });
    }
    return opening;
  }
  function tick() {
    if (closing) return Promise.resolve({ status: 'paused' });
    if (ticking) return ticking;
    ticking = (async () => {
      if (replayPersisted) await replayPersisted();
      if (closing || !ready()) return { status: 'paused' };
      const current = await ensure();
      if (closing || !ready()) return { status: 'paused' };
      if (!restored) { await current.restore(); restored = true; }
      if (closing || !ready()) return { status: 'paused' };
      return current.tick();
    })().finally(() => { ticking = undefined; });
    return ticking;
  }
  return {
    async status() { if (closing) return { ready: false, closing: true }; return host ? host.status() : { ready: false }; },
    async ingest(input) { const current = await ensure(); if (closing) throw fail('RUNTIME_CLOSED'); return current.ingest(input); },
    async replayCutover() { const current = await ensure(); return current.replayCutover(); },
    async wakeConfig(key) { const current = await ensure(); if (closing) throw fail('RUNTIME_CLOSED'); return current.wakeConfig(key); },
    async friendRequest(event) { const current = await ensure(); if (closing) throw fail('RUNTIME_CLOSED'); return current.friendRequest(event); },
    async fromQQ(...args) { const current = await ensure(); if (closing) throw fail('RUNTIME_CLOSED'); return current.fromQQ(...args); },
    async fromConsole(...args) { const current = await ensure(); if (closing) throw fail('RUNTIME_CLOSED'); return current.fromConsole(...args); },
    async onDshFrame(frame) {
      if (closing) return { handled: false };
      // Initial restore/follow can emit its snapshot before tick resolves.
      const current = host || (opening ? await opening : null);
      return current ? current.onDshFrame(frame) : { handled: false };
    },
    tick,
    start() { if (!timer && !closing) { timer = setInterval(() => { void tick().catch(report); }, intervalMs); timer.unref?.(); } },
    close() {
      if (closePromise) return closePromise;
      closing = true; clearInterval(timer);
      closePromise = (async () => {
        if (opening) await opening.catch(() => {});
        // host.close revokes tools before waiting for already-entered work.
        const results = await Promise.allSettled([host?.close(), ticking]);
        if (results[0].status === 'rejected') throw results[0].reason;
      })();
      return closePromise;
    },
  };
}

export async function assertLegacySessionsIdle(api, ids) {
  const unwrap = response => {
    if (response?.result?.ok !== true) throw fail('LEGACY_PREFLIGHT_UNAVAILABLE');
    return response.result.value;
  };
  const list = unwrap(await api.sessions.list({}));
  if (!Array.isArray(list?.items) || list.hasMore === true) throw fail('LEGACY_PREFLIGHT_UNAVAILABLE');
  for (const sessionId of new Set(ids.filter(id => typeof id === 'string' && id))) {
    const rows = list.items.filter(row => row.sessionId === sessionId);
    if (!rows.length) continue;
    if (rows.length !== 1 || rows[0].running !== false) throw fail('LEGACY_SESSION_BUSY');
    const projection = unwrap(await api.callUnary('session/projections', { sessionId }));
    const inbox = projection?.values?.inbox;
    if (projection?.kind !== 'sequenced' || !Array.isArray(inbox?.['next-step']) || !Array.isArray(inbox?.['next-turn'])) throw fail('LEGACY_PREFLIGHT_UNAVAILABLE');
    if (inbox['next-step'].length || inbox['next-turn'].length) throw fail('LEGACY_SESSION_BUSY');
  }
}


// Maintenance has no reliable legacy index of every background model worker.
// Inspect the complete list and reject a changed session set during the scan.
export async function assertInstallationDshIdle(api) {
  const read = async () => {
    const answer = await api.sessions.list({});
    const value = answer?.result?.value;
    if (answer?.result?.ok !== true || !Array.isArray(value?.items) || value.hasMore || value.nextCursor
        || value.items.some(r => typeof r?.sessionId !== 'string' || !r.sessionId || r.running !== false)) throw fail('LEGACY_PREFLIGHT_UNAVAILABLE');
    const ids = value.items.map(r=>r.sessionId).sort();
    if (new Set(ids).size!==ids.length) throw fail('LEGACY_PREFLIGHT_UNAVAILABLE');
    return {answer,ids};
  };
  const first = await read();
  await assertLegacySessionsIdle({sessions:{list:async()=>first.answer},callUnary:(...args)=>api.callUnary(...args)},first.ids);
  if (JSON.stringify(first.ids)!==JSON.stringify((await read()).ids)) throw fail('LEGACY_SESSION_BUSY');
  return true;
}

// Read-only startup fence, before the bridge loads/saves old state. Disabling
// unified configuration is not a rollback transaction and cannot revive legacy.
export function assertMigrationStartup(file, unifiedConfigured, journalFile) {
  const retained = journalFile && fs.lstatSync(journalFile, { throwIfNoEntry: false });
  if (retained && !unifiedConfigured) throw fail('MIGRATION_LEGACY_START_BLOCKED');
  if (!fs.existsSync(file)) {
    if (retained) throw fail('MIGRATION_STARTUP_UNVERIFIED');
    return;
  }
  let db;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('MIGRATION_STARTUP_UNVERIFIED');
    db = new DatabaseSync(file, { readOnly: true });
    if (db.prepare('PRAGMA application_id').get().application_id !== 0x51515541) throw fail('MIGRATION_STARTUP_UNVERIFIED');
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_imports'").get();
    if (!table) {
      if (retained) throw fail('MIGRATION_STARTUP_UNVERIFIED');
      return;
    }
    const batches = db.prepare('SELECT account,snapshot,phase FROM migration_imports').all();
    if (journalFile && batches.length && !retained) throw fail('MIGRATION_STARTUP_UNVERIFIED');
    if (retained && !batches.length) throw fail('MIGRATION_STARTUP_UNVERIFIED');
    for (const batch of batches) {
      if (!['staged', 'ready'].includes(batch.phase)) throw fail('MIGRATION_STARTUP_UNVERIFIED');
      if (!unifiedConfigured) throw fail('MIGRATION_LEGACY_START_BLOCKED', '此安装已有迁移状态，不能通过关闭统一配置启动旧调度；请完成迁移或受控回退');
      if (batch.phase === 'ready') {
        const raw = db.prepare("SELECT payload FROM migration_preserved WHERE account=? AND category='cutover'").get(batch.account);
        const decision = raw && JSON.parse(raw.payload);
        if (!decision || decision.account !== batch.account || decision.snapshotId !== batch.snapshot || decision.route !== 'unified') throw fail('MIGRATION_STARTUP_UNVERIFIED');
        if (retained) {
          if (!retained.isFile() || retained.isSymbolicLink() || retained.nlink !== 1) throw fail('MIGRATION_STARTUP_UNVERIFIED');
          const log = new DatabaseSync(journalFile, { readOnly: true });
          try {
            if (log.prepare("SELECT 1 FROM sqlite_schema WHERE name='installed_base' AND type='table'").get()) {
              const installed = log.prepare('SELECT * FROM installed_base WHERE id=1').get();
              const intent = log.prepare('SELECT * FROM activation_intent WHERE id=1').get();
              const disk = fs.lstatSync(file, { bigint: true });
              if (installed?.phase !== 'published' || installed.snapshot !== batch.snapshot ||
                  installed.file_id !== disk.dev + ':' + disk.ino || intent?.committed !== 1 ||
                  intent.file_id !== installed.file_id || intent.snapshot !== batch.snapshot ||
                  intent.at !== decision.at || intent.through_seq !== decision.ingressThrough) throw fail('MIGRATION_STARTUP_UNVERIFIED');
            }
          } finally { log.close(); }
        }
      }
    }
    return batches.length > 0;
  } catch (error) {
    if (error.code === 'MIGRATION_LEGACY_START_BLOCKED') throw error;
    throw fail('MIGRATION_STARTUP_UNVERIFIED', '统一迁移状态不可验证，已阻止启动；原数据保持不动');
  } finally { db?.close(); }
}
