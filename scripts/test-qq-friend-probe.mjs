import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { makeBootstrap, makeCandidateDll } from './prepare-qq-probe-deployment.mjs';

const require = createRequire(import.meta.url);
const { startProbe } = require('../plugins/qq-friend-probe/probe.cjs');
const expectedUin = '123456789';

function fixture(options = {}) {
  const calls = { load: 0, create: 0, init: 0, get: 0, request: 0 };
  const reports = [];
  const nativeReturn = Symbol('dlopen-return');
  const initReturn = options.initReturn ?? Symbol('init-return');
  let expectedInitArgs;
  const service = options.service ?? { reqToAddFriends() { calls.request++; throw new Error('Must not call'); } };
  const session = options.session ?? {
    init(...args) {
      assert.equal(this, session); calls.init++; assert.equal(args.length, 4);
      args.forEach((arg, i) => assert.equal(arg, expectedInitArgs[i]));
      if (options.initError) throw options.initError;
      return initReturn;
    },
    getBuddyService() { assert.equal(this, session); calls.get++; return service; },
  };
  const factory = { create() { assert.equal(this, factory); calls.create++; return session; } };
  if (options.frozenFactory) Object.freeze(factory);
  const exports = { NodeIQQNTWrapperSession: factory };
  const runtime = {
    dlopen(module, filename, flags) {
      assert.equal(this, runtime); assert.equal(flags, 17); calls.load++;
      if (options.loadError) throw options.loadError;
      module.exports = exports;
      return nativeReturn;
    },
  };
  const originals = { load: runtime.dlopen, create: factory.create, init: session.init, get: session.getBuddyService };
  let timeout;
  let cancelled = false;
  const control = startProbe({
    runtime, expectedUin, cache: options.cache ?? {},
    attestWrapper: options.attestWrapper ?? (() => true),
    onReport: options.onReport ?? ((report) => reports.push(report)),
    timers: { setTimeout: (fn) => { timeout = fn; return { unref() {} }; }, clearTimeout: () => { cancelled = true; } },
  });
  const module = {};
  function load(filename = 'C:/QQ/resources/app/wrapper.node') {
    assert.equal(runtime.dlopen(module, filename, 17), nativeReturn);
    assert.equal(module.exports, exports);
  }
  function init(config = { selfUin: expectedUin }) {
    const adapters = [{}, {}, { onSessionInitComplete() {} }];
    expectedInitArgs = [config, ...adapters];
    assert.equal(session.init(config, ...adapters), initReturn);
  }
  return { calls, reports, service, session, factory, runtime, originals, control, module, load, init,
    expire: () => timeout?.(), cancelled: () => cancelled };
}

test('loading the probe never creates a session or invokes a native service', () => {
  const f = fixture(); f.load();
  assert.deepEqual(f.calls, { load: 1, create: 0, init: 0, get: 0, request: 0 });
  f.control.stop();
});

test('QQ calls retain object identity, native this and results; probe cleans up after observation', () => {
  const f = fixture(); f.load();
  assert.equal(f.factory.create(), f.session);
  f.init();
  assert.equal(f.session.getBuddyService(), f.service);
  assert.deepEqual(f.calls, { load: 1, create: 1, init: 1, get: 1, request: 0 });
  assert.equal(f.control.snapshot().phase, 'capability-present');
  assert.equal(f.control.snapshot().loginOnlineVerified, false);
  assert.equal(f.control.snapshot().requestSchemaVerified, false);
  assert.equal(f.control.snapshot().cleanupComplete, true);
  assert.equal(f.runtime.dlopen, f.originals.load);
  assert.equal(f.factory.create, f.originals.create);
  assert.equal(f.session.init, f.originals.init);
  assert.equal(f.session.getBuddyService, f.originals.get);
  assert.equal(f.cancelled(), true);
});

test('service observed before init is not inspected until the expected account appears', () => {
  const f = fixture(); f.load(); f.factory.create(); f.session.getBuddyService();
  assert.equal(f.control.snapshot().reqToAddFriendsPresent, null);
  f.init(); assert.equal(f.control.snapshot().phase, 'capability-present');
});

test('wrong account stops without inspecting a friend service', () => {
  let inspected = false;
  const service = new Proxy({}, { getOwnPropertyDescriptor() { inspected = true; throw new Error('Wrong account'); } });
  const f = fixture({ service }); f.load(); f.factory.create(); f.session.getBuddyService();
  f.init({ selfUin: '987654321' });
  assert.equal(f.control.snapshot().phase, 'account-mismatch');
  assert.equal(f.control.snapshot().identityMatched, false);
  assert.equal(inspected, false);
  assert.equal(f.calls.request, 0);
});

test('init credentials, listeners and other payloads never enter the report', () => {
  const f = fixture(); f.load(); f.factory.create();
  const config = { selfUin: expectedUin, a2: 'PRIVATE_A2', d2Key: 'PRIVATE_D2_KEY' };
  f.init(config); f.session.getBuddyService();
  const text = JSON.stringify(f.reports);
  for (const secret of [expectedUin, config.a2, config.d2Key]) assert.equal(text.includes(secret), false);
  assert.deepEqual(config, { selfUin: expectedUin, a2: 'PRIVATE_A2', d2Key: 'PRIVATE_D2_KEY' });
});

test('unknown identity and accessor properties do not trigger getters', () => {
  const f = fixture(); f.load(); f.factory.create();
  f.init({ get selfUin() { throw new Error('Must not evaluate identity getters'); } });
  f.session.getBuddyService();
  assert.equal(f.control.snapshot().identityMatched, false);
  f.expire(); assert.equal(f.control.snapshot().phase, 'timeout');
});

test('native Promise identity and listener argument identity are preserved', () => {
  const promise = Promise.resolve();
  const f = fixture({ initReturn: promise }); f.load(); f.factory.create(); f.init();
  f.control.stop();
});

