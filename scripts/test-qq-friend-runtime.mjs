import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import adapter from '../plugins/qq-friend-probe/friend-adapter.cjs';
import production from '../plugins/qq-friend-probe/friend-runtime.cjs';

// No QQ/native module is read or loaded. The fixture only changes the pure
// adapter's mapping gate; every supplied addBuddy below is a JavaScript mock.
const require = createRequire(import.meta.url);
const runtimePath = fileURLToPath(new URL('../plugins/qq-friend-probe/friend-runtime.cjs', import.meta.url));
const source = await fs.readFile(runtimePath, 'utf8');
const accountUin = '1927418344';
const targetUin = '280656999';
const otherTarget = '280657000';
const pins = { qqVersion: adapter.QQ_VERSION, wrapperSha256: adapter.WRAPPER_SHA256, majorSha256: adapter.MAJOR_SHA256 };
const success = () => ({ result: 0, errMsg: '', rsp: { result: 0, errorCode: 0 } });
const relationship = (target = targetUin) => ({ accountUin, targetUin: target, friend: false, pending: false, addFriendSetting: 1 });
function request(extra = {}) {
  return { action: 'request', accountUin, targetUin, idempotencyKey: 'offline-test-key-001', dryRun: false,
    answer: 'PRIVATE_ANSWER', remark: 'PRIVATE_REMARK', reason: 'PRIVATE_REASON', addFriendSetting: 1,
    defaultCategory: 0, onlyChat: false, qzoneNotWatch: false, qzoneNotWatched: true,
    sourceId: 5, sourceSubId: 2, ...extra };
}
function config(journalDir, extra = {}) {
  return { enabled: true, mode: 'send-once', ...pins, expectedUin: accountUin,
    allowedTargetUins: [targetUin, otherTarget], journalDir, timeoutMs: 3000, ...extra };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function loadFixture({ verified = true, adapterChanges = {}, fsChanges = {} } = {}) {
  const module = { exports: {} };
  const fixtureAdapter = { ...adapter,
    buildObservedAddBuddyEnvelope(input, rawConfig) {
      const envelope = adapter.buildObservedAddBuddyEnvelope(input, rawConfig);
      return Object.freeze({ ...envelope, nativeMappingVerified: verified });
    }, ...adapterChanges };
  const allowed = new Set(['node:path', 'node:crypto', 'node:util']);
  const localRequire = name => {
    if (name === './friend-adapter.cjs') return fixtureAdapter;
    if (name === 'node:fs/promises') return { ...fs, ...fsChanges };
    assert.ok(allowed.has(name), `unexpected runtime dependency: ${name}`);
    return require(name);
  };
  new Script(`(function(module, exports, require) {\n${source}\n})`, { filename: runtimePath })
    .runInThisContext()(module, module.exports, localRequire);
  return module.exports;
}
// Exercise the real, statically verified builder in every ordinary runtime
// test. Fixture overrides are only for explicit faults and unverified mapping.
const verifiedRuntime = production;
async function tempJournal(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-friend-runtime-test-'));
  t.after(async () => {
    const absolute = path.resolve(dir);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.match(path.basename(absolute), /^qq-friend-runtime-test-/);
    // Only this test's verified direct regular files are removed, never recursive.
    for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
      assert.equal(entry.isFile(), true);
      const filename = path.resolve(absolute, entry.name);
      assert.equal(path.dirname(filename), absolute);
      await fs.unlink(filename);
    }
    await fs.rmdir(absolute);
  });
  return dir;
}
async function setup(t, options = {}) {
  const journalDir = options.journalDir || await tempJournal(t);
  const calls = [];
  const receiver = {};
  // A native wrapper getter must never be used to acquire the function.
  Object.defineProperty(receiver, 'addBuddy', { get() { assert.fail('wrapper getter was read'); } });
  const binding = { accountUin, ...pins, receiver, epoch: 1, isCurrent: () => true,
    method: function addBuddy(...args) { calls.push({ receiver: this, args }); return success(); } };
  const deps = { getBinding: () => binding, lookupRelationship: async ({ targetUin: target }) => relationship(target) };
  if (options.binding) Object.assign(binding, options.binding);
  if (options.deps) Object.assign(deps, options.deps);
  const factory = options.runtime || verifiedRuntime;
  const rawConfig = config(journalDir, options.config);
  const runtime = factory.createFriendRuntime(rawConfig, deps);
  return { runtime, binding, deps, calls, receiver, journalDir, rawConfig };
}

