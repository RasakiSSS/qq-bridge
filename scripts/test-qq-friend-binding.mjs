import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startProbe } = require('../plugins/qq-friend-probe/probe.cjs');
const pins = require('../plugins/qq-friend-probe/friend-adapter.cjs');
const account = '123456789';
const wrapperPath = path.resolve('state', 'binding-fixture', pins.QQ_VERSION, 'resources', 'app', 'wrapper.node');

function fixture(extra = {}) {
  const reports = [], bindings = [];
  let timer;
  let service = { addBuddy() { assert.fail('observer called addBuddy'); } };
  const session = {
    init() { if (extra.initError) throw extra.initError; return extra.initResult; },
    getBuddyService() { return {}; },
    getAddBuddyService() { return service; },
  };
  let selectedSession = session;
  const factory = { create: () => selectedSession };
  const runtime = { platform: 'win32', versions: { electron: '37.1.0' }, type: 'browser',
    dlopen(module) { module.exports = { NodeIQQNTWrapperSession: factory }; } };
  const originals = { load: runtime.dlopen, init: session.init, getter: session.getAddBuddyService };
  const options = { runtime, expectedUin: account, attestWrapper: () => true,
    onReport: r => reports.push(r), onBinding: b => bindings.push(b),
    timers: { setTimeout(fn) { timer = fn; return { unref() {} }; }, clearTimeout() {} }, ...extra.options };
  const control = extra.start ? extra.start(runtime) : startProbe(options);
  function load() { const module = {}; runtime.dlopen(module, wrapperPath); return module; }
  function ready() { load(); factory.create(); session.init({ selfUin: account }); session.getBuddyService(); session.getAddBuddyService(); }
  return { runtime, session, factory, control, originals, reports, bindings, load, ready,
    get service() { return service; }, set service(v) { service = v; }, expire: () => timer(),
    selectSession: value => { selectedSession = value; },
    latest: () => bindings.at(-1) };
}

test('observes QQ-owned service only, keeps original method, never puts capability in reports', () => {
  const f = fixture();
  f.load(); f.factory.create();
  f.session.getAddBuddyService();
  assert.equal(f.bindings.length, 0);
  f.session.init({ selfUin: account });
  const binding = f.latest();
  assert.equal(binding.receiver, f.service);
  assert.equal(binding.method, f.service.addBuddy);
  assert.equal(binding.accountUin, account);
  assert.equal(binding.isCurrent(), true);
  f.session.getBuddyService(); // Does not end this explicit binding mode.
  assert.equal(f.control.snapshot().active, true);
  f.session.getAddBuddyService();
  assert.equal(f.latest(), binding);
  const serialized = JSON.stringify(f.reports);
  for (const secret of ['receiver', 'isCurrent', account]) assert.equal(serialized.includes(secret), false);
  f.control.stop();
  assert.equal(binding.isCurrent(), false);
  assert.equal(f.latest(), null);
  assert.equal(f.runtime.dlopen, f.originals.load);
  assert.equal(f.session.init, f.originals.init);
  assert.equal(f.session.getAddBuddyService, f.originals.getter);
});

test('wrong account, accessor/proxy identity and failed/async init never supply a binding', () => {
  const accessor = {};
  Object.defineProperty(accessor, 'selfUin', { get() { assert.fail('identity getter'); } });
  for (const config of [{ selfUin: '987654321' }, accessor, new Proxy({}, { getOwnPropertyDescriptor() { assert.fail('identity proxy'); } })]) {
    const f = fixture(); f.load(); f.factory.create(); f.session.getAddBuddyService(); f.session.init(config);
    assert.equal(f.bindings.some(Boolean), false); f.control.stop();
  }
  const failure = new Error('private native failure');
  const throwing = fixture({ initError: failure }); throwing.load(); throwing.factory.create();
  assert.throws(() => throwing.session.init({ selfUin: account }), e => e === failure);
  throwing.session.getAddBuddyService();
  assert.equal(throwing.bindings.some(Boolean), false); throwing.control.stop();
  const asynchronous = fixture({ initResult: Promise.resolve() }); asynchronous.ready();
  assert.equal(asynchronous.bindings.some(Boolean), false);
  assert.equal(asynchronous.control.snapshot().phase, 'unsupported-async-init');
});

