import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startProbe } = require('../plugins/qq-friend-probe/probe.cjs');
const { QQ_VERSION, WRAPPER_SHA256 } = require('../plugins/qq-friend-probe/request-contract.cjs');
const { normalizeObservation } = require('../plugins/qq-friend-probe/request-observer.cjs');
const bot = '123456789';
const target = '4000000000';
const config = { targetUin: target, qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256 };
// Type fixtures, not approved real request values.
const request = () => ({ buddyUin: target, buddyUid: 'PRIVATE_UID', phoneNumber: 'PRIVATE_PHONE',
  addFriendSetting: 1, sourceID: 7, sourceSubID: 8, qzoneNotWatch: false, qzoneNotWatched: true, onlyChat: false,
  remark: 'PRIVATE_REMARK', verifyInfo: 'PRIVATE_TEXT', answer: 'PRIVATE_ANSWER', defaultCatgory: 0,
  securityVerify: { type: 3, ticket: 'PRIVATE_TICKET', randStr: 'PRIVATE_RANDOM', token: 'PRIVATE_TOKEN' } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  let calls = 0;
  let addCalls = 0;
  let currentService;
  let currentAddService;
  let expiry;
  let initThrows = false;
  const reports = [];
  const pending = deferred();
  const original = function (...args) { calls++; return options.native ? options.native(this, args) : pending.promise; };
  const service = options.service ?? Object.create(Object.freeze({ reqToAddFriends: original }));
  const addOriginal = function (...args) { addCalls++; return options.addNative ? options.addNative(this, args) : pending.promise; };
  const addService = options.addService ?? Object.create(Object.freeze({ addBuddy: addOriginal }));
  currentService = service;
  currentAddService = addService;
  const session = { init() { if (initThrows) throw Error('PRIVATE_INIT_FAILURE'); }, getBuddyService() { return currentService; } };
  if (!options.missingAddGetter) session.getAddBuddyService = () => currentAddService;
  const factory = function () {};
  Object.defineProperty(factory, 'getNTWrapperSession', { value: () => session });
  const module = { exports: { NodeIQQNTWrapperSession: factory } };
  const runtime = { dlopen() {} };
  const control = startProbe({ runtime, expectedUin: bot, requestObservation: options.observation ?? config, attestWrapper: () => options.attest !== false,
    onReport: report => { reports.push(report); if (options.throwReport) throw Error('PRIVATE_REPORT'); },
    timers: { setTimeout: fn => { expiry = fn; return 1; }, clearTimeout() {} } });
  runtime.dlopen(module, 'C:/QQ/wrapper.node');
  module.exports.NodeIQQNTWrapperSession.getNTWrapperSession();
  session.init({ selfUin: options.account ?? bot });
  session.getBuddyService();
  if (options.observation?.observeAddBuddy && session.getAddBuddyService) session.getAddBuddyService();
  return { control, reports, service, addService, session, original, pending, calls: () => calls, addCalls: () => addCalls, expire: () => expiry(),
    changeAddService: next => { currentAddService = next; },
    changeService: next => { currentService = next; }, failInit: () => { initThrows = true; } };
}

test('invalid observation configuration fails before any QQ hook is installed', () => {
  for (const cfg of [{}, { ...config, targetUin: 4000000000 }, { ...config, wrapperSha256: '0'.repeat(64) }, { ...config, qqVersion: 'other' }]) {
    assert.throws(() => normalizeObservation(cfg), /explicit target/);
  }
});

test('manual request observation allows a bounded 30-minute window and reports its exact expiry', () => {
  let delay, expiry; let cancelled = false;
  const options = { runtime: { dlopen() {} }, expectedUin: bot, attestWrapper: () => true, onReport() {},
    now: () => Date.UTC(2026, 9, 25, 3, 0, 0),
    timers: { setTimeout(fn, ms) { delay = ms; expiry = fn; return 1; }, clearTimeout() { cancelled = true; } } };
  const probe = startProbe({ ...options, requestObservation: config, timeoutMs: 1800000 });
  assert.equal(delay, 1800000);
  assert.equal(probe.snapshot().observationExpiresAt, '2026-10-25T03:30:00.000Z');
  expiry(); assert.equal(probe.snapshot().phase, 'timeout'); assert.equal(cancelled, true);
  assert.equal(probe.snapshot().cleanupComplete, true);
  assert.throws(() => startProbe({ ...options, requestObservation: config, timeoutMs: 1800001 }), /timeoutMs/);
  assert.throws(() => startProbe({ ...options, timeoutMs: 300001 }), /timeoutMs/);
});

test('waits for QQ rather than creating a request and restores a prototype shadow', () => {
  const f = fixture();
  assert.equal(f.control.snapshot().phase, 'waiting-target-request');
  assert.equal(f.calls(), 0);
  assert.equal(Object.hasOwn(f.service, 'reqToAddFriends'), true);
  f.expire();
  assert.equal(f.control.snapshot().phase, 'timeout');
  assert.equal(f.control.snapshot().cleanupComplete, true);
  assert.equal(Object.hasOwn(f.service, 'reqToAddFriends'), false);
});

test('QQ arguments, this, Promise identity and native result remain unchanged', async () => {
  const input = request(); const p = deferred(); let actualThis, actualArgs;
  const f = fixture({ native(receiver, args) { actualThis = receiver; actualArgs = args; return p.promise; } });
  const returned = f.service.reqToAddFriends(input);
  assert.equal(actualThis, f.service); assert.equal(actualArgs[0], input); assert.equal(actualArgs.length, 1);
  assert.equal(returned, p.promise);
  const result = { result: 1, errMsg: 'PRIVATE_NATIVE_FAILURE' };
  p.resolve(result); assert.equal(await returned, result); await flush();
  const report = f.control.snapshot();
  assert.equal(report.phase, 'request-result-observed');
  assert.deepEqual(report.requestResult, { result: 1, errorMessagePresent: true });
  assert.equal(report.requestObservation.contractMatched, true);
  assert.equal(report.requestSent, null);
  assert.equal(report.probeInitiatedRequest, false);
  assert.equal(report.cleanupComplete, true);
  assert.equal(f.calls(), 1);
});

test('captures only allowlisted scalar values, never identity, text, credentials or native error messages', async () => {
  const f = fixture(); f.service.reqToAddFriends(request()); f.pending.resolve({ result: 0, errMsg: 'PRIVATE_MESSAGE' }); await flush();
  const metadata = f.control.snapshot().requestObservation;
  assert.deepEqual(metadata.values, { addFriendSetting: 1, defaultCatgory: 0, sourceID: 7, sourceSubID: 8,
    qzoneNotWatch: false, qzoneNotWatched: true, onlyChat: false });
  assert.deepEqual(metadata.securityVerifyFields.token, { kind: 'string', empty: false });
  const json = JSON.stringify(f.reports);
  for (const privateText of ['PRIVATE_', target, bot]) assert.equal(json.includes(privateText), false);
  metadata.values.sourceID = 999;
  assert.equal(f.control.snapshot().requestObservation.values.sourceID, 7);
});

test('other targets and requests with extra arguments are forwarded but never inspected or captured', () => {
  let touches = 0;
  const other = { buddyUin: '987654321', get buddyUid() { touches++; throw Error('PRIVATE_ACCESSOR'); } };
  const f = fixture(); f.service.reqToAddFriends(other); f.service.reqToAddFriends(request(), 'extra');
  assert.equal(f.calls(), 2); assert.equal(touches, 0); assert.equal(f.control.snapshot().qqRequestObserved, false);
  f.expire();
});

test('wrong receiver, wrong login and failed wrapper attestation never collect a request', () => {
  const f = fixture(); f.service.reqToAddFriends.call({}, request());
  assert.equal(f.control.snapshot().qqRequestObserved, false); f.expire();
  for (const options of [{ account: '987654321' }, { attest: false }]) {
    const g = fixture(options); g.service.reqToAddFriends(request());
    assert.equal(g.control.snapshot().qqRequestObserved, false);
    assert.equal(g.control.snapshot().cleanupComplete, true);
  }
});

test('a matching request with accessors is diagnosed without evaluating them', async () => {
  let touches = 0;
  const input = request(); Object.defineProperty(input, 'buddyUid', { get() { touches++; throw Error('PRIVATE_GETTER'); } });
  const f = fixture(); f.service.reqToAddFriends(input); f.pending.resolve({ result: 0, errMsg: '' }); await flush();
  assert.equal(touches, 0); assert.equal(f.control.snapshot().requestObservation.contractMatched, false);
  assert.equal(f.control.snapshot().requestObservation.fields.buddyUid.kind, 'accessor');
});

test('proxy requests are passed through without inspecting traps', () => {
  let touches = 0;
  const proxy = new Proxy(request(), { getOwnPropertyDescriptor() { touches++; throw Error('PRIVATE_TRAP'); } });
  const f = fixture(); f.service.reqToAddFriends(proxy);
  assert.equal(touches, 0); assert.equal(f.control.snapshot().qqRequestObserved, false); f.expire();
});

test('only the first matching request is observed, even with later calls still in flight', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const f = fixture({ native: () => ++count === 1 ? first.promise : second.promise });
  f.service.reqToAddFriends(request()); f.service.reqToAddFriends({ ...request(), sourceID: 999 });
  second.resolve({ result: 0, errMsg: '' }); await flush();
  assert.equal(f.control.snapshot().phase, 'waiting-request-result');
  first.resolve({ result: 7, errMsg: '' }); await flush();
  assert.equal(f.control.snapshot().requestResult.result, 7);
  assert.equal(f.control.snapshot().requestObservation.values.sourceID, 7);
});

