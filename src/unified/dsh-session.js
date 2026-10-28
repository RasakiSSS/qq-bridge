import { fail } from './store.js';
import { randomUUID } from 'node:crypto';

// A one-shot fresh baseline. No long-lived listener or changes to legacy mux.
export async function readDshWorkspaces(api, { signal, timeoutMs = 10000, socketFactory = (url, options) => new WebSocket(url, options) } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail('INVALID_TIMEOUT');
  const deadline = AbortSignal.timeout(timeoutMs);
  const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const cookie = await api.ensureAuth(abortSignal);
  abortSignal.throwIfAborted();
  const url = new URL('/api/remote.mux', api.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('INVALID_DSH_URL');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = socketFactory(url, { headers: { cookie } });
  const streamId = randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, baseline) => {
      if (settled) return;
      settled = true;
      abortSignal.removeEventListener('abort', abort);
      for (const [name, handler] of [['open', open], ['message', message], ['error', failed], ['close', failed]]) socket.removeEventListener(name, handler);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(baseline);
    };
    const abort = () => finish(fail('WORKSPACE_READ_ABORTED'));
    const failed = () => finish(fail('WORKSPACE_READ_FAILED'));
    const open = () => {
      try { socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} } })); }
      catch { failed(); }
    };
    const message = event => {
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 4194304) return failed();
        const frame = JSON.parse(event.data);
        if (frame.streamId !== streamId) return;
        if (frame.type === 'error' || frame.type === 'end') return failed();
        if (frame.type === 'item' && frame.value?.type === 'baseline') finish(null, frame.value.value);
      } catch { failed(); }
    };
    for (const [name, handler] of [['open', open], ['message', message], ['error', failed], ['close', failed]]) socket.addEventListener(name, handler);
    abortSignal.addEventListener('abort', abort, { once: true });
    if (abortSignal.aborted) abort();
  });
}

function value(response) {
  if (response?.result?.ok !== true) throw fail('DSH_READ_FAILED');
  return response.result.value;
}