test('QQ loader exceptions propagate unchanged', () => {
  const error = new Error('Native loading failed');
  const f = fixture({ loadError: error });
  assert.throws(() => f.load(), (e) => e === error);
  assert.equal(f.calls.load, 1); f.control.stop();
});

test('QQ init exceptions propagate unchanged and do not mark identity verified', () => {
  const error = new Error('Native init failed');
  const f = fixture({ initError: error }); f.load(); f.factory.create();
  assert.throws(() => f.init(), (e) => e === error);
  assert.equal(f.control.snapshot().identityMatched, false);
  f.control.stop();
});

test('a throwing re-init invalidates the old account before any service can be inspected', () => {
  const options = {};
  const f = fixture(options); f.load(); f.factory.create(); f.init();
  assert.equal(f.control.snapshot().identityMatched, true);
  const error = new Error('PRIVATE_REINIT_ERROR');
  options.initError = error;
  assert.throws(() => f.init({ selfUin: '987654321' }), (e) => e === error);
  f.session.getBuddyService();
  assert.equal(f.control.snapshot().identityMatched, false);
  assert.equal(f.control.snapshot().initCallReturned, false);
  assert.equal(f.control.snapshot().reqToAddFriendsPresent, null);
  assert.equal(JSON.stringify(f.reports).includes(error.message), false);
  f.control.stop();
});

test('attestation failure or exception never changes the QQ loader result', () => {
  for (const attestWrapper of [() => false, () => { throw new Error('Private local path'); }]) {
    const f = fixture({ attestWrapper }); f.load();
    assert.equal(f.control.snapshot().active, false);
    assert.equal(f.factory.create, f.originals.create);
    assert.equal(JSON.stringify(f.reports).includes('Private local path'), false);
  }
});

test('fixed native properties are not forced or replaced with proxies', () => {
  const f = fixture({ frozenFactory: true }); f.load();
  assert.equal(f.control.snapshot().phase, 'unsupported-factory-hook');
  assert.equal(f.factory.create, f.originals.create);
  assert.equal(f.control.snapshot().cleanupComplete, true);
  assert.deepEqual(f.control.snapshot().hookFailure, { target: 'factoryCreate', reason: 'fixed-property' });
  assert.equal(f.control.snapshot().diagnostics.factoryCreate.writable, false);
  assert.equal(f.control.snapshot().diagnostics.factoryCreate.configurable, false);
});

test('partly installed session hooks are restored when another method cannot be hooked', () => {
  const session = { init() {} };
  Object.defineProperty(session, 'getBuddyService', { value() {}, configurable: false, writable: false });
  const f = fixture({ session }); f.load(); f.factory.create();
  assert.equal(f.control.snapshot().phase, 'unsupported-session-hook');
  assert.equal(session.init, f.originals.init);
});

test('probe timeout restores hooks even when QQ does not call the observed methods', () => {
  const f = fixture(); f.load(); f.factory.create(); f.expire();
  assert.equal(f.control.snapshot().phase, 'timeout');
  assert.equal(f.session.init, f.originals.init);
  assert.equal(f.runtime.dlopen, f.originals.load);
});

test('hooks installed later by another extension are preserved and ours become inactive', () => {
  const f = fixture(); const ours = f.runtime.dlopen;
  const later = function (...args) { return Reflect.apply(ours, this, args); };
  f.runtime.dlopen = later;
  f.control.stop();
  assert.equal(f.runtime.dlopen, later);
  assert.equal(f.control.snapshot().cleanupComplete, false);
  f.load(); assert.equal(f.factory.create, f.originals.create);
});

test('loading too late does not call create/get as a fallback', () => {
  const f = fixture({ cache: { 'C:/QQ/wrapper.node': {} } });
  assert.equal(f.control.snapshot().phase, 'wrapper-already-loaded');
  assert.equal(f.runtime.dlopen, f.originals.load);
  assert.equal(f.calls.create, 0);
});

test('non-wrapper modules and repeated wrapper loads do not create duplicate hooks', () => {
  const f = fixture(); f.load('C:/QQ/other.node');
  assert.equal(f.factory.create, f.originals.create);
  f.load(); const hookedCreate = f.factory.create;
  f.load(); assert.equal(f.factory.create, hookedCreate);
  f.control.stop();
});

test('reporter failure cannot break QQ calls', () => {
  const f = fixture({ onReport() { throw new Error('disk unavailable'); } });
  f.load(); f.factory.create(); f.init(); f.session.getBuddyService();
  assert.equal(f.control.snapshot().phase, 'capability-present');
});

test('missing capability is reported without testing an unknown method or getter', () => {
  const f = fixture({ service: { get reqToAddFriends() { throw new Error('No getter execution'); } } });
  f.load(); f.factory.create(); f.init(); f.session.getBuddyService();
  assert.equal(f.control.snapshot().phase, 'capability-not-observed');
  assert.equal(f.calls.request, 0);
});

test('prototype methods are observed without modifying the prototype and restored by deleting shadows', () => {
  const service = { reqToAddFriends() { throw new Error('Must not invoke'); } };
  class Session {
    init() { return 42; }
    getBuddyService() { return service; }
  }
  const session = new Session();
  const originalInit = Session.prototype.init;
  const originalGet = Session.prototype.getBuddyService;
  const f = fixture({ session }); f.load(); f.factory.create();
  assert.equal(Session.prototype.init, originalInit);
  assert.equal(Session.prototype.getBuddyService, originalGet);
  assert.equal(session.init({ selfUin: expectedUin }, {}, {}, {}), 42);
  assert.equal(session.getBuddyService(), service);
  assert.equal(f.control.snapshot().phase, 'capability-present');
  assert.equal(Object.hasOwn(session, 'init'), false);
  assert.equal(Object.hasOwn(session, 'getBuddyService'), false);
});