test('native synchronous exceptions and Promise rejections remain identical and are not logged', async () => {
  const error = Error('PRIVATE_NATIVE_THROW');
  const f = fixture({ native: () => { throw error; } });
  assert.throws(() => f.service.reqToAddFriends(request()), e => e === error);
  assert.equal(f.control.snapshot().phase, 'request-native-threw');
  const g = fixture(); const returned = g.service.reqToAddFriends(request());
  const checked = assert.rejects(returned, e => e === error); g.pending.reject(error); await checked; await flush();
  assert.equal(g.control.snapshot().phase, 'request-promise-rejected');
  assert.equal(JSON.stringify([...f.reports, ...g.reports]).includes('PRIVATE_'), false);
});

test('non-Promise return and unexpected result shape are diagnostic outcomes, not native retries', async () => {
  const thenable = { get then() { throw Error('Must not read'); } };
  const f = fixture({ native: () => thenable });
  assert.equal(f.service.reqToAddFriends(request()), thenable);
  assert.equal(f.control.snapshot().phase, 'request-return-not-promise');
  const g = fixture(); g.service.reqToAddFriends(request()); g.pending.resolve({ result: '0', errMsg: '' }); await flush();
  assert.equal(g.control.snapshot().phase, 'request-result-shape-mismatch');
  assert.equal(f.calls(), 1); assert.equal(g.calls(), 1);
});