test('final bridge authorization runs after reservation and denies sending on pause or token loss', async t => {
  for (const allowed of [true, false]) {
    const s = await setup(t, { deps: { authorize: async () => {
      assert.equal((await fs.readdir(s.journalDir)).length, 2);
      return allowed;
    } } });
    const value = await s.runtime.execute(request());
    assert.equal(value.nativeInvoked, allowed);
    if (!allowed) assert.equal(value.code, 'ERR_AUTHORIZATION');
  }
});
function notCalled(value, code) {
  assert.equal(value.status, 'not_called');
  assert.equal(value.nativeInvoked, false);
  assert.equal(value.requestSent, false);
  if (code) assert.equal(value.code, code);
}
function unknown(value, code) {
  assert.equal(value.status, 'unknown');
  assert.equal(value.nativeInvoked, true);
  assert.equal(value.requestSent, null);
  assert.equal(value.accepted, null);
  assert.equal(value.friendshipEstablished, null);
  if (code) assert.equal(value.code, code);
}

test('default is disabled; small explicit API exposes no generic dispatcher', async () => {
  const runtime = production.createFriendRuntime();
  assert.deepEqual(Object.keys(runtime), ['prepare', 'execute', 'stop', 'invalidate']);
  assert.ok(Object.isFrozen(runtime));
  notCalled(runtime.prepare(request({ dryRun: true })), 'ERR_RUNTIME_DISABLED');
  notCalled(await runtime.execute(request()), 'ERR_RUNTIME_DISABLED');
});

test('unverified mapping always fails closed before local dependencies', async t => {
  for (const verified of [false, undefined, 1, 'true', null]) {
    const s = await setup(t, { runtime: loadFixture({ verified: verified === undefined ? false : verified }),
      deps: { getBinding() { assert.fail('binding read before mapping proof'); } } });
    const prepared = s.runtime.prepare(request({ dryRun: true }));
    notCalled(prepared, 'PREPARED');
    assert.equal(prepared.nativeMappingVerified, false);
    notCalled(await s.runtime.execute(request()), 'ERR_NATIVE_MAPPING_UNVERIFIED');
    assert.deepEqual(await fs.readdir(s.journalDir), []);
  }
});

test('configuration requires explicit local mode, exact pins, bounded timeout and absolute journal', async t => {
  const dir = await tempJournal(t);
  const invalid = [
    { enabled: 'true' }, { mode: 'dry-run' }, { mode: 'disabled' }, { mode: undefined },
    { qqVersion: 'wrong' }, { wrapperSha256: 'a'.repeat(64) }, { majorSha256: 'b'.repeat(64) }, { majorSha256: undefined },
    { expectedUin: '1' }, { allowedTargetUins: [] }, { allowedTargetUins: [accountUin] },
    { journalDir: undefined }, { journalDir: 'relative' }, { journalDir: '\\\\server\\journal' },
    { timeoutMs: 0 }, { timeoutMs: 120001 }, { timeoutMs: 1.5 }, { extra: true },
  ];
  for (const extra of invalid) assert.throws(() => verifiedRuntime.createFriendRuntime(config(dir, extra)));
  const disabled = verifiedRuntime.createFriendRuntime(config(dir, { enabled: false }));
  notCalled(await disabled.execute(request()), 'ERR_RUNTIME_DISABLED');
  const accessor = config(dir);
  Object.defineProperty(accessor, 'enabled', { get() { assert.fail('config getter'); } });
  assert.throws(() => verifiedRuntime.createFriendRuntime(accessor), { code: 'ERR_ACCESSOR_FIELD' });
  const proxy = new Proxy(config(dir), { ownKeys() { assert.fail('config proxy trap'); } });
  assert.throws(() => verifiedRuntime.createFriendRuntime(proxy), { code: 'ERR_INVALID_RECORD' });
  const targets = [targetUin];
  Object.defineProperty(targets, '0', { get() { assert.fail('allowlist getter'); } });
  assert.throws(() => verifiedRuntime.createFriendRuntime(config(dir, { allowedTargetUins: targets })));
});