test('a non-extensible native session fails observation without breaking QQ create', () => {
  class Session { init() {} getBuddyService() {} }
  const session = Object.preventExtensions(new Session());
  const f = fixture({ session }); f.load();
  assert.equal(f.factory.create(), session);
  assert.equal(f.control.snapshot().phase, 'unsupported-session-hook');
  assert.deepEqual(f.control.snapshot().hookFailure, { target: 'sessionInit', reason: 'non-extensible-target' });
  assert.equal(f.control.snapshot().cleanupComplete, true);
});

function diagnosticProbe(exports, configureModule) {
  const module = {};
  const reports = [];
  const runtime = { dlopen() {
    if (configureModule) configureModule(module);
    else module.exports = exports;
    return 42;
  } };
  const original = runtime.dlopen;
  const control = startProbe({ runtime, expectedUin, attestWrapper: () => true,
    onReport: (report) => reports.push(report),
    timers: { setTimeout: () => 1, clearTimeout() {} } });
  assert.equal(runtime.dlopen(module, 'C:/QQ/wrapper.node'), 42);
  return { control, reports, runtime, original, module };
}

test('diagnostics distinguish missing exports, primitives, accessors and fixed factory methods', () => {
  const cases = [
    [undefined, { target: 'moduleExports', reason: 'not-object' }],
    ['PRIVATE_VALUE', { target: 'moduleExports', reason: 'not-object' }],
    [{}, { target: 'sessionFactory', reason: 'missing' }],
    [{ NodeIQQNTWrapperSession: null }, { target: 'sessionFactory', reason: 'not-object' }],
    [{ NodeIQQNTWrapperSession: {} }, { target: 'factoryCreate', reason: 'missing' }],
    [{ NodeIQQNTWrapperSession: { create: 'PRIVATE_VALUE' } }, { target: 'factoryCreate', reason: 'not-function' }],
    [{ NodeIQQNTWrapperSession: Object.freeze({ create() { throw new Error('No calls'); } }) },
      { target: 'factoryCreate', reason: 'fixed-property' }],
  ];
  for (const [exports, failure] of cases) {
    const f = diagnosticProbe(exports);
    assert.equal(f.control.snapshot().phase, 'unsupported-factory-hook');
    assert.deepEqual(f.control.snapshot().hookFailure, failure);
    assert.equal(f.control.snapshot().cleanupComplete, true);
    assert.equal(f.runtime.dlopen, f.original);
    assert.equal(JSON.stringify(f.reports).includes('PRIVATE_VALUE'), false);
  }
});

test('diagnostics never invoke getters on module exports, factory export or create', () => {
  let gets = 0;
  const accessor = { get() { gets++; throw new Error('SECRET_GETTER'); }, configurable: true };
  const factoryAccessor = {};
  Object.defineProperty(factoryAccessor, 'NodeIQQNTWrapperSession', accessor);
  const createAccessor = {};
  Object.defineProperty(createAccessor, 'create', accessor);
  const cases = [
    [null, (module) => Object.defineProperty(module, 'exports', accessor), 'moduleExports'],
    [factoryAccessor, null, 'sessionFactory'],
    [{ NodeIQQNTWrapperSession: createAccessor }, null, 'factoryCreate'],
  ];
  for (const [exports, configure, target] of cases) {
    const f = diagnosticProbe(exports, configure);
    assert.deepEqual(f.control.snapshot().hookFailure, { target, reason: 'accessor' });
    assert.equal(f.control.snapshot().diagnostics[target].hasGetter, true);
    assert.equal(f.control.snapshot().diagnostics[target].valueType, null);
    assert.equal(JSON.stringify(f.reports).includes('SECRET_GETTER'), false);
  }
  assert.equal(gets, 0);
});

test('diagnostics distinguish a non-extensible inherited factory method', () => {
  const prototype = { create() { throw new Error('No calls'); } };
  const factory = Object.preventExtensions(Object.create(prototype));
  const f = diagnosticProbe({ NodeIQQNTWrapperSession: factory });
  assert.deepEqual(f.control.snapshot().hookFailure, { target: 'factoryCreate', reason: 'non-extensible-target' });
  assert.equal(f.control.snapshot().diagnostics.factoryCreate.own, false);
  assert.equal(f.control.snapshot().diagnostics.factoryCreate.depth, 1);
  assert.equal(Object.hasOwn(factory, 'create'), false);
});

test('read-only configurable and non-configurable writable methods remain supported and restored', () => {
  for (const flags of [{ configurable: true, writable: false }, { configurable: false, writable: true }]) {
    const create = function () { throw new Error('No probe invocation'); };
    const factory = {};
    Object.defineProperty(factory, 'create', { value: create, ...flags });
    const before = Object.getOwnPropertyDescriptor(factory, 'create');
    const f = diagnosticProbe({ NodeIQQNTWrapperSession: factory });
    assert.equal(f.control.snapshot().phase, 'waiting-qq-session-create');
    assert.equal(f.control.snapshot().hookFailure, null);
    f.control.stop();
    assert.deepEqual(Object.getOwnPropertyDescriptor(factory, 'create'), before);
  }
});

test('diagnostics sanitize inspection failures and property-definition failures', () => {
  const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('SECRET_DESCRIPTOR'); } });
  const rejected = new Proxy({ create() {} }, { defineProperty() { throw new Error('SECRET_DEFINE'); } });
  for (const [factory, reason] of [[throwing, 'inspection-failed'], [rejected, 'define-failed']]) {
    const f = diagnosticProbe({ NodeIQQNTWrapperSession: factory });
    assert.deepEqual(f.control.snapshot().hookFailure, { target: 'factoryCreate', reason });
    assert.equal(f.runtime.dlopen, f.original);
    assert.equal(f.control.snapshot().cleanupComplete, true);
    assert.equal(JSON.stringify(f.reports).includes('SECRET_'), false);
  }
});