test('service replacement revokes old generation; method mutation and null return invalidate', () => {
  const f = fixture(); f.ready(); const first = f.latest();
  f.service = { addBuddy() { assert.fail('replacement called'); } };
  f.session.getAddBuddyService(); const second = f.latest();
  assert.equal(first.isCurrent(), false); assert.equal(second.isCurrent(), true);
  assert.ok(second.epoch > first.epoch);
  f.service.addBuddy = () => assert.fail('changed method called');
  assert.equal(second.isCurrent(), false);
  f.session.getAddBuddyService(); const third = f.latest();
  assert.equal(third.isCurrent(), true);
  f.service = null; f.session.getAddBuddyService();
  assert.equal(third.isCurrent(), false); assert.equal(f.latest(), null);
  f.control.stop();
});

test('reinit revokes before original init runs, even when original throws', () => {
  let f, bound, calls = 0;
  f = fixture();
  f.session.init = function () {
    if (++calls > 1) { assert.equal(bound.isCurrent(), false); throw new Error('reinit'); }
  };
  f.ready(); bound = f.latest();
  assert.throws(() => f.session.init({ selfUin: account }));
  assert.equal(bound.isCurrent(), false);
  assert.equal(f.control.snapshot().phase, 'account-reinitialized');
});

test('new session, wrapper reload and timeout revoke live capabilities', () => {
  for (const action of ['session', 'wrapper', 'timeout']) {
    const f = fixture(); f.ready(); const bound = f.latest();
    if (action === 'session') {
      const second = { init() {}, getBuddyService() {}, getAddBuddyService() {} };
      f.selectSession(second); f.factory.create(); second.init({ selfUin: account });
      assert.equal(f.control.snapshot().phase, 'session-replaced');
    } else if (action === 'wrapper') f.load();
    else f.expire();
    assert.equal(bound.isCurrent(), false); assert.equal(f.latest(), null);
    assert.equal(f.control.snapshot().active, false);
  }
});

test('borrowed init or service getter cannot attach another receiver to the expected identity', () => {
  for (const action of ['init', 'getter']) {
    const f = fixture(); f.load(); f.factory.create();
    if (action === 'init') Reflect.apply(f.session.init, {}, [{ selfUin: account }]);
    else {
      f.session.init({ selfUin: account });
      Reflect.apply(f.session.getAddBuddyService, {}, []);
    }
    assert.equal(f.control.snapshot().phase, 'session-receiver-mismatch');
    assert.equal(f.bindings.some(Boolean), false);
  }
});

test('binding callback failure restores hooks, and observation modes cannot be mixed', () => {
  const f = fixture({ options: { onBinding(b) { if (b) throw new Error('private callback failure'); } } });
  f.ready();
  assert.equal(f.control.snapshot().phase, 'observer-error');
  assert.equal(f.runtime.dlopen, f.originals.load);
  assert.throws(() => startProbe({ runtime: {}, expectedUin: account, attestWrapper() {}, onReport() {},
    onBinding() {}, requestObservation: { targetUin: '987654321', qqVersion: pins.QQ_VERSION, wrapperSha256: pins.WRAPPER_SHA256 } }));
});

function loaderFixture(overrides = {}) {
  const source = fs.readFileSync(new URL('../plugins/qq-friend-probe/friend-binding.cjs', import.meta.url), 'utf8');
  const data = new Map([[wrapperPath, Buffer.from('wrapper')],
    [path.join(path.dirname(wrapperPath), 'major.node'), Buffer.from('major')],
    [path.join(path.dirname(wrapperPath), 'package.json'), JSON.stringify({ version: pins.QQ_VERSION })]]);
  const hashes = { wrapper: pins.WRAPPER_SHA256, major: pins.MAJOR_SHA256, ...overrides.hashes };
  const fakeFs = { realpathSync: p => p, statSync: p => ({ isFile: () => data.has(p), size: 7 }),
    readFileSync: p => { if (!data.has(p)) throw new Error('Missing file'); return data.get(p); }, ...overrides.fs };
  const module = { exports: {} };
  const modules = { 'node:fs': fakeFs, 'node:path': path,
    'node:crypto': { createHash: () => ({ update: bytes => ({ digest: () => hashes[String(bytes)] }) }) },
    './probe.cjs': { startProbe }, './friend-adapter.cjs': pins };
  new vm.Script(`(function(module, exports, require) {${source}\n})`).runInThisContext()(module, module.exports,
    name => { assert.ok(Object.hasOwn(modules, name)); return modules[name]; });
  return { ...module.exports, data };
}