test('prepare invokes nothing, produces no reusable args, execute requires literal dryRun:false', async t => {
  const s = await setup(t, { deps: {
    getBinding() { assert.fail('prepare consulted a binding'); },
    lookupRelationship() { assert.fail('prepare consulted a relationship'); },
  } });
  const prepared = s.runtime.prepare(request({ dryRun: true }));
  notCalled(prepared, 'PREPARED');
  assert.equal('nativeCall' in prepared, false);
  assert.equal('clientEnvelope' in prepared, false);
  for (const dryRun of [true, undefined, 0, 'false']) notCalled(await s.runtime.execute(request({ dryRun })), 'ERR_EXPLICIT_ACTION_REQUIRED');
  notCalled(s.runtime.prepare(request()), 'ERR_EXPLICIT_ACTION_REQUIRED');
  notCalled(await s.runtime.execute(prepared));
  assert.deepEqual(await fs.readdir(s.journalDir), []);
});

test('invalid source, setting, flags, action, targets and caller-built args cannot invoke', async t => {
  const s = await setup(t);
  const cases = [
    { action: 'delete-friend' }, { accountUin: otherTarget }, { targetUin: accountUin }, { targetUin: '12345678' },
    { targetUid: 'u_0123456789' }, { sourceId: 1 }, { sourceSubId: 1 }, { addFriendSetting: 0 },
    { onlyChat: 1 }, { qzoneNotWatch: undefined }, { qzoneNotWatched: null },
    { answer: '' }, { answer: new Uint8Array([1]) }, { answer: 'x'.repeat(501) }, { remark: undefined },
    { defaultCategory: -1 }, { defaultCategory: 0x100000000 }, { idempotencyKey: 'tiny' },
    { reason: 'x'.repeat(201) }, { nativeCall: { method: 'addBuddy', args: [] } }, { epoch: 1 },
  ];
  for (const extra of cases) notCalled(await s.runtime.execute(request(extra)));
  const getter = request();
  Object.defineProperty(getter, 'answer', { get() { assert.fail('input getter'); } });
  notCalled(await s.runtime.execute(getter), 'ERR_ACCESSOR_FIELD');
  notCalled(await s.runtime.execute(new Proxy(request(), { ownKeys() { assert.fail('input proxy'); } })), 'ERR_INVALID_RECORD');
  notCalled(await s.runtime.execute(Object.assign(Object.create({ inherited: true }), request())), 'ERR_INVALID_RECORD');
  notCalled(await s.runtime.execute({ ...request(), [Symbol('unknown')]: true }), 'ERR_UNKNOWN_FIELD');
  assert.equal(s.calls.length, 0);
  assert.deepEqual(await fs.readdir(s.journalDir), []);
});

test('local binding and async relationship capabilities are mandatory and cannot come from requests', async t => {
  const dir = await tempJournal(t);
  for (const deps of [{}, { getBinding: () => null }, { lookupRelationship: async () => relationship() }]) {
    const runtime = verifiedRuntime.createFriendRuntime(config(dir), deps);
    notCalled(await runtime.execute(request()), 'ERR_LOCAL_CAPABILITY_MISSING');
  }
  for (const deps of [{ getBinding: 'addBuddy' }, { invoke() {} }, new Proxy({}, {})]) {
    assert.throws(() => verifiedRuntime.createFriendRuntime(config(dir), deps));
  }
  const s = await setup(t, { journalDir: dir, deps: { getBinding: () => null } });
  notCalled(await s.runtime.execute(request()), 'ERR_BINDING_UNAVAILABLE');
});

