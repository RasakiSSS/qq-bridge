import { fail } from './store.js';

// Bridge event-loop adapter. No model work until start/tick is explicitly called.
// Ingest can open the durable inbox while DSH is offline or manually paused.
export function createUnifiedBridgeDriver({ createHost, ready, log = () => {}, intervalMs = 1000 }) {
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
    if (closing || !ready()) return Promise.resolve({ status: 'paused' });
    if (ticking) return ticking;
    ticking = (async () => {
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