test('loader independently checks actual paths, files and metadata before exposing binding', () => {
  const loader = loaderFixture();
  const f = fixture({ start: runtime => loader.startFriendBinding({ runtime, cache: {}, wrapperPath, expectedUin: account }) });
  try {
    assert.equal(f.control.getBinding(), null); f.ready();
    const binding = f.control.getBinding();
    assert.equal(binding.receiver, f.service); assert.equal(binding.method, f.service.addBuddy);
    assert.equal(binding.wrapperSha256, pins.WRAPPER_SHA256); assert.equal(binding.majorSha256, pins.MAJOR_SHA256);
    assert.equal(binding.qqVersion, pins.QQ_VERSION);
    f.session.init({ selfUin: account });
    assert.equal(binding.isCurrent(), false); assert.equal(f.control.getBinding(), null);
  } finally { f.control.stop(); }
});

test('loader rejects each mismatched file hash, metadata, alias and unsupported process', () => {
  for (const overrides of [{ hashes: { wrapper: 'bad' } }, { hashes: { major: 'bad' } },
    { fs: { realpathSync: p => p + '.other' } },
    { fs: { readFileSync: p => path.basename(p) === 'package.json' ? '{"version":"wrong"}' : Buffer.from(path.basename(p, '.node')) } }]) {
    const loader = loaderFixture(overrides);
    const f = fixture({ start: runtime => loader.startFriendBinding({ runtime, cache: {}, wrapperPath, expectedUin: account }) });
    try { f.ready(); assert.equal(f.control.getBinding(), null); assert.equal(f.control.snapshot().active, false); }
    finally { f.control.stop(); }
  }
  const loader = loaderFixture();
  assert.throws(() => loader.startFriendBinding({ runtime: { platform: 'linux' }, wrapperPath, expectedUin: account }));
  assert.throws(() => loader.startFriendBinding({ runtime: { platform: 'win32', versions: { electron: '37' }, type: 'renderer' }, wrapperPath, expectedUin: account }));
});

test('same-session buddy handles keep earlier listeners valid; reinit revokes every handle', () => {
  const received = [];
  const f = fixture({ options: { onBuddyBinding: b => received.push(b) } });
  f.ready(); const first = received.at(-1);
  assert.equal(first.accountUin, account); assert.equal(first.isCurrent(), true);
  f.service = { addBuddy() {} }; f.session.getAddBuddyService();
  assert.equal(received.at(-1), first); assert.equal(first.isCurrent(), true);
  f.session.getBuddyService(); // fixture creates a new service each time
  assert.equal(first.isCurrent(), true); assert.equal(received.at(-1).isCurrent(), true);
  const second = received.at(-1); f.session.init({ selfUin: account });
  assert.equal(second.isCurrent(), false); assert.equal(first.isCurrent(), false); assert.equal(received.at(-1), null);
});

test('buddy binding refuses borrowed service receivers and cannot be enabled without binding mode', () => {
  const received = []; const f = fixture({ options: { onBuddyBinding: b => received.push(b) } });
  f.ready(); const bound = received.at(-1);
  f.session.getBuddyService.call({}); assert.equal(bound.isCurrent(), false);
  assert.equal(f.control.snapshot().phase, 'session-receiver-mismatch');
  assert.throws(() => fixture({ options: { onBinding: null, onBuddyBinding() {} } }));
});

test('production mode acquires the fixed AddBuddy getter after verified init, without UI or session creation', () => {
  const f = fixture({ options: { persistent: true, acquireAddService: true } });
  f.load(); f.factory.create();
  assert.equal(f.bindings.some(Boolean), false);
  f.session.init({ selfUin: account });
  assert.equal(f.latest().receiver, f.service); assert.equal(f.latest().isCurrent(), true);
  assert.throws(() => f.expire()); // persistent mode did not schedule an expiry
  f.control.stop(); assert.equal(f.latest(), null);
});