// Host adapter only. readWorkspaces must obtain a fresh authoritative
// workspace/follow baseline, not a caller supplied workspace or cached UI list.
// The live bridge transport and main preset are mounted in a later phase.
export class UnifiedDshSession {
  #tail = Promise.resolve();
  constructor({ store, scenes, api, workspaceId, readWorkspaces = () => readDshWorkspaces(api) }) {
    if (typeof workspaceId !== 'string' || !workspaceId) throw fail('INVALID_WORKSPACE');
    this.store = store; this.scenes = scenes; this.api = api;
    this.workspaceId = workspaceId; this.readWorkspaces = readWorkspaces;
  }
  ensure(input, { existingOnly = false, allowBusy = false } = {}) {
    const requested = this.scenes.context();
    const result = this.#tail.then(() => this.#ensure(input, requested, { existingOnly, allowBusy }));
    this.#tail = result.catch(() => {});
    return result;
  }
  async #ensure({ account, sessionId }, requested, { existingOnly, allowBusy }) {
    const workspaceId = this.workspaceId, preset = 'qq-unified';
    const check = () => {
      const ctx = this.scenes.context();
      this.scenes.active(ctx);
      if (ctx.account !== account || ctx.account !== requested.account || ctx.ownerQQ !== requested.ownerQQ
        || ctx.identityEpoch !== requested.identityEpoch || this.workspaceId !== workspaceId
        || this.store.account(account).session_id !== sessionId) throw fail('IDENTITY_CHANGED');
    };
    check();
    if (typeof sessionId !== 'string' || !sessionId) throw fail('INVALID_SESSION');
    // This intent survives missing create responses. The scheduler has already
    // persisted the session ID; this adapter never chooses a replacement ID.
    const binding = this.store.transaction(() => {
      this.store.db.prepare(`INSERT OR IGNORE INTO session_bindings(account,session_id,workspace_id,preset,status)
        VALUES(?,?,?,?,'creating')`).run(account, sessionId, workspaceId, preset);
      const row = this.store.db.prepare('SELECT * FROM session_bindings WHERE account=?').get(account);
      if (!row || row.session_id !== sessionId || row.workspace_id !== workspaceId || row.preset !== preset) throw fail('SESSION_BINDING_MISMATCH');
      return row;
    });
    const inspect = async () => {
      const list = value(await this.api.sessions.list({})); check();
      if (!Array.isArray(list?.items) || list.hasMore === true) throw fail('INVALID_SESSION_LIST');
      const matches = list.items.filter(row => row.sessionId === sessionId);
      if (matches.length > 1) throw fail('INVALID_SESSION_LIST');
      const projection = value(await this.api.callUnary('session/projections', { sessionId })); check();
      return { row: matches[0], projection };
    };
    let state = await inspect();
    if (!state.row) {
      if (existingOnly) throw fail('MAIN_SESSION_MISSING');
      // A previously bound identity disappearing is not permission to reset it.
      if (binding.status === 'bound' || state.projection !== null) throw fail('MAIN_SESSION_MISSING');
      if (binding.create_attempted) throw fail('SESSION_CREATION_UNCERTAIN');
      const workspaces = await this.readWorkspaces(); check();
      this.#workspace(workspaces, sessionId, false);
      const claimed = this.store.db.prepare("UPDATE session_bindings SET create_attempted=1 WHERE account=? AND create_attempted=0 AND status='creating'").run(account);
      if (claimed.changes !== 1) throw fail('SESSION_CREATION_UNCERTAIN');
      const created = value(await this.api.sessions.create({ sessionId, workspaceId, agentPreset: preset })); check();
      if (created?.sessionId !== sessionId) throw fail('SESSION_ID_MISMATCH');
      state = await inspect();
    }
    const { row, projection } = state;
    if (!row || row.parentSessionId || row.origin === 'subagent' || row.formatStatus !== 'current') throw fail('UNSAFE_MAIN_SESSION');
    // List projections may be cached; only the exact current unary projection
    // can establish the preset. Missing/migration hints fail closed.
    if (projection?.kind !== 'sequenced' || !Number.isSafeInteger(projection.asOfSeq)
      || projection.asOfSeq < -1 || projection.values?.agentPreset !== preset) throw fail('UNSAFE_MAIN_PRESET');
    const workspaces = await this.readWorkspaces(); check();
    this.#workspace(workspaces, sessionId, true);
    if (!allowBusy && row.running === true) throw fail('MAIN_SESSION_BUSY');
    const inbox = projection.values.inbox;
    if (!inbox || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) throw fail('INVALID_MAIN_INBOX');
    if (!allowBusy && (inbox['next-turn'].length || inbox['next-step'].length)) throw fail('MAIN_SESSION_BUSY');
    this.store.db.prepare("UPDATE session_bindings SET status='bound' WHERE account=?").run(account);
    return sessionId;
  }
  #workspace(baseline, sessionId, requireMember) {
    if (!Array.isArray(baseline?.items) || !Array.isArray(baseline.archivedSessionIds)
      || baseline.items.some(row => !Array.isArray(row.sessionIds))) throw fail('INVALID_WORKSPACE_BASELINE');
    const target = baseline.items.filter(row => row.workspaceId === this.workspaceId);
    const owners = baseline.items.filter(row => row.sessionIds.includes(sessionId));
    if (target.length !== 1 || baseline.archivedSessionIds.includes(sessionId)
      || owners.some(row => row.workspaceId !== this.workspaceId) || owners.length > 1
      || (requireMember && owners.length !== 1)) throw fail('SESSION_WORKSPACE_MISMATCH');
  }
}

