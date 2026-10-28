import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedDshSession, UnifiedDshEvidence, readDshWorkspaces, recoverDshDispatch } from '../src/unified/dsh-session.js';

const ok = value => ({ result: { ok: true, value } });
function fixture(t) {
  const store = new UnifiedStore(); t.after(() => store.close());
  const ctx = { account: '100', ownerQQ: '200', identityEpoch: 0, peakEnabled: false };
  const scenes = new UnifiedScenes({ store, getContext: () => ctx, isAllowed: () => true });
  store.account('100'); store.db.prepare("UPDATE accounts SET session_id='main-1' WHERE account='100'").run();
  const state = { rows: [], projection: null, workspace: { items: [{ workspaceId: 'shared', sessionIds: [] }], archivedSessionIds: [] }, creates: [] };
  const install = () => {
    state.rows = [{ sessionId: 'main-1', formatStatus: 'current', running: false }];
    state.projection = { kind: 'sequenced', asOfSeq: 0, values: { agentPreset: 'qq-unified', inbox: { 'next-turn': [], 'next-step': [] } } };
    state.workspace.items[0].sessionIds = ['main-1'];
  };
  const api = {
    sessions: {
      list: async () => ok({ items: state.rows }),
      create: async input => { state.creates.push(input); install(); return ok({ sessionId: 'main-1' }); },
    },
    callUnary: async (method, input) => { assert.equal(method, 'session/projections'); assert.equal(input.sessionId, 'main-1'); return ok(state.projection); },
  };
  const make = () => new UnifiedDshSession({ store, scenes, api, workspaceId: 'shared', readWorkspaces: async () => state.workspace });
  const adapter = make(), ensure = () => adapter.ensure({ account: '100', sessionId: 'main-1' });
  return { store, scenes, ctx, state, api, adapter, ensure, make, install };
}
test('create once, verify authoritative preset and shared workspace, reuse same session', async t => {
  const f = fixture(t);
  assert.equal(await f.ensure(), 'main-1'); assert.equal(await f.ensure(), 'main-1');
  assert.deepEqual(f.state.creates, [{ sessionId: 'main-1', workspaceId: 'shared', agentPreset: 'qq-unified' }]);
  assert.equal(f.store.db.prepare('SELECT status FROM session_bindings').get().status, 'bound');
});
test('lost creation response recovers from exact existing identity without second create', async t => {
  const f = fixture(t);
  f.api.sessions.create = async input => { f.state.creates.push(input); f.install(); throw new Error('socket closed'); };
  await assert.rejects(f.ensure());
  assert.equal(await f.make().ensure({ account: '100', sessionId: 'main-1' }), 'main-1');
  assert.equal(f.state.creates.length, 1);
});
test('unknown creation with absent identity stays blocked, including recreated adapter', async t => {
  const f = fixture(t);
  f.api.sessions.create = async input => { f.state.creates.push(input); throw new Error('socket closed'); };
  await assert.rejects(f.ensure());
  await assert.rejects(f.make().ensure({ account: '100', sessionId: 'main-1' }), { code: 'SESSION_CREATION_UNCERTAIN' });
  assert.equal(f.state.creates.length, 1);
});
test('different returned ID is never adopted or blindly recreated', async t => {
  const f = fixture(t); f.api.sessions.create = async () => ok({ sessionId: 'other' });
  await assert.rejects(f.ensure(), { code: 'SESSION_ID_MISMATCH' });
  await assert.rejects(f.ensure(), { code: 'SESSION_CREATION_UNCERTAIN' });
  assert.equal(f.store.account('100').session_id, 'main-1');
});
test('listing failure and absent projection are not a reason to create replacements', async t => {
  const f = fixture(t);
  f.api.sessions.list = async () => ({ result: { ok: false } });
  await assert.rejects(f.ensure(), { code: 'DSH_READ_FAILED' }); assert.equal(f.state.creates.length, 0);
});
for (const [label, mutate, code] of [
  ['cached projection', f => f.state.projection.kind = 'migration-required', 'UNSAFE_MAIN_PRESET'],
  ['wrong preset', f => f.state.projection.values.agentPreset = 'default', 'UNSAFE_MAIN_PRESET'],
  ['missing preset', f => delete f.state.projection.values.agentPreset, 'UNSAFE_MAIN_PRESET'],
  ['helper', f => f.state.rows[0].parentSessionId = 'parent', 'UNSAFE_MAIN_SESSION'],
  ['archived', f => f.state.workspace.archivedSessionIds.push('main-1'), 'SESSION_WORKSPACE_MISMATCH'],
  ['foreign workspace', f => f.state.workspace.items.push({ workspaceId: 'foreign', sessionIds: ['main-1'] }), 'SESSION_WORKSPACE_MISMATCH'],
  ['missing membership', f => f.state.workspace.items[0].sessionIds = [], 'SESSION_WORKSPACE_MISMATCH'],
  ['busy', f => f.state.rows[0].running = true, 'MAIN_SESSION_BUSY'],
  ['queued input', f => f.state.projection.values.inbox['next-turn'].push({ id: 'old' }), 'MAIN_SESSION_BUSY'],
]) test(`reject ${label} without creation or prompt`, async t => {
  const f = fixture(t); f.install(); mutate(f);
  await assert.rejects(f.ensure(), { code }); assert.equal(f.state.creates.length, 0);
});
test('bound but deleted session must not be silently rebuilt', async t => {
  const f = fixture(t); await f.ensure(); f.state.rows = []; f.state.projection = null;
  await assert.rejects(f.ensure(), { code: 'MAIN_SESSION_MISSING' }); assert.equal(f.state.creates.length, 1);
});
test('identity or pause changing across asynchronous inspection prevents creation', async t => {
  const f = fixture(t);
  f.api.sessions.list = async () => { f.ctx.identityEpoch++; return ok({ items: [] }); };
  await assert.rejects(f.ensure(), { code: 'IDENTITY_CHANGED' }); assert.equal(f.state.creates.length, 0);
  f.api.sessions.list = async () => { f.scenes.setPaused(true); return ok({ items: [] }); };
  await assert.rejects(f.ensure(), { code: 'PAUSED' }); assert.equal(f.state.creates.length, 0);
});
test('same adapter serializes concurrent creation', async t => {
  const f = fixture(t); await Promise.all([f.ensure(), f.ensure()]); assert.equal(f.state.creates.length, 1);
});
test('restore mode never creates a missing session and permits monitoring existing busy input', async t => {
  const f = fixture(t);
  const input = { account: '100', sessionId: 'main-1' }, options = { existingOnly: true, allowBusy: true };
  await assert.rejects(f.adapter.ensure(input, options), { code: 'MAIN_SESSION_MISSING' });
  assert.equal(f.state.creates.length, 0);
  f.install(); f.state.rows[0].running = true; f.state.projection.values.inbox['next-turn'].push({ id: 'waiting' });
  assert.equal(await f.adapter.ensure(input, options), 'main-1'); assert.equal(f.state.creates.length, 0);
});
test('two adapters atomically claim creation before network side effects', async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([f.ensure(), f.make().ensure({ account: '100', sessionId: 'main-1' })]);
  assert.equal(f.state.creates.length, 1); assert.ok(results.some(r => r.status === 'fulfilled'));
});

