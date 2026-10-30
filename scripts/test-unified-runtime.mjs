import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnifiedRuntime } from '../src/unified/runtime.js';

const ok = value => ({ result: { ok: true, value } });
function fixture(t, overrides = {}) {
  const ctx = { account: '100', ownerQQ: '200', identityEpoch: 1, enabled: true, peakEnabled: false };
  let rows = [], sid, token, time = Date.parse('2026-10-28T10:00:00+08:00');
  const prompts = [], creates = [], follows = [], binds = [];
  const api = {
    sessions: {
      list: async () => ok({ items: rows }),
      create: async input => { creates.push(input); sid = input.sessionId; rows = [{ sessionId: sid, formatStatus: 'current', running: false }]; return ok({ sessionId: sid }); },
      prompt: async input => { prompts.push(input); return ok({ accepted: true }); },
    },
    callUnary: async method => {
      assert.equal(method, 'session/projections');
      return ok(sid ? { kind: 'sequenced', asOfSeq: 0, values: { agentPreset: 'qq-unified', inbox: { 'next-step': [], 'next-turn': [] } } } : null);
    },
    events: { follow: id => follows.push(id) },
  };
  const runtime = new UnifiedRuntime({ file: ':memory:', getContext: () => ctx, isAllowed: key => key !== 'group:999',
    isWakeAllowed: () => true, api, workspaceId: 'shared',
    readWorkspaces: async () => ({ items: [{ workspaceId: 'shared', sessionIds: sid ? [sid] : [] }], archivedSessionIds: [] }),
    configureModel: async () => true,
    bindMainTools: async input => { token = input.token; binds.push(input); return true; },
    authenticateQQ: async () => false, authenticateConsole: async () => false, now: () => time, ...overrides });
  t.after(() => runtime.close());
  return { runtime, ctx, api, prompts, creates, follows, binds,
    get token() { return token; }, get sid() { return sid; }, advance: ms => time += ms,
    add: (key, id) => runtime.ingest({ key, sourceId: id, payload: { text: id }, at: time }),
    async end(request, turn = 1, base = 0) {
      for (const [type, data] of [['turn/start', { turn }], ['user/message', { source: { kind: 'user', rpcId: request.requestId } }], ['turn/end', { turn }]]) {
        await runtime.onDshFrame({ type: 'session/event', sessionId: request.sessionId, event: { type, data, seq: base++ } });
      }
    },
  };
}
test('composed runtime keeps one main session across scene switches and serial turns', async t => {
  const f = fixture(t); f.add('group:1', 'a'); f.add('private:200', 'b');
  assert.equal((await f.runtime.tick()).status, 'accepted');
  assert.equal(f.creates.length, 1); assert.equal(f.prompts.length, 1);
  const call = (name, args) => f.runtime.tools.call(f.token, name, args);
  await call('qq_join_session', { key: 'group:1' }); await call('qq_quit_session');
  await call('qq_join_session', { key: 'private:200' });
  f.add('group:2', 'c'); await f.runtime.tick(); assert.equal(f.prompts.length, 1);
  await f.end(f.prompts[0]); assert.equal((await f.runtime.tick()).status, 'accepted');
  assert.equal(f.prompts.length, 2); assert.equal(f.prompts[0].sessionId, f.prompts[1].sessionId);
  assert.equal(f.creates.length, 1); assert.equal(f.binds.length, 1);
  assert.ok(!JSON.stringify(f.prompts).includes(f.token));
  assert.equal(f.runtime.store.counts('100').reduce((sum, row) => sum + row.unread, 0), 3);
});