test('wrong binding account, pins, epoch, receiver and stale current checks never invoke', async t => {
  for (const changed of [
    { accountUin: otherTarget }, { qqVersion: 'wrong' }, { wrapperSha256: 'bad' }, { majorSha256: 'bad' },
    { epoch: undefined }, { epoch: -1 }, { epoch: '1' }, { epoch: 1.5 },
    { isCurrent: () => false }, { isCurrent: async () => true }, { isCurrent() { throw new Error('stale'); } },
    { receiver: null }, { receiver: new Proxy({}, {}) }, { method: 'addBuddy' }, { method: new Proxy(() => {}, {}) },
  ]) {
    const s = await setup(t, { binding: changed });
    notCalled(await s.runtime.execute(request()));
    assert.equal(s.calls.length, 0);
    assert.deepEqual(await fs.readdir(s.journalDir), []);
  }
  const s = await setup(t);
  const b = { ...s.binding };
  Object.defineProperty(b, 'method', { get() { assert.fail('binding method getter'); } });
  s.deps.getBinding = () => b; // Dependencies themselves were snapshotted; make a fresh executor.
  const runtime = verifiedRuntime.createFriendRuntime(s.rawConfig, s.deps);
  notCalled(await runtime.execute(request()), 'ERR_ACCESSOR_FIELD');
  const proxyRuntime = verifiedRuntime.createFriendRuntime(s.rawConfig, { ...s.deps, getBinding: () => new Proxy(s.binding, {}) });
  notCalled(await proxyRuntime.execute(request()), 'ERR_INVALID_RECORD');
});

test('friend, pending, unknown, erroneous, mismatched and accessor relationships skip before reservation', async t => {
  const bad = [
    { ...relationship(), friend: true }, { ...relationship(), pending: true }, null, undefined, {},
    { ...relationship(), friend: 0 }, { ...relationship(), pending: undefined },
    { ...relationship(), accountUin: otherTarget }, { ...relationship(), targetUin: otherTarget },
    { ...relationship(), extra: true }, new Proxy(relationship(), {}),
  ];
  const getter = relationship();
  Object.defineProperty(getter, 'friend', { get() { assert.fail('relationship getter'); } });
  bad.push(getter);
  for (const value of bad) {
    const s = await setup(t, { deps: { lookupRelationship: async () => value } });
    notCalled(await s.runtime.execute(request()));
    assert.equal(s.calls.length, 0);
    assert.deepEqual(await fs.readdir(s.journalDir), []);
  }
  const s = await setup(t, { deps: { lookupRelationship: async () => { throw new Error('private relationship failure'); } } });
  notCalled(await s.runtime.execute(request()));
  assert.equal(s.calls.length, 0);
});

test('fresh target setting must match and lookup receives the validated source pair', async t => {
  for (const addFriendSetting of [undefined, null, 0, 2, '1']) {
    const s = await setup(t, { deps: { lookupRelationship: async query => {
      assert.deepEqual(query, { accountUin, targetUin, sourceId: 5, sourceSubId: 2 });
      assert.ok(Object.isFrozen(query));
      return { ...relationship(), addFriendSetting };
    } } });
    notCalled(await s.runtime.execute(request()), 'ERR_TARGET_SETTING_CHANGED');
    assert.equal(s.calls.length, 0);
    assert.deepEqual(await fs.readdir(s.journalDir), []);
  }
});

test('binding identity is revalidated after lookup and after reservation, including epoch changes', async t => {
  for (const field of ['epoch', 'receiver', 'method', 'isCurrent']) {
    const gate = deferred();
    const s = await setup(t, { deps: { lookupRelationship: () => gate.promise } });
    const pending = s.runtime.execute(request());
    s.binding[field] = field === 'epoch' ? 2 : field === 'receiver' ? {} : () => true;
    gate.resolve(relationship());
    notCalled(await pending, 'ERR_BINDING_CHANGED');
    assert.equal(s.calls.length, 0);
    assert.deepEqual(await fs.readdir(s.journalDir), []);
  }
  const s = await setup(t);
  let count = 0;
  const runtime = verifiedRuntime.createFriendRuntime(s.rawConfig, {
    ...s.deps, getBinding() { if (++count === 3) s.binding.epoch++; return s.binding; },
  });
  notCalled(await runtime.execute(request()), 'ERR_BINDING_CHANGED');
  assert.equal(count, 3);
  assert.equal(s.calls.length, 0);
  assert.equal((await fs.readdir(s.journalDir)).length, 2);
  const retry = verifiedRuntime.createFriendRuntime(s.rawConfig, s.deps);
  notCalled(await retry.execute(request()), 'ERR_ALREADY_RESERVED');
});