test('diagnostics are bounded, immutable snapshots with no arbitrary properties or values', () => {
  let deep = null;
  for (let i = 0; i < 20; i++) deep = Object.create(deep);
  deep.PRIVATE_KEY = 'PRIVATE_VALUE';
  const f = diagnosticProbe(deep);
  assert.deepEqual(f.control.snapshot().hookFailure, { target: 'sessionFactory', reason: 'depth-limit' });
  const snapshot = f.control.snapshot();
  snapshot.diagnostics.sessionFactory.kind = 'CORRUPT';
  snapshot.hookFailure.reason = 'CORRUPT';
  assert.equal(f.control.snapshot().diagnostics.sessionFactory.kind, 'depth-limit');
  assert.equal(f.control.snapshot().hookFailure.reason, 'depth-limit');
  const text = JSON.stringify(f.reports);
  assert.equal(text.includes('PRIVATE_'), false);
  assert.equal(text.includes('CORRUPT'), false);
});

test('unsupported loader diagnostics fail closed without installing a timer or calling native methods', () => {
  const runtime = Object.freeze({ dlopen() { throw new Error('Must not call'); } });
  const control = startProbe({ runtime, expectedUin, attestWrapper: () => true, onReport() {},
    timers: { setTimeout() { throw new Error('Must not start'); }, clearTimeout() {} } });
  assert.equal(control.snapshot().phase, 'unsupported-loader-hook');
  assert.deepEqual(control.snapshot().hookFailure, { target: 'loader', reason: 'fixed-property' });
});