// Events must come from the authenticated DSH follow/page source. This parser
// never treats timestamps, assistant text or a generic turn/end as completion.
// Incomplete history/gaps deliberately leave the durable dispatch blocked.
export class UnifiedDshEvidence {
  #streams = new Map();
  constructor({ store }) { this.store = store; }
  reset(sessionId) { this.#streams.delete(sessionId); }
  event(sessionId, event) {
    if (!this.store.db.prepare('SELECT 1 FROM accounts WHERE session_id=?').get(sessionId)) return false;
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0) { this.reset(sessionId); return false; }
    let stream = this.#streams.get(sessionId);
    if (stream && event.seq <= stream.seq) return false;
    if (!stream || event.seq !== stream.seq + 1) stream = { seq: event.seq, turn: null, requests: new Set() };
    stream.seq = event.seq;
    this.#streams.set(sessionId, stream);
    const data = event.data;
    if (event.type === 'turn/start') {
      stream.turn = Number.isSafeInteger(data?.turn) && data.turn >= 0 ? data.turn : null;
      stream.requests.clear();
    } else if (event.type === 'user/message' && stream.turn !== null && data?.source?.kind === 'user') {
      const id = data.source.rpcId;
      const dispatch = typeof id === 'string' ? this.store.dispatch(id) : null;
      if (dispatch?.session_id === sessionId && ['dispatching', 'accepted', 'unknown'].includes(dispatch.status)) {
        this.store.confirm(id, sessionId, 'accepted'); stream.requests.add(id);
      }
    } else if (event.type === 'turn/end') {
      let confirmed = false;
      if (stream.turn !== null && data?.turn === stream.turn) {
        for (const id of stream.requests) {
          this.store.confirm(id, sessionId, 'completed'); confirmed = true;
        }
      }
      stream.turn = null; stream.requests.clear();
      return confirmed;
    }
    return false;
  }
  snapshot(sessionId, snapshot) {
    this.reset(sessionId);
    if (!Array.isArray(snapshot?.records)) return false;
    let confirmed = false;
    for (const record of snapshot.records) {
      if (record?.type !== 'event') { this.reset(sessionId); continue; }
      confirmed = this.event(sessionId, record.event) || confirmed;
    }
    return confirmed;
  }
}

// Non-activating cold recovery. Read older pages at the SAME snapshot cut and
// retain only protocol evidence, never message/tool bodies. Live observations
// use a different parser, so paging cannot rewind their stream cursor.
export async function recoverDshDispatch({ store, api, sessionId, snapshot, maxPages = 32, signal, evidence = new UnifiedDshEvidence({ store }) }) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 128) throw fail('INVALID_RECOVERY_BUDGET');
  const row = store.db.prepare("SELECT * FROM dispatches WHERE session_id=? AND status IN ('dispatching','accepted','unknown')").get(sessionId);
  if (!row) return { status: 'idle', pages: 0 };
  const cursor = snapshot?.cursor;
  if (!Number.isSafeInteger(cursor) || cursor < -1) throw fail('INVALID_HISTORY_SNAPSHOT');
  const compact = (page, before) => {
    if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean' || page.records.length > 50000) throw fail('INVALID_HISTORY_PAGE');
    let previous;
    const result = page.records.map(record => {
      const event = record?.type === 'event' ? record.event : null;
      if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq >= before
        || (previous !== undefined && event.seq !== previous + 1)) throw fail('INVALID_HISTORY_PAGE');
      previous = event.seq;
      return { type: 'event', event: { seq: event.seq, type: event.type,
        data: event.type === 'user/message' ? { source: { kind: event.data?.source?.kind, rpcId: event.data?.source?.rpcId } }
          : { turn: event.data?.turn } } };
    });
    if (result.length && result.at(-1).event.seq !== before - 1) throw fail('HISTORY_GAP');
    if (!result.length && (page.hasMore || before > 0)) throw fail('HISTORY_GAP');
    return result;
  };
  let records = compact(snapshot, cursor + 1), hasMore = snapshot.hasMore, pages = 0;
  const hasRequestStart = () => {
    let turn = false;
    for (const { event } of records) {
      if (event.type === 'turn/start') turn = true;
      else if (event.type === 'turn/end') turn = false;
      else if (event.type === 'user/message' && turn && event.data.source.kind === 'user' && event.data.source.rpcId === row.id) return true;
    }
    return false;
  };
  while (!hasRequestStart() && hasMore && pages < maxPages && records.length < 50000) {
    signal?.throwIfAborted();
    const beforeSeq = records[0]?.event.seq;
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq <= 0) throw fail('INVALID_HISTORY_PAGE');
    const page = value(await api.callUnary('session/page', {
      address: { kind: 'session', sessionId }, throughSeq: cursor, beforeSeq, maxMessages: 50,
    }, signal));
    signal?.throwIfAborted();
    const older = compact(page, beforeSeq);
    if (records.length + older.length > 50000) return { status: 'unresolved', reason: 'history-budget', pages };
    records = older.concat(records); hasMore = page.hasMore; pages++;
  }
  evidence.snapshot(sessionId, { records });
  const status = store.dispatch(row.id).status;
  return { status, pages, ...(status === 'completed' ? {} : { reason: hasMore && !hasRequestStart() ? 'history-budget' : 'no-matching-terminal' }) };
}