test('single fixed invocation preserves receiver and exactly three freshly constructed arguments', async t => {
  const order = [];
  const s = await setup(t);
  s.binding.isCurrent = () => { order.push('current'); return true; };
  s.binding.method = function addBuddy(...args) {
    assert.equal(order.at(-1), 'current');
    order.push('native');
    s.calls.push({ receiver: this, args });
    return success();
  };
  const value = await s.runtime.execute(request());
  assert.equal(value.status, 'native_returned');
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].receiver, s.receiver);
  const args = s.calls[0].args;
  assert.equal(args.length, 3);
  assert.equal(args[0], 'GuildContactAddApplication');
  assert.deepEqual(args[1].targetInfo, { uin: targetUin });
  assert.equal(args[1].sourceId, 5);
  assert.equal(args[1].sourceSubId, 2);
  assert.equal(args[1].addFriendSetting, 1);
  assert.equal(args[1].isContactFriend, false);
  assert.equal(new TextDecoder().decode(args[1].remark), 'PRIVATE_REMARK');
  assert.equal(new TextDecoder().decode(args[1].name), targetUin);
  assert.equal(args[2] instanceof Uint8Array, true);
  assert.equal(args[2].length, 0);
  assert.notEqual(args[1].name, args[1].name1);
  assert.deepEqual(value.outcome, { result: 0, responseResult: 0, errorCode: 0 });
  assert.equal(value.requestSent, null);
  assert.equal(value.accepted, null);
  assert.equal(value.friendshipEstablished, null);
  assert.ok(Object.isFrozen(value.outcome));
});

test('caller config/request/dependency mutation and earlier candidate byte mutation cannot change invocation', async t => {
  const gate = deferred();
  let firstEnvelope;
  let builds = 0;
  const fixture = loadFixture({ adapterChanges: {
    buildObservedAddBuddyEnvelope(input, rawConfig) {
      const envelope = adapter.buildObservedAddBuddyEnvelope(input, rawConfig);
      if (++builds === 1) firstEnvelope = envelope;
      return { ...envelope, nativeMappingVerified: true };
    },
  } });
  const s = await setup(t, { runtime: fixture, deps: { lookupRelationship: () => gate.promise } });
  const raw = request();
  const pending = s.runtime.execute(raw);
  raw.targetUin = otherTarget;
  raw.answer = 'MUTATED';
  raw.remark = 'MUTATED';
  raw.onlyChat = true;
  raw.idempotencyKey = 'changed-key-002';
  s.rawConfig.allowedTargetUins.splice(0);
  s.rawConfig.expectedUin = otherTarget;
  s.deps.getBinding = () => { assert.fail('mutable dependency used'); };
  firstEnvelope.nativeCall.args[1].remark.fill(0);
  firstEnvelope.nativeCall.args[1].permissionInfo.fill(0);
  gate.resolve(relationship());
  assert.equal((await pending).status, 'native_returned');
  assert.equal(builds, 2);
  const args = s.calls[0].args;
  assert.equal(args[1].targetInfo.uin, targetUin);
  assert.equal(args[1].answer, 'PRIVATE_ANSWER');
  assert.equal(new TextDecoder().decode(args[1].remark), 'PRIVATE_REMARK');
  assert.equal(JSON.parse(new TextDecoder().decode(args[1].permissionInfo)).onlyChat, false);
  assert.notEqual(args[1].remark, firstEnvelope.nativeCall.args[1].remark);
});