test('timeout suppresses late settlement and a cached wrapper remains a plain forwarder', async () => {
  const f = fixture(); const cached = f.service.reqToAddFriends;
  cached.call(f.service, request()); f.expire();
  f.pending.resolve({ result: 0, errMsg: '' }); await flush();
  assert.equal(f.control.snapshot().phase, 'timeout'); assert.equal(f.control.snapshot().requestResult, null);
  cached.call(f.service, request()); assert.equal(f.calls(), 2);
});

test('reinitialization and native init failure invalidate an in-flight request observation', async () => {
  for (const fail of [false, true]) {
    const f = fixture(); f.service.reqToAddFriends(request());
    if (fail) f.failInit();
    if (fail) assert.throws(() => f.session.init({ selfUin: bot }));
    else f.session.init({ selfUin: bot });
    f.pending.resolve({ result: 0, errMsg: '' }); await flush();
    assert.equal(f.control.snapshot().phase, 'account-reinitialized');
    assert.equal(f.control.snapshot().requestResult, null); assert.equal(f.control.snapshot().cleanupComplete, true);
  }
});

test('another service wrapper from the same session does not discard a pending result', async () => {
  const f = fixture(); f.service.reqToAddFriends(request());
  f.changeService({ reqToAddFriends() { throw Error('Must not call'); } }); f.session.getBuddyService();
  f.pending.resolve({ result: 0, errMsg: '' }); await flush();
  assert.equal(f.control.snapshot().phase, 'request-result-observed'); assert.equal(f.control.snapshot().requestResult.result, 0);
});

test('a fixed own request method is left intact and later hooks are not overwritten during cleanup', () => {
  const native = () => { throw Error('Must not call'); };
  const service = Object.freeze({ reqToAddFriends: native });
  const f = fixture({ service });
  assert.equal(f.control.snapshot().phase, 'unsupported-request-hook'); assert.equal(service.reqToAddFriends, native);
  const g = fixture(); const later = () => {};
  g.service.reqToAddFriends = later; g.expire();
  assert.equal(g.service.reqToAddFriends, later); assert.equal(g.control.snapshot().cleanupComplete, false);
});

test('report writer failures cannot prevent or duplicate the QQ call', async () => {
  const f = fixture({ throwReport: true }); const returned = f.service.reqToAddFriends(request());
  f.pending.resolve({ result: 0, errMsg: '' }); await returned; await flush();
  assert.equal(f.calls(), 1); assert.equal(f.control.snapshot().phase, 'request-result-observed');
});