test('native constructor route waits for QQ and preserves native instance, arguments, private fields and new.target', () => {
  const argument = { secret: 'PRIVATE_CONSTRUCTOR_ARGUMENT' };
  let calls = 0;
  let created;
  let actualNewTarget;
  const service = { reqToAddFriends() { throw new Error('No friend calls'); } };
  class NativeSession {
    #brand = 42;
    constructor(arg) { assert.equal(arg, argument); actualNewTarget = new.target; calls++; created = this; }
    init() { return this.#brand; }
    getBuddyService() { assert.equal(this.#brand, 42); return service; }
  }
  const exports = { NodeIQQNTWrapperSession: NativeSession };
  const before = Object.getOwnPropertyDescriptor(exports, 'NodeIQQNTWrapperSession');
  const f = diagnosticProbe(exports);
  assert.equal(calls, 0);
  assert.equal(f.control.snapshot().observationRoute, 'native-constructor');
  assert.equal(f.control.snapshot().hookFailure, null);
  const Constructor = exports.NodeIQQNTWrapperSession;
  const session = new Constructor(argument);
  assert.equal(calls, 1);
  assert.equal(actualNewTarget, NativeSession);
  assert.equal(session, created);
  assert.equal(Object.getPrototypeOf(session), NativeSession.prototype);
  assert.equal(session instanceof Constructor, true);
  assert.equal(session instanceof NativeSession, true);
  assert.equal(session.init({ selfUin: expectedUin }, {}, {}, {}), 42);
  assert.equal(session.getBuddyService(), service);
  assert.equal(f.control.snapshot().phase, 'capability-present');
  assert.equal(f.control.snapshot().cleanupComplete, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(exports, 'NodeIQQNTWrapperSession'), before);
  assert.equal(Object.hasOwn(session, 'init'), false);
  assert.equal(Object.hasOwn(session, 'getBuddyService'), false);
  assert.equal(JSON.stringify(f.reports).includes('PRIVATE_'), false);
});

test('constructor forwarding preserves subclass new.target and ordinary function call receiver', () => {
  let newTarget;
  class NativeSession {
    constructor() { newTarget = new.target; }
    init() {} getBuddyService() {}
  }
  const exports = { NodeIQQNTWrapperSession: NativeSession };
  const f = diagnosticProbe(exports);
  class Derived extends exports.NodeIQQNTWrapperSession {}
  const session = new Derived();
  assert.equal(newTarget, Derived);
  assert.equal(session instanceof Derived, true);
  f.control.stop();

  const receiver = {};
  const argument = {};
  const result = { init() {}, getBuddyService() {} };
  let calls = 0;
  function callable(arg) { calls++; assert.equal(this, receiver); assert.equal(arg, argument); return result; }
  const exports2 = { NodeIQQNTWrapperSession: callable };
  const g = diagnosticProbe(exports2);
  assert.equal(exports2.NodeIQQNTWrapperSession.call(receiver, argument), result);
  assert.equal(calls, 1);
  g.control.stop();
});

test('constructor exceptions remain identical and do not manufacture an observed session', () => {
  const error = new Error('PRIVATE_CONSTRUCTOR_ERROR');
  function NativeSession() { throw error; }
  const exports = { NodeIQQNTWrapperSession: NativeSession };
  const f = diagnosticProbe(exports);
  assert.throws(() => new exports.NodeIQQNTWrapperSession(), (e) => e === error);
  assert.throws(() => exports.NodeIQQNTWrapperSession(), (e) => e === error);
  assert.equal(f.control.snapshot().sessionObserved, false);
  assert.equal(JSON.stringify(f.reports).includes(error.message), false);
  f.control.stop();
});

test('constructor route preserves a fixed export and never bypasses inaccessible create methods', () => {
  const NativeSession = function () { throw new Error('No probe calls'); };
  const fixed = {};
  Object.defineProperty(fixed, 'NodeIQQNTWrapperSession', { value: NativeSession });
  const f = diagnosticProbe(fixed);
  assert.deepEqual(f.control.snapshot().hookFailure, { target: 'sessionConstructor', reason: 'fixed-property' });
  assert.equal(fixed.NodeIQQNTWrapperSession, NativeSession);
  Object.defineProperty(NativeSession, 'create', { get() { throw new Error('No getter calls'); } });
  const exports = { NodeIQQNTWrapperSession: NativeSession };
  const g = diagnosticProbe(exports);
  assert.deepEqual(g.control.snapshot().hookFailure, { target: 'factoryCreate', reason: 'accessor' });
  assert.equal(exports.NodeIQQNTWrapperSession, NativeSession);
});

test('constructor timeout and a later extension preserve cleanup and retained references stay inactive', () => {
  class NativeSession { init() {} getBuddyService() {} }
  const exports = { NodeIQQNTWrapperSession: NativeSession };
  const f = diagnosticProbe(exports);
  const retained = exports.NodeIQQNTWrapperSession;
  f.control.stop('timeout');
  assert.equal(exports.NodeIQQNTWrapperSession, NativeSession);
  const session = new retained();
  assert.equal(Object.hasOwn(session, 'init'), false);
  assert.equal(f.control.snapshot().sessionObserved, false);

  const g = diagnosticProbe(exports);
  function LaterExtension() {}
  exports.NodeIQQNTWrapperSession = LaterExtension;
  g.control.stop();
  assert.equal(exports.NodeIQQNTWrapperSession, LaterExtension);
  assert.equal(g.control.snapshot().cleanupComplete, false);
});

test('constructor route stops on wrong account without inspecting or invoking the buddy service', () => {
  let inspected = false;
  const service = new Proxy({}, { getOwnPropertyDescriptor() { inspected = true; throw new Error('Must not inspect'); } });
  class NativeSession { init() {} getBuddyService() { return service; } }
  const exports = { NodeIQQNTWrapperSession: NativeSession };
  const f = diagnosticProbe(exports);
  const session = new exports.NodeIQQNTWrapperSession();
  session.getBuddyService();
  session.init({ selfUin: '987654321' });
  assert.equal(f.control.snapshot().phase, 'account-mismatch');
  assert.equal(inspected, false);
  assert.equal(exports.NodeIQQNTWrapperSession, NativeSession);
});

test('static getNTWrapperSession observes only QQ calls and preserves arguments, receiver and returned instance', () => {
  const service = { reqToAddFriends() { throw new Error('No friend calls'); } };
  const session = { init() {}, getBuddyService() { return service; } };
  let calls = 0;
  const argument = 'PRIVATE_SESSION_SELECTOR';
  function NativeSession() { throw new Error('Probe must not create a session'); }
  NativeSession.getNTWrapperSession = function (value) {
    assert.equal(this, NativeSession); assert.equal(value, argument); calls++;
    return session;
  };
  const original = NativeSession.getNTWrapperSession;
  const exports = { NodeIQQNTWrapperSession: NativeSession };
  const f = diagnosticProbe(exports);
  assert.equal(calls, 0);
  assert.equal(exports.NodeIQQNTWrapperSession, NativeSession);
  assert.equal(f.control.snapshot().observationRoute, 'static-session-getter');
  assert.equal(NativeSession.getNTWrapperSession(argument), session);
  const initHook = session.init;
  assert.equal(NativeSession.getNTWrapperSession(argument), session);
  assert.equal(session.init, initHook);
  session.init({ selfUin: expectedUin });
  assert.equal(session.getBuddyService(), service);
  assert.equal(calls, 2);
  assert.equal(f.control.snapshot().phase, 'capability-present');
  assert.equal(NativeSession.getNTWrapperSession, original);
  assert.equal(f.control.snapshot().cleanupComplete, true);
  assert.equal(JSON.stringify(f.reports).includes(argument), false);
});

test('static session getter exceptions and accessors are not bypassed', () => {
  for (const mode of ['throws', 'accessor']) {
    function NativeSession() { throw new Error('No fallback constructor calls'); }
    const error = new Error('PRIVATE_GETTER_FAILURE');
    const method = () => { throw error; };
    Object.defineProperty(NativeSession, 'getNTWrapperSession', mode === 'accessor'
      ? { get() { throw error; } }
      : { value: method, writable: mode === 'throws', configurable: mode === 'throws' });
    const exports = { NodeIQQNTWrapperSession: NativeSession };
    const f = diagnosticProbe(exports);
    assert.equal(exports.NodeIQQNTWrapperSession, NativeSession);
    if (mode === 'throws') {
      assert.throws(() => NativeSession.getNTWrapperSession('ignored'), (e) => e === error);
      assert.equal(f.control.snapshot().sessionObserved, false);
      f.control.stop();
      assert.equal(NativeSession.getNTWrapperSession, method);
    } else {
      assert.deepEqual(f.control.snapshot().hookFailure,
        { target: 'sessionGetter', reason: mode === 'fixed' ? 'fixed-property' : 'accessor' });
      assert.equal(f.control.snapshot().cleanupComplete, true);
    }
    assert.equal(JSON.stringify(f.reports).includes(error.message), false);
  }
});

test('fixed static getter facade preserves the native constructor and descriptors without creating sessions', () => {
  const calls = { getter: 0, construct: 0 };
  const service = { reqToAddFriends() { throw new Error('Must not call'); } };
  let instance;
  let newTarget;
  class NativeSession {
    #brand = 7;
    constructor(arg) { calls.construct++; assert.equal(arg, argument); instance = this; newTarget = new.target; }
    init() { return this.#brand; }
    getBuddyService() { assert.equal(this.#brand, 7); return service; }
  }
  const argument = {};
  // Represents an instance created by QQ before the getter is called.
  const session = new NativeSession(argument);
  calls.construct = 0;
  const getter = function (arg) { assert.equal(this, NativeSession); assert.equal(arg, argument); calls.getter++; return session; };
  Object.defineProperty(NativeSession, 'getNTWrapperSession', { value: getter });
  const symbol = Symbol('native-static');
  const staticValue = {};
  Object.defineProperty(NativeSession, symbol, { value: staticValue });
  Object.defineProperty(NativeSession, 'lazy', { get() { throw new Error('Do not inspect getter values'); } });
  const originals = Object.getOwnPropertyDescriptors(NativeSession);
  const exports = { NodeIQQNTWrapperSession: NativeSession };
  const f = diagnosticProbe(exports);
  const facade = exports.NodeIQQNTWrapperSession;
  assert.equal(f.control.snapshot().observationRoute, 'static-session-getter-facade');
  assert.equal(f.control.snapshot().hookFailure, null);
  assert.deepEqual(calls, { getter: 0, construct: 0 });
  assert.deepEqual(Object.getOwnPropertyDescriptors(NativeSession), originals);
  assert.deepEqual(Reflect.ownKeys(facade), Reflect.ownKeys(NativeSession));
  for (const key of Reflect.ownKeys(originals)) {
    if (key !== 'getNTWrapperSession') assert.deepEqual(Object.getOwnPropertyDescriptor(facade, key), originals[key]);
  }
  assert.equal(facade[symbol], staticValue);
  assert.equal(facade.prototype, NativeSession.prototype);
  assert.equal(session instanceof facade, true);
  assert.equal(facade.getNTWrapperSession(argument), session);
  assert.deepEqual(calls, { getter: 1, construct: 0 });
  assert.equal(session.init({ selfUin: expectedUin }), 7);
  assert.equal(session.getBuddyService(), service);
  assert.equal(f.control.snapshot().phase, 'capability-present');
  assert.equal(f.control.snapshot().cleanupComplete, true);
  assert.equal(exports.NodeIQQNTWrapperSession, NativeSession);
  assert.deepEqual(Object.getOwnPropertyDescriptors(NativeSession), originals);
  // A QQ-retained facade still forwards after cleanup without installing observers.
  assert.equal(facade.getNTWrapperSession(argument), session);
  assert.equal(Object.hasOwn(session, 'init'), false);
  const other = new facade(argument);
  assert.equal(other, instance);
  assert.equal(newTarget, NativeSession);
  assert.equal(other instanceof NativeSession, true);
  assert.equal(Object.hasOwn(other, 'init'), false);
});

test('fixed getter facade preserves explicit receivers, arguments, errors and subclass construction', () => {
  const error = new Error('PRIVATE_NATIVE_ERROR');
  const receiver = {};
  const argument = {};
  let newTarget;
  function NativeSession() { newTarget = new.target; }
  NativeSession.prototype.init = function () {};
  NativeSession.prototype.getBuddyService = function () {};
  Object.defineProperty(NativeSession, 'getNTWrapperSession', { value(arg) {
    assert.equal(this, receiver); assert.equal(arg, argument); throw error;
  } });
  const exports = { NodeIQQNTWrapperSession: NativeSession };
  const f = diagnosticProbe(exports);
  const facade = exports.NodeIQQNTWrapperSession;
  assert.throws(() => facade.getNTWrapperSession.call(receiver, argument), (e) => e === error);
  class Derived extends facade {}
  const session = new Derived();
  assert.equal(newTarget, Derived);
  assert.equal(session instanceof Derived, true);
  assert.equal(JSON.stringify(f.reports).includes(error.message), false);
  f.control.stop();
});

test('fixed getter facade requires a replaceable export and respects later extension replacement', () => {
  function NativeSession() {}
  const getter = function () { throw new Error('No probe calls'); };
  Object.defineProperty(NativeSession, 'getNTWrapperSession', { value: getter });
  const fixedExports = Object.freeze({ NodeIQQNTWrapperSession: NativeSession });
  const f = diagnosticProbe(fixedExports);
  assert.deepEqual(f.control.snapshot().hookFailure, { target: 'sessionConstructor', reason: 'fixed-property' });
  assert.equal(NativeSession.getNTWrapperSession, getter);
  const exports = { NodeIQQNTWrapperSession: NativeSession };
  const g = diagnosticProbe(exports);
  function LaterExtension() {}
  exports.NodeIQQNTWrapperSession = LaterExtension;
  g.control.stop();
  assert.equal(g.control.snapshot().cleanupComplete, false);
  assert.equal(exports.NodeIQQNTWrapperSession, LaterExtension);
  assert.equal(NativeSession.getNTWrapperSession, getter);
});

test('fixed getter facade still gates service inspection on init identity and restores on mismatch', () => {
  let inspected = false;
  const service = new Proxy({}, { getOwnPropertyDescriptor() { inspected = true; throw new Error('Wrong account'); } });
  const session = { init() {}, getBuddyService() { return service; } };
  function NativeSession() {}
  Object.defineProperty(NativeSession, 'getNTWrapperSession', { value() { return session; } });
  const exports = { NodeIQQNTWrapperSession: NativeSession };
  const f = diagnosticProbe(exports);
  exports.NodeIQQNTWrapperSession.getNTWrapperSession(expectedUin);
  session.getBuddyService();
  assert.equal(inspected, false);
  session.init({ selfUin: '987654321' });
  assert.equal(f.control.snapshot().phase, 'account-mismatch');
  assert.equal(inspected, false);
  assert.equal(exports.NodeIQQNTWrapperSession, NativeSession);
});

test('getter account isolation still requires observed init and never trusts the selector argument', () => {
  const session = { init() {}, getBuddyService() { return {}; } };
  const factory = { getNTWrapperSession() { return session; } };
  const f = diagnosticProbe({ NodeIQQNTWrapperSession: factory });
  factory.getNTWrapperSession(expectedUin);
  session.getBuddyService();
  assert.equal(f.control.snapshot().identityMatched, false);
  session.init({ selfUin: '987654321' });
  assert.equal(f.control.snapshot().phase, 'account-mismatch');
  assert.equal(f.control.snapshot().reqToAddFriendsPresent, null);
});

test('named prototype diagnostics never call getters or modify prototypes', () => {
  function NativeSession() {}
  const prototype = NativeSession.prototype;
  const accessor = { get() { throw new Error('PRIVATE_ACCESSOR'); }, configurable: true };
  for (const key of ['getNTWrapperSession', 'init', 'getBuddyService']) Object.defineProperty(prototype, key, accessor);
  const before = Object.getOwnPropertyDescriptors(prototype);
  const f = diagnosticProbe({ NodeIQQNTWrapperSession: NativeSession });
  const state = f.control.snapshot();
  assert.equal(state.diagnostics.prototypeSessionGetter.kind, 'accessor');
  assert.equal(state.diagnostics.prototypeInit.kind, 'accessor');
  assert.equal(state.diagnostics.prototypeBuddyGetter.kind, 'accessor');
  assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), before);
  assert.equal(JSON.stringify(f.reports).includes('PRIVATE_'), false);
  f.control.stop();
});

test('a subsequent init with unknown identity invalidates an earlier account match', () => {
  const f = fixture(); f.load(); f.factory.create(); f.init();
  assert.equal(f.control.snapshot().identityMatched, true);
  f.init({}); f.session.getBuddyService();
  assert.equal(f.control.snapshot().identityMatched, false);
  assert.equal(f.control.snapshot().reqToAddFriendsPresent, null);
  f.expire(); assert.equal(f.control.snapshot().phase, 'timeout');
});

test('unconfigured entry point is inert outside QQ', () => {
  const entry = fileURLToPath(new URL('../plugins/qq-friend-probe/main.cjs', import.meta.url));
  const result = spawnSync(process.execPath, ['-e', 'const before=process.dlopen;require(process.argv[1]);if(before!==process.dlopen)throw Error("changed");', entry], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

function simulatedEntry({ badHash = false, enabled = true, inspectClientCode = false, badArchivePin = false, codeError } = {}) {
  const bytes = Buffer.from('simulated native bytes, never loaded');
  const config = { enabled, expectedUin, qqVersion: '9.9.26-44343',
    wrapperSha256: badHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
    reportDir: path.resolve('state', 'probes', 'SIMULATED-IN-MEMORY-ONLY'), timeoutMs: 1000,
    ...(inspectClientCode ? { inspectClientCode: true, applicationSha256: badArchivePin ? 'invalid' : 'a'.repeat(64) } : {}) };
  const writes = [];
  const loaded = [];
  const scheduled = [];
  const codeReads = [];
  const session = { init() { return 17; }, getBuddyService() { return { reqToAddFriends() { throw new Error('Forbidden'); } }; } };
  const factory = { create() { return session; } };
  const fakeProcess = { platform: 'win32', type: 'browser', versions: { electron: 'mock' }, pid: 0,
    dlopen(module) { loaded.push(true); module.exports = { NodeIQQNTWrapperSession: factory }; return 19; } };
  const fakeFs = {
    existsSync: () => true,
    readFileSync(filename) {
      if (filename.endsWith('config.json')) return JSON.stringify(config);
      if (filename.endsWith('package.json')) return JSON.stringify({ version: config.qqVersion });
      if (filename.endsWith('wrapper.node')) return bytes;
      throw new Error('Unexpected read');
    },
    realpathSync: (filename) => filename,
    statSync: () => ({ size: bytes.length }),
    mkdirSync() {},
    writeFileSync(filename, text) { writes.push({ filename, data: JSON.parse(text) }); },
  };
  const fakeRequire = Object.assign((name) => {
    if (name === 'node:fs') return fakeFs;
    if (name === 'original-fs') return fakeFs;
    if (name === './probe.cjs') return { startProbe };
    if (name === './client-code-evidence.cjs') return { collectClientCode: async (options) => {
      assert.equal(options.archiveFs, fakeFs);
      options.onStage('archive-read');
      if (codeError) throw codeError;
      codeReads.push({ archivePath: options.archivePath, archiveSha256: options.archiveSha256, allowed: options.shouldContinue() });
      return { phase: options.shouldContinue() ? 'complete' : 'cancelled', entries: [] };
    } };
    return require(name);
  }, { cache: {} });
  const module = { exports: {} };
  const context = vm.createContext({ require: fakeRequire, process: fakeProcess, module,
    __dirname: path.resolve('plugins', 'qq-friend-probe'), setImmediate: (fn) => scheduled.push(fn), console: { info() {}, warn() {} } });
  const source = fs.readFileSync(new URL('../plugins/qq-friend-probe/main.cjs', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  return { fakeProcess, factory, session, writes, loaded, scheduled, codeReads, stop: () => module.exports.stop() };
}

test('client code inspection is opt-in, deferred and requires successful version/hash/account checks', async () => {
  for (const options of [{}, { inspectClientCode: true, badHash: true }, { inspectClientCode: true, badArchivePin: true }]) {
    const f = simulatedEntry(options);
    try {
      f.fakeProcess.dlopen({}, 'C:/QQ/wrapper.node'); f.factory.create().init({ selfUin: expectedUin });
      assert.equal(f.scheduled.length, 0);
    } finally { f.stop(); }
  }
  const wrong = simulatedEntry({ inspectClientCode: true });
  try {
    wrong.fakeProcess.dlopen({}, 'C:/QQ/wrapper.node'); wrong.factory.create().init({ selfUin: '987654321' });
    assert.equal(wrong.scheduled.length, 0);
  } finally { wrong.stop(); }
  const f = simulatedEntry({ inspectClientCode: true });
  try {
    f.fakeProcess.dlopen({}, 'C:/QQ/wrapper.node'); const session = f.factory.create(); session.init({ selfUin: expectedUin });
    session.getBuddyService(); assert.equal(f.scheduled.length, 1); assert.equal(f.codeReads.length, 0);
    await f.scheduled[0](); assert.equal(f.codeReads.length, 1); assert.equal(f.codeReads[0].allowed, true);
    assert.equal(f.codeReads[0].archiveSha256, 'a'.repeat(64));
    assert.equal(f.writes.at(-1).data.phase, 'complete');
  } finally { f.stop(); }
});

test('explicit stop cancels scheduled static code inspection', async () => {
  const f = simulatedEntry({ inspectClientCode: true });
  f.fakeProcess.dlopen({}, 'C:/QQ/wrapper.node'); f.factory.create().init({ selfUin: expectedUin });
  f.stop(); await f.scheduled[0]();
  assert.equal(f.codeReads[0].allowed, false); assert.equal(f.writes.at(-1).data.phase, 'cancelled');
});

test('client inspection reports only fixed failure stage and allowed error code', async () => {
  for (const code of ['EISDIR', 'PRIVATE_CODE']) {
    const f = simulatedEntry({ inspectClientCode: true, codeError: Object.assign(new Error('PRIVATE_ERROR_CONTENT'), { code }) });
    try {
      f.fakeProcess.dlopen({}, 'C:/QQ/wrapper.node'); f.factory.create().init({ selfUin: expectedUin });
      await f.scheduled[0]();
      assert.equal(f.writes.at(-1).data.stage, 'archive-read');
      assert.equal(f.writes.at(-1).data.code, code === 'EISDIR' ? 'EISDIR' : 'UNCLASSIFIED');
      assert.equal(JSON.stringify(f.writes).includes('PRIVATE_'), false);
    } finally { f.stop(); }
  }
});

test('entry point checks version/hash and writes only sanitized JSON (all I/O simulated)', () => {
  const f = simulatedEntry();
  try {
    const module = {};
    assert.equal(f.fakeProcess.dlopen(module, 'C:/QQ/wrapper.node'), 19);
    const session = f.factory.create();
    assert.equal(session.init({ selfUin: expectedUin, d2Key: 'PRIVATE_CREDENTIAL' }, {}, {}, {}), 17);
    session.getBuddyService();
    const report = f.writes.at(-1).data;
    assert.equal(report.phase, 'capability-present');
    assert.equal(report.requestSent, false);
    assert.equal(report.loginOnlineVerified, false);
    assert.equal(JSON.stringify(f.writes).includes('PRIVATE_CREDENTIAL'), false);
    assert.equal(JSON.stringify(f.writes).includes(expectedUin), false);
  } finally { f.stop(); }
});

test('entry point refuses a changed binary without creating a session', () => {
  const f = simulatedEntry({ badHash: true });
  try {
    assert.equal(f.fakeProcess.dlopen({}, 'C:/QQ/wrapper.node'), 19);
    assert.equal(f.writes.at(-1).data.phase, 'wrapper-attestation-failed');
    assert.equal(f.writes.at(-1).data.sessionObserved, false);
  } finally { f.stop(); }
});

test('disabled entry point neither wraps the loader nor writes reports', () => {
  const f = simulatedEntry({ enabled: false });
  assert.equal(f.writes.length, 0);
  assert.equal(f.loaded.length, 0);
  assert.equal(f.stop(), undefined);
});

function fakePE() {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ'); bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(1, 70);
  bytes.writeUInt32LE(256, 104); bytes.writeUInt32LE(256, 108); bytes.writeUInt32LE(0x60000020, 124);
  Buffer.from('4889ce488b114c8b41084929d0488b4918e811223344', 'hex').copy(bytes, 300);
  return bytes;
}

test('offline binary preparation changes only the five-byte candidate instruction and preserves original bytes', () => {
  const original = fakePE(); const saved = Buffer.from(original);
  const result = makeCandidateDll(original);
  assert.deepEqual(original, saved);
  assert.equal(result.offset, 317); assert.equal(result.before, 'e811223344'); assert.equal(result.after, 'b801000000');
  assert.deepEqual(result.candidate.subarray(0, 317), original.subarray(0, 317));
  assert.deepEqual(result.candidate.subarray(322), original.subarray(322));
});

test('offline binary preparation rejects ambiguous patterns and non-executable sections', () => {
  const duplicated = fakePE(); duplicated.subarray(300, 322).copy(duplicated, 400);
  assert.throws(() => makeCandidateDll(duplicated), /exactly one/);
  const dataOnly = fakePE(); dataOnly.writeUInt32LE(0x40000040, 124);
  assert.throws(() => makeCandidateDll(dataOnly), /executable/);
});

test('offline binary preparation rejects malformed and wrong-architecture PE files', () => {
  assert.throws(() => makeCandidateDll(Buffer.alloc(0)), /PE/);
  const wrongArch = fakePE(); wrongArch.writeUInt16LE(0x14c, 68);
  assert.throws(() => makeCandidateDll(wrongArch), /x64/);
  const truncated = fakePE(); truncated.writeUInt16LE(65535, 70);
  assert.throws(() => makeCandidateDll(truncated), /section table/);
});

test('temporary bootstrap loads the probe before original QQ and continues QQ if probe loading fails', () => {
  const entry = path.resolve("probe's folder", 'main.cjs');
  for (const failProbe of [false, true]) {
    const calls = [];
    const resourcesPath = path.resolve('SIMULATED-QQ', 'resources');
    const context = vm.createContext({
      require(name) {
        if (name === 'node:path') return path;
        calls.push(name);
        if (name === entry && failProbe) throw new Error('Missing probe file');
        return {};
      },
      process: { resourcesPath }, setImmediate: (fn) => fn(), console: { warn() {} },
      launcher: { installPathPkgJson: { main: './app_launcher/qq-bridge-probe.cjs' } },
    });
    vm.runInContext(makeBootstrap(entry), context);
    assert.deepEqual(calls, [entry, path.join(resourcesPath, 'app', './application.asar/app_launcher/index.js')]);
    assert.equal(context.launcher.installPathPkgJson.main, './application.asar/app_launcher/index.js');
  }
});