function fakeSocketApi(action) {
  let socket, closed = 0, opens = 0;
  const api = { baseUrl: 'http://127.0.0.1:1234', ensureAuth: async () => 'fixture-cookie' };
  const socketFactory = (url, options) => {
    assert.equal(url.href, 'ws://127.0.0.1:1234/api/remote.mux');
    assert.equal(options.headers.cookie, 'fixture-cookie');
    socket = new EventTarget();
    socket.close = () => { closed++; };
    socket.send = text => { opens++; action(socket, JSON.parse(text)); };
    queueMicrotask(() => socket.dispatchEvent(new Event('open')));
    return socket;
  };
  return { api, socketFactory, get closed() { return closed; }, get opens() { return opens; } };
}
test('fresh workspace stream uses authenticated endpoint and closes after correlated baseline', async () => {
  const baseline = { items: [], archivedSessionIds: [] };
  const f = fakeSocketApi((socket, request) => {
    assert.equal(request.endpoint, 'workspace/follow'); assert.deepEqual(request.payload, { args: {} });
    const send = frame => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
    send({ type: 'item', streamId: 'other', value: { type: 'baseline', value: 'wrong' } });
    send({ type: 'item', streamId: request.streamId, value: { type: 'baseline', value: baseline } });
  });
  assert.deepEqual(await readDshWorkspaces(f.api, { socketFactory: f.socketFactory }), baseline);
  assert.equal(f.closed, 1); assert.equal(f.opens, 1);
});
test('workspace stream errors and aborts fail without echoing server secrets', async () => {
  const f = fakeSocketApi((socket, request) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'error', streamId: request.streamId, error: 'secret' }) })));
  await assert.rejects(readDshWorkspaces(f.api, { socketFactory: f.socketFactory }), { code: 'WORKSPACE_READ_FAILED' });
  assert.equal(f.closed, 1);
  const controller = new AbortController();
  const g = fakeSocketApi(() => controller.abort());
  await assert.rejects(readDshWorkspaces(g.api, { socketFactory: g.socketFactory, signal: controller.signal }), { code: 'WORKSPACE_READ_ABORTED' });
  assert.equal(g.closed, 1);
});
test('native WebSocket sends auth cookie and reads actual loopback mux frames', async t => {
  const server = http.createServer(); const sockets = new Set();
  let receivedCookie, receivedRequest;
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('error', () => {});
    receivedCookie = req.headers.cookie;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let bytes = Buffer.alloc(0), answered = false;
    socket.on('data', chunk => {
      if (answered) return;
      bytes = Buffer.concat([bytes, chunk]); if (bytes.length < 2) return;
      let length = bytes[1] & 127, offset = 2;
      if (length === 126) { if (bytes.length < 4) return; length = bytes.readUInt16BE(2); offset = 4; }
      if (length === 127 || !(bytes[1] & 128)) { socket.destroy(); return; }
      if (bytes.length < offset + 4 + length) return;
      const mask = bytes.subarray(offset, offset + 4), body = Buffer.from(bytes.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
      receivedRequest = JSON.parse(body.toString()); answered = true;
      const data = Buffer.from(JSON.stringify({ type: 'item', streamId: receivedRequest.streamId,
        value: { type: 'baseline', value: { items: [], archivedSessionIds: [] } } }));
      const header = Buffer.alloc(4); header[0] = 129; header[1] = 126; header.writeUInt16BE(data.length, 2);
      socket.write(Buffer.concat([header, data]));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const api = { baseUrl: `http://127.0.0.1:${server.address().port}`, ensureAuth: async () => 'test-cookie=value' };
  assert.deepEqual(await readDshWorkspaces(api), { items: [], archivedSessionIds: [] });
  assert.equal(receivedCookie, 'test-cookie=value');
  assert.equal(receivedRequest.endpoint, 'workspace/follow');
});

function evidenceFixture(t) {
  const f = fixture(t);
  f.store.db.prepare("INSERT INTO dispatches(id,account,session_id,status,created) VALUES('rpc-1','100','main-1','unknown',1)").run();
  return { ...f, evidence: new UnifiedDshEvidence({ store: f.store }), status: () => f.store.dispatch('rpc-1').status };
}
const event = (seq, type, data) => ({ seq, type, data, time: 1 });
const start = (seq = 0, turn = 1) => event(seq, 'turn/start', { turn });
const message = (seq = 1, id = 'rpc-1') => event(seq, 'user/message', { source: { kind: 'user', rpcId: id } });
const end = (seq = 2, turn = 1) => event(seq, 'turn/end', { turn, reason: { kind: 'completed' } });
test('only matching rpcId inside a contiguous turn can release its session dispatch', t => {
  const f = evidenceFixture(t);
  assert.equal(f.evidence.event('main-1', start()), false);
  f.evidence.event('main-1', message()); assert.equal(f.status(), 'accepted');
  assert.equal(f.evidence.event('main-1', end()), true); assert.equal(f.status(), 'completed');
});
for (const [label, records, sid] of [
  ['generic end', [end()], 'main-1'],
  ['other rpc', [start(), message(1, 'other'), end()], 'main-1'],
  ['other session', [start(), message(), end()], 'main-2'],
  ['missing start', [message(), end()], 'main-1'],
  ['wrong turn', [start(), message(), end(2, 2)], 'main-1'],
  ['sequence gap', [start(), message(), end(3)], 'main-1'],
  ['second turn', [start(), message(), start(2, 2), end(3, 2)], 'main-1'],
]) test(`evidence rejects ${label}`, t => {
  const f = evidenceFixture(t);
  for (const e of records) assert.equal(f.evidence.event(sid, e), false);
  assert.notEqual(f.status(), 'completed');
});
test('restart snapshot can reconstruct complete turn, incomplete snapshots keep uncertainty', t => {
  const f = evidenceFixture(t);
  const snapshot = events => ({ records: events.map(e => ({ type: 'event', event: e })) });
  assert.equal(f.evidence.snapshot('main-1', snapshot([message(), end()])), false);
  assert.equal(new UnifiedDshEvidence({ store: f.store }).snapshot('main-1', snapshot([start(), message(), end()])), true);
  assert.equal(f.status(), 'completed');
});
test('a terminal error finishes the attempt without claiming a successful QQ action', t => {
  const f = evidenceFixture(t); f.evidence.event('main-1', start()); f.evidence.event('main-1', message());
  assert.equal(f.evidence.event('main-1', event(2, 'turn/end', { turn: 1, reason: { kind: 'error' } })), true);
  assert.equal(f.status(), 'completed');
});
test('cold recovery pages backward at fixed cut and correlates request without any model call', async t => {
  const f = evidenceFixture(t), calls = [];
  const wrap = events => events.map(event => ({ type: 'event', event }));
  const api = { callUnary: async (method, input) => {
    calls.push({ method, input });
    return ok({ records: wrap([start(), message()]), hasMore: false });
  } };
  const result = await recoverDshDispatch({ store: f.store, api, sessionId: 'main-1',
    snapshot: { cursor: 2, records: wrap([end()]), hasMore: true } });
  assert.equal(result.status, 'completed'); assert.equal(result.pages, 1);
  assert.deepEqual(calls, [{ method: 'session/page', input: { address: { kind: 'session', sessionId: 'main-1' }, throughSeq: 2, beforeSeq: 2, maxMessages: 50 } }]);
});
test('cold recovery rejects gapped/repeated pages and leaves request blocked', async t => {
  const f = evidenceFixture(t), wrap = event => ({ type: 'event', event });
  const api = { callUnary: async () => ok({ records: [wrap(start())], hasMore: false }) };
  await assert.rejects(recoverDshDispatch({ store: f.store, api, sessionId: 'main-1',
    snapshot: { cursor: 2, records: [wrap(end())], hasMore: true } }), { code: 'HISTORY_GAP' });
  assert.equal(f.status(), 'unknown');
});
test('cold recovery does not infer completion when complete history has no matching rpc', async t => {
  const f = evidenceFixture(t);
  const result = await recoverDshDispatch({ store: f.store, api: {}, sessionId: 'main-1',
    snapshot: { cursor: 2, records: [start(), message(1, 'other'), end()].map(event => ({ type: 'event', event })), hasMore: false } });
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'no-matching-terminal');
});
test('schema 1 migration preserves messages, permission, pause and scene', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-migration-'));
  const file = path.join(dir, 'ledger.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = new UnifiedStore(file);
  store.append({ account: '100', scene: 'group:1', sourceId: 'm1', payload: { text: 'keep' } });
  store.db.exec("UPDATE accounts SET permission='v1',paused=1,current_scene='group:1'; DROP TABLE session_bindings; DROP TABLE actions; DROP TABLE permission_audit; DROP TABLE runtime_owners; PRAGMA user_version=1;");
  store.close(); store = new UnifiedStore(file);
  try {
    assert.equal(store.account('100').permission, 'v1'); assert.equal(store.account('100').paused, 1);
    assert.equal(store.account('100').current_scene, 'group:1'); assert.equal(store.counts('100')[0].unread, 1);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  } finally { store.close(); }
});