const targetUid = 'u_PRIVATE_TARGET_123';
const dual = { ...config, observeAddBuddy: true, targetUid };
const addRequest = () => ({ targetInfo: { uid: targetUid, uin: '0', phoneNum: 'PRIVATE_PHONE' },
  addFriendSetting: 1, sourceId: 7, sourceSubId: 8, showMyCard: 0, myFriendGroupId: 0, isContactFriend: false,
  answer: 'PRIVATE_ANSWER', sig: Buffer.from('PRIVATE_SIG'), token: Buffer.from('PRIVATE_TOKEN') });

test('dual observation installs both service hooks without invoking either method', () => {
  const f = fixture({ observation: dual });
  assert.equal(f.calls(), 0); assert.equal(f.addCalls(), 0);
  assert.equal(f.control.snapshot().addBuddyServiceObserved, true);
  assert.equal(f.control.snapshot().addBuddyPresent, true);
  assert.equal(f.control.snapshot().requestDiagnostics['add-buddy'].calls, 0);
  f.expire(); assert.equal(Object.hasOwn(f.addService, 'addBuddy'), false);
});

test('AddBuddy targetInfo UID matches the verified target while its UIN is absent or zero', async () => {
  for (const uin of [undefined, null, '0', 0]) {
    const f = fixture({ observation: dual }); const input = addRequest(); input.targetInfo.uin = uin;
    const context = 'PRIVATE_CONTEXT', bytes = Buffer.from('PRIVATE_THIRD_ARGUMENT');
    const returned = f.addService.addBuddy(context, input, bytes);
    assert.equal(returned, f.pending.promise);
    f.pending.resolve({ result: 0, errMsg: '', context, req: input, rsp: { token: 'PRIVATE_RESPONSE' } }); await flush();
    const r = f.control.snapshot();
    assert.equal(r.requestRoute, 'add-buddy'); assert.equal(r.phase, 'request-result-observed');
    assert.deepEqual(r.requestResult, { result: 0, errorMessagePresent: false });
    assert.equal(r.requestObservation.contractMatched, null);
    assert.equal(r.requestObservation.values.sourceId, 7);
    assert.equal(JSON.stringify(f.reports).includes('PRIVATE_'), false);
    assert.equal(f.addCalls(), 1);
  }
});

test('AddBuddy preserves all three arguments, receiver and return identity without manufacturing defaults', () => {
  const args = ['PRIVATE_CONTEXT', addRequest(), new Uint8Array([1, 2])]; let received;
  const f = fixture({ observation: dual, addNative(receiver, actual) { received = { receiver, actual }; return 42; } });
  assert.equal(f.addService.addBuddy(...args), 42);
  assert.equal(received.receiver, f.addService);
  received.actual.forEach((value, i) => assert.equal(value, args[i]));
  assert.equal(f.control.snapshot().phase, 'request-return-not-promise');
  assert.equal(f.control.snapshot().requestObservation.fields.myAllowFlag.kind, 'missing');
});

test('diagnostics distinguish noncalls, wrong receiver, arity, uninspectable input and target mismatch', () => {
  const f = fixture({ observation: dual });
  f.addService.addBuddy.call({}, 'ctx', addRequest(), null);
  f.addService.addBuddy(addRequest());
  f.addService.addBuddy('ctx', new Proxy({}, { ownKeys() { throw Error('PRIVATE_TRAP'); } }), null);
  f.addService.addBuddy('ctx', { targetInfo: { uin: '987654321' } }, null);
  const d = f.control.snapshot().requestDiagnostics['add-buddy'];
  assert.equal(d.calls, 4); assert.equal(d.wrongReceiver, 1); assert.equal(d.wrongArity, 1);
  assert.equal(d.uninspectable, 1); assert.equal(d.targetMismatch, 1); assert.equal(d.uinKinds.string, 1);
  assert.equal(f.control.snapshot().requestDiagnostics.buddy.calls, 0);
  assert.equal(f.control.snapshot().qqRequestObserved, false);
  d.uinKinds.string = 99; assert.equal(f.control.snapshot().requestDiagnostics['add-buddy'].uinKinds.string, 1);
  f.expire();
});

test('verified UID never overrides a conflicting explicit UIN or another UID', () => {
  for (const [uin, uid] of [['987654321', targetUid], [target, 'u_PRIVATE_DIFFERENT']]) {
    const f = fixture({ observation: dual });
    f.addService.addBuddy('ctx', { targetInfo: { uin, uid } }, null);
    assert.equal(f.control.snapshot().qqRequestObserved, false);
    assert.equal(f.control.snapshot().requestDiagnostics['add-buddy'].conflictingIdentity, 1);
    f.expire();
  }
});