test('durable dedupe spans instances: identical key, changed target/payload and different key same target', async t => {
  const s = await setup(t);
  assert.equal((await s.runtime.execute(request())).status, 'native_returned');
  const other = verifiedRuntime.createFriendRuntime(s.rawConfig, s.deps);
  notCalled(await other.execute(request()), 'ERR_ALREADY_RESERVED');
  notCalled(await other.execute(request({ targetUin: otherTarget })), 'ERR_IDEMPOTENCY_CONFLICT');
  notCalled(await other.execute(request({ answer: 'changed' })), 'ERR_IDEMPOTENCY_CONFLICT');
  notCalled(await other.execute(request({ idempotencyKey: 'different-key-002' })), 'ERR_TARGET_RESERVED');
  assert.equal(s.calls.length, 1);
  for (const filename of await fs.readdir(s.journalDir)) {
    assert.match(filename, /^(key|target)-[a-f0-9]{64}\.json$/);
    const text = await fs.readFile(path.join(s.journalDir, filename), 'utf8');
    assert.ok(text.length <= 512);
    for (const secret of [accountUin, targetUin, 'offline-test-key-001', 'PRIVATE_ANSWER', 'PRIVATE_REMARK', 'PRIVATE_REASON']) {
      assert.equal(text.includes(secret), false);
    }
    assert.deepEqual(Object.keys(JSON.parse(text)), ['version', 'keyHash', 'scopeHash', 'requestHash']);
  }
});

test('concurrent executors with different keys for one target invoke at most once', async t => {
  const s = await setup(t);
  const other = verifiedRuntime.createFriendRuntime(s.rawConfig, s.deps);
  const values = await Promise.all([s.runtime.execute(request()), other.execute(request({ idempotencyKey: 'parallel-key-002' }))]);
  assert.equal(values.filter(v => v.status === 'native_returned').length, 1);
  assert.equal(values.filter(v => v.status === 'not_called').length, 1);
  assert.equal(s.calls.length, 1);
});

test('crash-like pending reservation and corrupt reservation cannot be reused', async t => {
  const entered = deferred(), pendingNative = deferred();
  const s = await setup(t, { config: { timeoutMs: 80 }, binding: { method() { entered.resolve(); return pendingNative.promise; } } });
  const pending = s.runtime.execute(request());
  await entered.promise;
  const other = verifiedRuntime.createFriendRuntime(s.rawConfig, s.deps);
  notCalled(await other.execute(request()), 'ERR_ALREADY_RESERVED');
  notCalled(await other.execute(request({ idempotencyKey: 'crash-retry-002' })), 'ERR_TARGET_RESERVED');
  unknown(await pending, 'ERR_TIMEOUT');
  pendingNative.resolve(success());
  await nextTurn();
  const corrupt = await setup(t);
  const key = createHash('sha256').update(JSON.stringify(['key-v1', request().idempotencyKey])).digest('hex');
  await fs.writeFile(path.join(corrupt.journalDir, `key-${key}.json`), '');
  notCalled(await corrupt.runtime.execute(request()));
  assert.equal(corrupt.calls.length, 0);
});

test('missing journal and failed write/fsync/close never invoke and retain partial reservations', async t => {
  const dir = await tempJournal(t);
  const missing = await setup(t, { journalDir: path.join(dir, 'missing') });
  notCalled(await missing.runtime.execute(request()), 'ERR_JOURNAL_UNAVAILABLE');
  assert.deepEqual(await fs.readdir(dir), []);
  for (const stage of ['open', 'writeFile', 'sync', 'close']) {
    const factory = loadFixture({ fsChanges: {
      async open(filename, flags, mode) {
        if (stage === 'open') throw Object.assign(new Error('denied'), { code: 'EACCES' });
        const handle = await fs.open(filename, flags, mode);
        if (flags !== 'wx') return handle;
        return {
          async writeFile(...args) { if (stage === 'writeFile') throw new Error('disk full'); return handle.writeFile(...args); },
          async sync() { if (stage === 'sync') throw new Error('sync failure'); return handle.sync(); },
          async close() { await handle.close(); if (stage === 'close') throw new Error('close failure'); },
        };
      },
    } });
    const s = await setup(t, { runtime: factory });
    notCalled(await s.runtime.execute(request()), 'ERR_JOURNAL_UNAVAILABLE');
    assert.equal(s.calls.length, 0);
    assert.equal((await fs.readdir(s.journalDir)).length, stage === 'open' ? 0 : 1);
    if (stage !== 'open') {
      const retry = verifiedRuntime.createFriendRuntime(s.rawConfig, s.deps);
      notCalled(await retry.execute(request()));
      assert.equal(s.calls.length, 0);
    }
  }
});

