import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedActions } from '../src/unified/actions.js';

function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
async function fixture(t, options = {}) {
  const store = new UnifiedStore(options.file); t.after(() => store.close());
  const ctx = { account: '100', ownerQQ: '200', identityEpoch: 1, peakEnabled: false };
  store.account('100'); store.db.prepare("UPDATE accounts SET session_id='main-1' WHERE account='100'").run();
  const scenes = new UnifiedScenes({ store, getContext: () => ctx, isAllowed: () => true });
  const cap = await scenes.join('group:1'), sent = [];
  const handlers = { send: { scope: 'scene', level: 'v1', prepare: async ({ payload }) => payload,
    dispatch: async input => { sent.push(input); return { status: 'succeeded', result: { messageId: 'm1' } }; } } };
  const actions = new UnifiedActions({ store, scenes, handlers });
  const request = { callId: 'call-1', operation: 'send', capability: cap.capability, payload: { text: 'fixture' } };
  return { store, scenes, ctx, handlers, sent, actions, request, run: () => actions.run(request) };
}
test('successful retry returns original receipt and never repeats the write', async t => {
  const f = await fixture(t);
  const result = await f.run(); assert.equal(result.status, 'succeeded');
  assert.deepEqual(await f.run(), result); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].target, 'group:1'); assert.equal(f.sent[0].callId, 'call-1');
});
test('same call ID with changed message/target/operation is rejected', async t => {
  const f = await fixture(t); await f.run();
  await assert.rejects(f.actions.run({ ...f.request, payload: { text: 'different' } }), { code: 'ACTION_ID_CONFLICT' });
  const cap = await f.scenes.join('group:2');
  await assert.rejects(f.actions.run({ ...f.request, capability: cap.capability }), { code: 'ACTION_ID_CONFLICT' });
  assert.equal(f.sent.length, 1);
});
test('JSON property ordering does not turn an exact retry into a different action', async t => {
  const f = await fixture(t); f.request.payload = { a: 1, b: 2 }; await f.run();
  f.request.payload = { b: 2, a: 1 }; assert.equal((await f.run()).status, 'succeeded'); assert.equal(f.sent.length, 1);
});
test('concurrent retries during preparation or dispatch do not duplicate effects', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.handlers.send.prepare = async () => { entered.resolve(); await gate.promise; return {}; };
  const pending = f.run(); await entered.promise;
  assert.equal((await f.run()).status, 'preparing'); gate.resolve(); await pending;
  assert.equal(f.sent.length, 1);
});
test('preparation refusal is deferred and can safely retry before any write', async t => {
  const f = await fixture(t); f.handlers.send.prepare = async () => { throw new Error('audit refusal'); };
  await assert.rejects(f.run()); assert.equal(f.sent.length, 0);
  f.handlers.send.prepare = async ({ payload }) => payload;
  assert.equal((await f.run()).status, 'succeeded'); assert.equal(f.sent.length, 1);
});
for (const [label, change, code] of [
  ['pause', f => f.scenes.setPaused(true), 'PAUSED'],
  ['scene switch', async f => f.scenes.join('group:2'), 'STALE_SCENE'],
  ['runtime identity', f => f.ctx.identityEpoch++, 'IDENTITY_CHANGED'],
  ['main session', f => f.store.db.prepare("UPDATE accounts SET session_id='other'").run(), 'IDENTITY_CHANGED'],
]) test(`${label} during preparation prevents dispatch`, async t => {
  const f = await fixture(t);
  f.handlers.send.prepare = async ({ payload }) => { await change(f); return payload; };
  await assert.rejects(f.run(), { code }); assert.equal(f.sent.length, 0);
});
test('v2 relationships and v3 file handlers work from menu only while enabled by level', async t => {
  const f = await fixture(t); await f.scenes.quit();
  f.handlers.files = { ...f.handlers.send, scope: 'global', level: 'v3' };
  f.handlers.friends = { ...f.handlers.send, scope: 'global', level: 'v2' };
  f.scenes.setPermission('v1');
  for (const operation of ['files', 'friends']) await assert.rejects(f.actions.run({ ...f.request, operation }), { code: 'PERMISSION_DENIED' });
  f.scenes.setPermission('v2');
  assert.equal((await f.actions.run({ ...f.request, operation: 'friends' })).status, 'succeeded');
  await assert.rejects(f.actions.run({ ...f.request, callId: 'file-1', operation: 'files' }), { code: 'PERMISSION_DENIED' });
  f.scenes.setPermission('v3');
  assert.equal((await f.actions.run({ ...f.request, callId: 'file-1', operation: 'files' })).status, 'succeeded');
  assert.ok(f.sent.every(row => row.target === null));
});
test('exception after dispatch starts stays unknown and never blindly retries', async t => {
  const f = await fixture(t); let issued = 0;
  f.handlers.send.dispatch = async () => { issued++; throw new Error('response lost'); };
  assert.equal((await f.run()).status, 'unknown');
  assert.equal((await f.run()).status, 'unknown'); assert.equal(issued, 1);
});
test('ambiguous adapter response is unknown; explicit rejection is a retained terminal receipt', async t => {
  const f = await fixture(t);
  f.handlers.send.dispatch = async () => ({ ok: true });
  assert.equal((await f.run()).status, 'unknown');
  f.request.callId = 'call-2'; f.handlers.send.dispatch = async () => ({ status: 'rejected', result: { reason: 'denied' } });
  assert.equal((await f.run()).status, 'rejected');
  f.handlers.send.dispatch = async () => { throw new Error('must not run'); };
  assert.equal((await f.run()).status, 'rejected');
});
test('late write guard detects pause between pieces without redirecting first target', async t => {
  const f = await fixture(t); let issued = 0;
  f.handlers.send.dispatch = async ({ assertCurrent, target }) => {
    assertCurrent(); assert.equal(target, 'group:1'); issued++;
    f.scenes.setPaused(true); assertCurrent(); issued++;
  };
  assert.equal((await f.run()).status, 'unknown'); assert.equal(issued, 1);
});
test('oversized success receipt after write is uncertain, never grounds for a second write', async t => {
  const f = await fixture(t); let issued = 0;
  f.handlers.send.dispatch = async () => { issued++; return { status: 'succeeded', result: 'x'.repeat(40000) }; };
  assert.equal((await f.run()).status, 'unknown'); assert.equal((await f.run()).status, 'unknown'); assert.equal(issued, 1);
});
test('payload is detached before asynchronous preparation', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.handlers.send.prepare = async ({ payload }) => { entered.resolve(); await gate.promise; return payload; };
  const pending = f.run(); await entered.promise; f.request.payload.text = 'mutated'; gate.resolve(); await pending;
  assert.equal(f.sent[0].payload.text, 'fixture');
});
test('durable unknown and dispatching rows survive restart; preparing recovery never unlocks them', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-actions-'));
  const file = path.join(dir, 'ledger.sqlite');
  const f = await fixture(t, { file });
  f.handlers.send.dispatch = async () => { throw new Error('unknown'); }; await f.run();
  // Independent SQLite connection simulates the next runtime inspecting the same ledger.
  const store = new UnifiedStore(file);
  try {
    const actions = new UnifiedActions({ store, scenes: f.scenes, handlers: f.handlers });
    assert.equal(actions.recoverPreparing('100'), 0);
    assert.equal((await actions.run(f.request)).status, 'unknown');
    store.db.prepare("UPDATE actions SET status='dispatching'").run();
    assert.equal(actions.recoverPreparing('100'), 0);
    assert.equal((await actions.run(f.request)).status, 'dispatching');
    store.db.prepare("UPDATE actions SET status='preparing'").run();
    assert.equal(actions.recoverPreparing('100'), 1);
  } finally { store.close(); }
  // Close handles before recursive cleanup (fixture close is registered first).
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});