test('durable finite wake resumes the same main session after yield and turn end', async t => {
  const f = fixture(t); f.add('group:1', 'initial'); await f.runtime.tick();
  const call = (name, args, callId = 'wake') => f.runtime.tools.call(f.token, name, args, { sessionId: f.sid, callId });
  const cap = await call('qq_join_session', { key: 'group:1' });
  const read = await call('qq_get_unread_msg', { capability: cap.capability }); await call('qq_mark_read', { receipt: read.receipt });
  await call('qq_set_wake_config', { capability: cap.capability, config: { infinite: false, sleepMs: 1000 } });
  assert.equal((await call('qq_wait_for_events')).status, 'yield');
  await f.end(f.prompts[0]);
  assert.equal(f.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM attention_waits').get().n, 1);
  assert.equal((await f.runtime.tick()).status, 'idle'); f.advance(1000);
  assert.equal((await f.runtime.tick()).status, 'accepted');
  assert.equal(f.creates.length, 1); assert.equal(f.prompts.length, 2);
  assert.equal(JSON.parse(f.prompts[1].content[0].text).messages[0].kind, 'wake-timer');
  assert.equal(f.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM attention_waits').get().n, 0);
  assert.equal(f.runtime.scenes.current().key, 'group:1');
});
test('peak holds normal unread but delivers owner private; later valley recovers the original unread', async t => {
  const f = fixture(t); f.ctx.peakEnabled = true;
  f.add('group:1', 'a'); assert.equal((await f.runtime.tick()).status, 'idle');
  f.add('private:200', 'b'); await f.runtime.tick();
  assert.deepEqual(JSON.parse(f.prompts[0].content[0].text).messages.map(row => row.key), ['private:200']);
  await f.end(f.prompts[0]); f.advance(2 * 60 * 60 * 1000);
  await f.runtime.tick();
  assert.deepEqual(JSON.parse(f.prompts[1].content[0].text).messages.map(row => row.key), ['group:1']);
});
test('pause persists arrivals and prevents model preparation or unauthorized scene ingestion', async t => {
  const f = fixture(t); f.runtime.scenes.setPaused(true); f.add('group:1', 'a');
  assert.equal((await f.runtime.tick()).status, 'paused'); assert.equal(f.creates.length, 0);
  assert.throws(() => f.add('group:999', 'b'), { code: 'SCENE_DENIED' });
  assert.equal(f.runtime.store.counts('100')[0].unread, 1);
});
test('model configuration or tool transport failure prevents prompt', async t => {
  const f = fixture(t, { configureModel: async () => false }); f.add('group:1', 'a');
  assert.equal((await f.runtime.tick()).error, 'MODEL_CONFIGURATION_FAILED'); assert.equal(f.prompts.length, 0);
  const g = fixture(t, { bindMainTools: async () => false }); g.add('group:1', 'a');
  assert.equal((await g.runtime.tick()).error, 'MAIN_TOOLS_NOT_BOUND'); assert.equal(g.prompts.length, 0);
});
test('lost prompt result stays blocked until exact snapshot proof arrives', async t => {
  const f = fixture(t);
  f.api.sessions.prompt = async input => { f.prompts.push(input); throw new Error('lost response'); };
  f.add('group:1', 'a'); assert.equal((await f.runtime.tick()).status, 'unknown');
  f.add('group:2', 'b'); await f.runtime.tick(); assert.equal(f.prompts.length, 1);
  const request = f.prompts[0];
  const records = [['turn/start', { turn: 1 }], ['user/message', { source: { kind: 'user', rpcId: request.requestId } }], ['turn/end', { turn: 1 }]]
    .map(([type, data], seq) => ({ type: 'event', event: { type, data, seq } }));
  const result = await f.runtime.onDshFrame({ type: 'session/snapshot', sessionId: f.sid, snapshot: { cursor: 2, hasMore: false, records } });
  assert.equal(result.handled, true); assert.equal(f.runtime.store.dispatch(request.requestId).status, 'completed');
  await f.runtime.tick(); assert.equal(f.prompts.length, 2); assert.equal(f.creates.length, 1);
});
test('foreign session event cannot complete main request', async t => {
  const f = fixture(t); f.add('group:1', 'a'); await f.runtime.tick();
  assert.deepEqual(await f.runtime.onDshFrame({ type: 'session/event', sessionId: 'helper', event: { seq: 3, type: 'turn/end', data: { turn: 1 } } }), { handled: false });
  assert.equal(f.runtime.store.dispatch(f.prompts[0].requestId).status, 'accepted');
});
test('restore follows an existing in-flight main session without creating or replaying input', async t => {
  const f = fixture(t); f.add('group:1', 'a'); await f.runtime.tick();
  assert.equal((await f.runtime.restore()).status, 'following');
  assert.equal(f.creates.length, 1); assert.equal(f.prompts.length, 1); assert.equal(f.binds.length, 1);
  assert.equal(f.follows.at(-1), f.sid);
});
test('partial snapshot recovery retains turn context for a live terminal queued during paging', async t => {
  const f = fixture(t); f.add('group:1', 'a'); await f.runtime.tick();
  const request = f.prompts[0]; let release; const gate = new Promise(resolve => release = resolve);
  f.api.callUnary = async method => {
    assert.equal(method, 'session/page'); await gate;
    return ok({ records: [{ type: 'event', event: { seq: 0, type: 'turn/start', data: { turn: 1 } } }], hasMore: false });
  };
  const recovery = f.runtime.onDshFrame({ type: 'session/snapshot', sessionId: f.sid,
    snapshot: { cursor: 1, hasMore: true, records: [{ type: 'event', event: { seq: 1, type: 'user/message', data: { source: { kind: 'user', rpcId: request.requestId } } } }] } });
  const terminal = f.runtime.onDshFrame({ type: 'session/event', sessionId: f.sid, event: { seq: 2, type: 'turn/end', data: { turn: 1 } } });
  release(); await recovery;
  assert.equal((await terminal).completed, true);
  assert.equal(f.runtime.store.dispatch(request.requestId).status, 'completed');
});
test('close revokes tool access and rejects future runtime work without remote cancellation', async t => {
  const f = fixture(t); f.add('group:1', 'a'); await f.runtime.tick(); const token = f.token;
  f.runtime.close(); assert.throws(() => f.runtime.tick(), { code: 'RUNTIME_CLOSED' });
  await assert.rejects(f.runtime.tools.call(token, 'qq_get_main_menu'), { code: 'UNAUTHORIZED' });
  assert.equal(f.prompts.length, 1);
});

test('operator status is read-only, works while paused and contains no message payloads', async t => {
  const f = fixture(t); f.add('group:1', 'private-content');
  f.ctx.paused = true;
  const tables = ['accounts', 'scenes', 'events', 'receipts', 'dispatches', 'wake_timers', 'summary_jobs'];
  const snapshot = () => JSON.stringify(tables.map(table => f.runtime.store.db.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  for (let i = 0; i < 3; i++) {
    const status = f.runtime.status();
    assert.equal(status.paused, true); assert.equal(status.counts.unread, 1);
    assert.equal(status.sessionId, null); assert.equal(status.dispatch, 'idle');
    assert.ok(!JSON.stringify(status).includes('private-content'));
  }
  assert.equal(snapshot(), before); assert.equal(f.prompts.length, 0); assert.equal(f.creates.length, 0);
});