test('serial latch blocks concurrent and synchronous reentry, then permits an unrelated target', async t => {
  const gate = deferred();
  const s = await setup(t, { deps: { lookupRelationship: () => gate.promise } });
  const first = s.runtime.execute(request());
  notCalled(await s.runtime.execute(request({ targetUin: otherTarget })), 'ERR_BUSY');
  let reentry;
  s.binding.method = function addBuddy() { assert.fail('changed method must not execute'); };
  gate.resolve(relationship());
  notCalled(await first, 'ERR_BINDING_CHANGED');
  const fresh = await setup(t);
  fresh.binding.method = function addBuddy(...args) {
    fresh.calls.push(args);
    reentry = fresh.runtime.execute(request({ targetUin: otherTarget, idempotencyKey: 'other-target-002' }));
    return success();
  };
  assert.equal((await fresh.runtime.execute(request())).status, 'native_returned');
  notCalled(await reentry, 'ERR_BUSY');
  assert.equal((await fresh.runtime.execute(request({ targetUin: otherTarget, idempotencyKey: 'other-target-002' }))).status, 'native_returned');
  assert.equal(fresh.calls.length, 2);
});

test('timeout settles caller as unknown; pending native blocks new action and late rejection is handled', async t => {
  for (const reject of [false, true]) {
    const entered = deferred(), native = deferred();
    let calls = 0;
    const s = await setup(t, { config: { timeoutMs: 80 }, binding: { method() { calls++; entered.resolve(); return native.promise; } } });
    const pending = s.runtime.execute(request());
    await entered.promise;
    const value = await pending;
    unknown(value, 'ERR_TIMEOUT');
    notCalled(await s.runtime.execute(request({ targetUin: otherTarget })), 'ERR_BUSY');
    if (reject) native.reject(new Error('late native secret')); else native.resolve(success());
    await nextTurn();
    assert.equal(value.status, 'unknown');
    notCalled(await s.runtime.execute(request()), 'ERR_ALREADY_RESERVED');
    assert.equal(calls, 1);
  }
});

test('preflight timeout prevents later invocation and stop/invalidate are terminal before and during native', async t => {
  const gate = deferred();
  const s = await setup(t, { config: { timeoutMs: 25 }, deps: { lookupRelationship: () => gate.promise } });
  const pending = s.runtime.execute(request());
  notCalled(await pending, 'ERR_TIMEOUT');
  gate.resolve(relationship());
  await nextTurn();
  assert.equal(s.calls.length, 0);
  assert.deepEqual(await fs.readdir(s.journalDir), []);
  for (const method of ['stop', 'invalidate']) {
    const entered = deferred(), native = deferred();
    const live = await setup(t, { binding: { method() { entered.resolve(); return native.promise; } } });
    const operation = live.runtime.execute(request());
    await entered.promise;
    live.runtime[method]();
    const value = await operation;
    unknown(value, 'ERR_RUNTIME_STOPPED');
    native.resolve(success());
    await nextTurn();
    notCalled(await live.runtime.execute(request({ targetUin: otherTarget })), 'ERR_RUNTIME_STOPPED');
    notCalled(live.runtime.prepare(request({ dryRun: true })), 'ERR_RUNTIME_STOPPED');
    assert.equal(value.status, 'unknown');
  }
  const waiting = deferred();
  const stopped = await setup(t, { deps: { lookupRelationship: () => waiting.promise } });
  const operation = stopped.runtime.execute(request());
  stopped.runtime.stop();
  notCalled(await operation, 'ERR_RUNTIME_STOPPED');
  waiting.resolve(relationship());
  await nextTurn();
  assert.equal(stopped.calls.length, 0);
});

test('isCurrent is checked immediately before invocation and can invalidate without sending', async t => {
  const s = await setup(t);
  let checks = 0;
  s.binding.isCurrent = () => ++checks < 3;
  notCalled(await s.runtime.execute(request()), 'ERR_BINDING_STALE');
  assert.equal(checks, 3);
  assert.equal(s.calls.length, 0);
  assert.equal((await fs.readdir(s.journalDir)).length, 2);
  const other = await setup(t);
  other.binding.isCurrent = () => { other.runtime.invalidate(); return true; };
  notCalled(await other.runtime.execute(request()), 'ERR_RUNTIME_STOPPED');
  assert.equal(other.calls.length, 0);
});

