import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBuddyRequests, watchBuddyRequests } from '../plugins/qq-friend-probe/friend-requests.cjs';
import { QQ_VERSION, WRAPPER_SHA256, MAJOR_SHA256 } from '../plugins/qq-friend-probe/friend-adapter.cjs';
const uid = 'u_0123456789012345678901';
const event = (type = 0, decided = false) => ({ buddyReqs: [{ friendUid: uid, reqType: type, isDecide: decided, extWords: 'PRIVATE' }] });
function fixture(options = {}) {
  const listeners = new Map(); let calls = 0, next = 0, valid = true;
  const service = {
    addKernelBuddyListener(listener) { const id = String(++next); listeners.set(id, listener); return id; },
    removeKernelBuddyListener(id) { listeners.delete(id); return 'original-return'; },
    getBuddyReq(...args) { calls++; assert.equal(this, service); assert.equal(args.length, 0); return options.query?.() ?? Promise.resolve({ result: 0 }); },
  };
  const originals = { ...service };
  const b = { accountUin: '123456789', qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256, majorSha256: MAJOR_SHA256,
    receiver: service, isCurrent: () => valid };
  const reader = watchBuddyRequests(b, { targetUid: uid, dynamicTargets: options.dynamicTargets, timeoutMs: options.timeoutMs ?? 100, onReady: options.onReady });
  const listener = { onBuddyReqChange(data) { assert.equal(this, listener); return options.callback?.(data) ?? 42; } };
  const originalCallback = listener.onBuddyReqChange;
  return { reader, service, originals, listener, originalCallback, b,
    calls: () => calls, invalidate: () => { valid = false; },
    register: () => service.addKernelBuddyListener(listener), emit: data => listener.onBuddyReqChange(data) };
}
test('client request summary covers both directions, resolved history and unknown states', () => {
  for (const type of [0, 1, 13]) assert.equal(summarizeBuddyRequests(event(type), uid).pending, true);
  for (const type of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) assert.equal(summarizeBuddyRequests(event(type, true), uid).pending, false);
  assert.equal(summarizeBuddyRequests({ buddyReqs: [] }, uid).pending, false);
  assert.equal(summarizeBuddyRequests(event(12), uid).pending, null);
  assert.equal(summarizeBuddyRequests(event(14), uid).pending, null);
  const text = JSON.stringify(summarizeBuddyRequests(event(), uid));
  assert.equal(text.includes('PRIVATE'), false); assert.equal(text.includes(uid), false);
  assert.equal(summarizeBuddyRequests(event(), uid).scope, 'client-request-list');
});

test('production reader scopes each query to its own target and fixed readers reject overrides', async () => {
  const other = 'u_other0123456789', f = fixture({ dynamicTargets: true }); f.register();
  const first = f.reader.read(uid); f.emit(event()); assert.equal((await first).pending, true);
  const second = f.reader.read(other); f.emit(event()); assert.equal((await second).pending, false);
  assert.equal((await f.reader.read('bad')).code, 'ERR_REQUEST_TARGET'); f.reader.stop();
  const fixed = fixture(); fixed.register();
  assert.equal((await fixed.reader.read(other)).code, 'ERR_REQUEST_TARGET'); fixed.reader.stop();
});
test('malformed lists, holes, proxies and accessors cannot become no pending requests', () => {
  const bad = {}; Object.defineProperty(bad, 'buddyReqs', { get() { assert.fail('accessor'); } });
  const row = {}; Object.defineProperty(row, 'friendUid', { get() { assert.fail('row accessor'); } });
  for (const value of [null, {}, bad, new Proxy(event(), {}), { buddyReqs: new Array(2) }, { buddyReqs: [row] },
    { buddyReqs: [{ friendUid: uid, reqType: 0, isDecide: 'false' }] }]) assert.equal(summarizeBuddyRequests(value, uid).pending, null);
});
test('passive registration preserves native receiver/return; query only resolves from an observed callback', async () => {
  const f = fixture(); assert.equal(f.reader.ready(), false); assert.equal(f.calls(), 0);
  assert.equal((await f.reader.read()).pending, null);
  assert.equal(f.register(), '1'); assert.equal(f.reader.ready(), true);
  const pending = f.reader.read(); assert.equal(f.calls(), 1);
  assert.equal((await f.reader.read()).code, 'ERR_BUSY');
  assert.equal(f.emit(event()), 42); assert.equal((await pending).pending, true);
  assert.deepEqual(f.reader.stop(), { cleanupComplete: true });
  assert.equal(f.service.addKernelBuddyListener, f.originals.addKernelBuddyListener);
  assert.equal(f.service.removeKernelBuddyListener, f.originals.removeKernelBuddyListener);
  assert.equal(f.listener.onBuddyReqChange, f.originalCallback);
});
test('event snapshot precedes callback mutation and callback exceptions remain original', async () => {
  const err = new Error('PRIVATE');
  const f = fixture({ callback(data) { data.buddyReqs.length = 0; throw err; } });
  f.register(); const p = f.reader.read(); assert.throws(() => f.emit(event()), e => e === err);
  assert.equal((await p).pending, true); f.reader.stop();
});
test('removal, stop and binding loss prevent stale request results', async () => {
  const f = fixture(); const id = f.register(); const p = f.reader.read();
  assert.equal(f.service.removeKernelBuddyListener(id), 'original-return');
  assert.equal((await p).code, 'ERR_REQUEST_LISTENER_REMOVED');
  assert.equal(f.reader.ready(), false); f.reader.stop();
  const g = fixture(); g.register(); const q = g.reader.read(); g.invalidate(); g.emit(event());
  g.reader.stop(); assert.equal((await q).pending, null);
});
test('timeout retires reader; late events and rejected native query cannot start another query', async () => {
  let reject;
  const f = fixture({ timeoutMs: 15, query: () => new Promise((r, j) => { reject = j; }) });
  f.register(); assert.equal((await f.reader.read()).code, 'ERR_REQUEST_TIMEOUT');
  f.emit(event()); reject(new Error('PRIVATE'));
  assert.equal((await f.reader.read()).code, 'ERR_REQUEST_LISTENER_UNAVAILABLE');
  assert.equal(f.calls(), 1); await new Promise(r => setImmediate(r));
});
test('fixed listener methods are left untouched; unsupported registration and changed pins fail closed', () => {
  const f = fixture(); Object.defineProperty(f.listener, 'onBuddyReqChange', { value: f.originalCallback, writable: false, configurable: false });
  assert.equal(f.register(), '1'); assert.equal(f.reader.ready(), false); f.reader.stop();
  assert.throws(() => watchBuddyRequests({ ...f.b, majorSha256: 'wrong' }, { targetUid: uid }));
});