test('UID-only target is not guessed without a configured verified mapping', () => {
  const f = fixture({ observation: { ...config, observeAddBuddy: true } });
  f.addService.addBuddy('ctx', addRequest(), null);
  assert.equal(f.control.snapshot().qqRequestObserved, false);
  assert.equal(f.control.snapshot().requestDiagnostics['add-buddy'].targetMismatch, 1);
  f.expire();
});

test('legacy requests can also match a verified UID and still report the stricter contract outcome', async () => {
  const f = fixture({ observation: dual });
  f.service.reqToAddFriends({ ...request(), buddyUin: '0', buddyUid: targetUid });
  f.pending.resolve({ result: 0, errMsg: '' }); await flush();
  assert.equal(f.control.snapshot().requestRoute, 'buddy');
  assert.equal(f.control.snapshot().requestObservation.contractMatched, false);
});

test('unknown AddBuddy target accessors are diagnosed without executing them', () => {
  let touches = 0;
  const f = fixture({ observation: dual });
  f.addService.addBuddy('ctx', { targetInfo: { get uid() { touches++; throw Error('PRIVATE_GETTER'); } } }, null);
  assert.equal(touches, 0); assert.equal(f.control.snapshot().qqRequestObserved, false);
  assert.equal(f.control.snapshot().requestDiagnostics['add-buddy'].uidKinds.accessor, 1); f.expire();
});

test('the first captured route owns its result when both services receive matching calls', async () => {
  const first = deferred(), second = deferred();
  const f = fixture({ observation: dual, addNative: () => first.promise, native: () => second.promise });
  f.addService.addBuddy('ctx', addRequest(), null);
  f.service.reqToAddFriends({ ...request(), buddyUid: targetUid });
  second.resolve({ result: 12, errMsg: '' }); await flush();
  assert.equal(f.control.snapshot().phase, 'waiting-request-result');
  first.resolve({ result: 3, errMsg: '', context: 'secret', req: {}, rsp: {} }); await flush();
  assert.equal(f.control.snapshot().requestRoute, 'add-buddy'); assert.equal(f.control.snapshot().requestResult.result, 3);
});

test('missing AddBuddy or fixed legacy request leaves the other route observable', async () => {
  const f = fixture({ observation: dual, missingAddGetter: true });
  f.service.reqToAddFriends({ ...request(), buddyUid: targetUid }); f.pending.resolve({ result: 0, errMsg: '' }); await flush();
  assert.equal(f.control.snapshot().phase, 'request-result-observed'); assert.equal(f.control.snapshot().requestRoute, 'buddy');
  const g = fixture({ observation: dual, service: Object.freeze({ reqToAddFriends() {} }) });
  g.addService.addBuddy('ctx', addRequest(), null); g.pending.resolve({ result: 0, errMsg: '' }); await flush();
  assert.equal(g.control.snapshot().requestRoute, 'add-buddy'); assert.equal(g.control.snapshot().cleanupComplete, true);
});

test('wrong account and reinit do not record AddBuddy fields or late results', async () => {
  const f = fixture({ observation: dual, account: '987654321' }); f.addService.addBuddy('ctx', addRequest(), null);
  assert.equal(f.control.snapshot().requestDiagnostics['add-buddy'].calls, 0);
  const g = fixture({ observation: dual }); g.addService.addBuddy('ctx', addRequest(), null);
  g.session.init({ selfUin: bot }); g.pending.resolve({ result: 0, errMsg: '' }); await flush();
  assert.equal(g.control.snapshot().phase, 'account-reinitialized'); assert.equal(g.control.snapshot().requestResult, null);
});

test('multiple same-account AddBuddy wrappers remain observable and stop together after completion', async () => {
  const f = fixture({ observation: dual }); const cached = f.addService.addBuddy;
  const second = { addBuddy() {} };
  f.changeAddService(second); f.session.getAddBuddyService();
  const secondHook = second.addBuddy;
  f.changeAddService(f.addService); f.session.getAddBuddyService();
  assert.equal(f.addService.addBuddy, cached);
  f.changeAddService(second); f.session.getAddBuddyService(); assert.equal(second.addBuddy, secondHook);
  second.addBuddy();
  cached.call(f.addService, 'ctx', addRequest(), null);
  assert.equal(f.control.snapshot().requestDiagnostics['add-buddy'].calls, 2);
  f.pending.resolve({ result: 0, errMsg: '' }); await flush();
  assert.equal(f.control.snapshot().phase, 'request-result-observed');
  const before = JSON.stringify(f.control.snapshot()); cached.call(f.addService, 'ctx', addRequest(), null);
  assert.equal(JSON.stringify(f.control.snapshot()), before);
});