test('synchronous throw and rejected native Promise are unknown, sanitized and permanently reserved', async t => {
  for (const method of [() => { throw new Error('PRIVATE_NATIVE_ERROR'); }, () => Promise.reject(new Error('PRIVATE_NATIVE_ERROR'))]) {
    const s = await setup(t, { binding: { method } });
    const value = await s.runtime.execute(request());
    unknown(value, 'ERR_NATIVE_REJECTED');
    assert.equal(JSON.stringify(value).includes('PRIVATE_NATIVE_ERROR'), false);
    notCalled(await s.runtime.execute(request()), 'ERR_ALREADY_RESERVED');
  }
});

test('account or service replacement during native wait makes result unknown without retry', async t => {
  for (const change of ['accountUin', 'method', 'epoch', 'isCurrent']) {
    const entered = deferred(), pending = deferred();
    const s = await setup(t, { binding: { method() { entered.resolve(); return pending.promise; } } });
    const operation = s.runtime.execute(request());
    await entered.promise;
    if (change === 'accountUin') s.binding.accountUin = otherTarget;
    if (change === 'method') s.binding.method = () => assert.fail('replacement invoked');
    if (change === 'epoch') s.binding.epoch++;
    if (change === 'isCurrent') s.binding.isCurrent = () => false;
    pending.resolve(success());
    unknown(await operation, 'ERR_BINDING_LOST');
    assert.equal((await fs.readdir(s.journalDir)).length, 2);
  }
});

test('native numeric summaries preserve every code uncertainty and never claim delivery or friendship', async t => {
  const cases = [
    [{ result: 0, errMsg: '' }, { result: 0, responseResult: null, errorCode: null }],
    [{ result: 7, errMsg: 'PRIVATE_ERROR', rsp: { result: 0, errorCode: 0 } }, { result: 7, responseResult: 0, errorCode: 0 }],
    [{ result: 0, errMsg: '', rsp: { result: 8, errorCode: 0 } }, { result: 0, responseResult: 8, errorCode: 0 }],
    [{ result: 0, errMsg: '', rsp: { result: 0, errorCode: 9 } }, { result: 0, responseResult: 0, errorCode: 9 }],
    [{ result: 0, errMsg: '', rsp: { result: '0', errorCode: null } }, { result: 0, responseResult: null, errorCode: null }],
    [{ result: 0, errMsg: '', rsp: new Proxy({}, {}) }, { result: 0, responseResult: null, errorCode: null }],
  ];
  for (const [reply, outcome] of cases) {
    const s = await setup(t, { binding: { method: () => reply } });
    const value = await s.runtime.execute(request());
    assert.equal(value.status, 'native_returned');
    assert.deepEqual(value.outcome, outcome);
    assert.equal(value.requestSent, null);
    assert.equal(value.accepted, null);
    assert.equal(value.friendshipEstablished, null);
    assert.equal(JSON.stringify(value).includes('PRIVATE_ERROR'), false);
  }
});

test('malformed native replies, proxies and accessor outcomes are unknown without running getters', async t => {
  const getter = { result: 0, errMsg: '' };
  Object.defineProperty(getter, 'result', { get() { assert.fail('reply getter'); } });
  const thenGetter = { result: 0, errMsg: '' };
  Object.defineProperty(thenGetter, 'then', { get() { assert.fail('reply then getter'); } });
  for (const reply of [undefined, null, 0, {}, { result: '0', errMsg: '' }, { result: 0x80000000, errMsg: '' },
    { result: 0, errMsg: 0 }, { result: 0, errMsg: '', secret: 'private' }, new Proxy(success(), {}), getter, thenGetter]) {
    const s = await setup(t, { binding: { method: () => reply } });
    unknown(await s.runtime.execute(request()), 'ERR_NATIVE_REPLY');
  }
  const s = await setup(t, { runtime: loadFixture({ adapterChanges: { readAddBuddyOutcome: undefined, readAddBuddyResult: undefined } }) });
  unknown(await s.runtime.execute(request()), 'ERR_NATIVE_REPLY');
});
