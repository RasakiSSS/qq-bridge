'use strict';

// Isolated, opt-in local capability. This module never loads QQ, obtains a
// wrapper, schedules work, or accepts native arguments from a caller.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isProxy, isPromise } = require('node:util').types;
const adapter = require('./friend-adapter.cjs');
const buildEnvelope = adapter.buildObservedAddBuddyEnvelope;
const readOutcome = adapter.readAddBuddyOutcome || adapter.readAddBuddyResult;

const CONFIG_KEYS = new Set(['enabled', 'mode', 'qqVersion', 'wrapperSha256', 'majorSha256',
  'expectedUin', 'allowedTargetUins', 'journalDir', 'timeoutMs']);
const REQUEST_KEYS = new Set(['action', 'accountUin', 'targetUin', 'targetUid', 'reason',
  'idempotencyKey', 'dryRun', 'answer', 'remark', 'addFriendSetting', 'defaultCategory',
  'onlyChat', 'qzoneNotWatch', 'qzoneNotWatched', 'sourceId', 'sourceSubId']);
const DEPENDENCY_KEYS = new Set(['getBinding', 'lookupRelationship', 'authorize']);
const BINDING_KEYS = new Set(['accountUin', 'qqVersion', 'wrapperSha256', 'majorSha256',
  'receiver', 'method', 'epoch', 'isCurrent']);
const RELATIONSHIP_KEYS = new Set(['friend', 'pending', 'accountUin', 'targetUin', 'addFriendSetting']);
const LEDGER_KEYS = new Set(['version', 'keyHash', 'scopeHash', 'requestHash']);
const OUTCOME_KEYS = new Set(['result', 'errorMessagePresent', 'businessSuccessKnown',
  'relationshipChanged', 'responseResult', 'errorCode', 'uiSuccessConditionMet']);
const HASH = /^[a-f0-9]{64}$/;

class FriendRuntimeError extends Error {
  constructor(code) { super(code); this.name = 'FriendRuntimeError'; this.code = code; }
}
function fail(code) { throw new FriendRuntimeError(code); }
function snapshot(value, allowed) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) fail('ERR_INVALID_RECORD');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail('ERR_INVALID_RECORD');
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) fail('ERR_UNKNOWN_FIELD');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('ERR_ACCESSOR_FIELD');
    out[key] = descriptor.value;
  }
  return out;
}
function localFunction(value) { return typeof value === 'function' && !isProxy(value); }
function promiseValue(value) {
  return new Promise((resolve, reject) => {
    Reflect.apply(Promise.prototype.then, value, [resolve, reject]);
  });
}
function rejectAsync(value, code) {
  if (isPromise(value)) {
    // A loader callback is synchronous by contract. Still consume accidental
    // async rejection so refusing its capability cannot become an unhandled one.
    void promiseValue(value).catch(() => {});
    fail(code);
  }
}
function errorCode(error, fallback) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function') || isProxy(error)) return fallback;
  const prototype = Object.getPrototypeOf(error);
  if (prototype !== FriendRuntimeError.prototype && prototype !== adapter.FriendAdapterError.prototype) return fallback;
  const code = Object.getOwnPropertyDescriptor(error, 'code');
  return code && Object.hasOwn(code, 'value') && typeof code.value === 'string' && /^ERR_[A-Z_]{1,64}$/.test(code.value)
    ? code.value : fallback;
}
function result(status, code, outcome) {
  const invoked = status !== 'not_called';
  return Object.freeze({ status, code, nativeInvoked: invoked, requestSent: invoked ? null : false,
    accepted: invoked ? null : false, friendshipEstablished: null,
    ...(outcome ? { outcome } : {}) });
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function normalizeConfig(raw) {
  const c = snapshot(raw, CONFIG_KEYS);
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') fail('ERR_INVALID_ENABLED');
  if (c.mode !== undefined && c.mode !== 'disabled' && c.mode !== 'send-once') fail('ERR_INVALID_MODE');
  const timeoutMs = c.timeoutMs === undefined ? 10000 : c.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail('ERR_INVALID_TIMEOUT');
  if (c.journalDir !== undefined && (typeof c.journalDir !== 'string' || !path.isAbsolute(c.journalDir)
    || c.journalDir.includes('\0') || /^[\\/]{2}/.test(c.journalDir))) fail('ERR_INVALID_JOURNAL');
  if (c.enabled !== true) return Object.freeze({ enabled: false, timeoutMs });
  if (c.mode !== 'send-once') fail('ERR_INVALID_MODE');
  if (c.majorSha256 !== adapter.MAJOR_SHA256) fail('ERR_MAJOR_MISMATCH');
  if (!c.journalDir) fail('ERR_INVALID_JOURNAL');
  const normalized = adapter.normalizeAdapterConfig({ enabled: true, mode: 'dry-run', qqVersion: c.qqVersion,
    wrapperSha256: c.wrapperSha256, majorSha256: c.majorSha256, expectedUin: c.expectedUin,
    allowedTargetUins: c.allowedTargetUins });
  // The pure builder accepts raw config fields, not normalizeAdapterConfig's
  // additional protocolVersion field. Its target array is already a private copy.
  const { protocolVersion, ...planning } = normalized;
  return Object.freeze({ enabled: true, timeoutMs, journalDir: path.resolve(c.journalDir), planning: Object.freeze(planning) });
}

// The trusted LOCAL loader supplies a fixed addBuddy function reference and its
// receiver, never a method name. Pins below compare its assertion; they cannot
// prove module loading or attest that this function is really QQ's addBuddy.
// The loader must advance a nonnegative integer epoch whenever its binding changes.
function bindingSnapshot(getBinding, config, original) {
  const raw = Reflect.apply(getBinding, undefined, []);
  rejectAsync(raw, 'ERR_BINDING_UNAVAILABLE');
  if (raw === null || raw === undefined) fail('ERR_BINDING_UNAVAILABLE');
  const b = snapshot(raw, BINDING_KEYS);
  for (const key of ['accountUin', 'qqVersion', 'wrapperSha256', 'majorSha256']) {
    const expected = key === 'accountUin' ? config.expectedUin : config[key];
    if (b[key] !== expected) fail('ERR_BINDING_MISMATCH');
  }
  if (!Number.isSafeInteger(b.epoch) || b.epoch < 0) fail('ERR_BINDING_EPOCH');
  if (!b.receiver || !['object', 'function'].includes(typeof b.receiver) || isProxy(b.receiver)
    || !localFunction(b.method) || !localFunction(b.isCurrent)) fail('ERR_BINDING_UNAVAILABLE');
  if (original && [...BINDING_KEYS].some(key => b[key] !== original[key])) fail('ERR_BINDING_CHANGED');
  return Object.freeze(b);
}
function assertCurrent(binding) {
  const current = Reflect.apply(binding.isCurrent, undefined, []);
  rejectAsync(current, 'ERR_BINDING_STALE');
  if (current !== true) fail('ERR_BINDING_STALE');
}
function validateRelationship(raw, accountUin, targetUin, expectedSetting) {
  const r = snapshot(raw, RELATIONSHIP_KEYS);
  if (typeof r.friend !== 'boolean' || typeof r.pending !== 'boolean'
    || r.accountUin !== accountUin || r.targetUin !== targetUin) fail('ERR_RELATIONSHIP_UNKNOWN');
  if (r.friend) fail('ERR_ALREADY_FRIEND');
  if (r.pending) fail('ERR_RELATIONSHIP_PENDING');
  if (r.addFriendSetting !== expectedSetting) fail('ERR_TARGET_SETTING_CHANGED');
}
function mappingVerified(envelope) {
  if (envelope.nativeMappingVerified !== true) fail('ERR_NATIVE_MAPPING_UNVERIFIED');
  if (envelope.nativeCall.method !== 'addBuddy' || envelope.nativeCall.args.length !== 3) fail('ERR_NATIVE_MAPPING_UNVERIFIED');
}
function sanitizedOutcome(raw) {
  if (!localFunction(readOutcome)) fail('ERR_OUTCOME_UNAVAILABLE');
  const value = snapshot(readOutcome(raw), OUTCOME_KEYS);
  if (!Number.isInteger(value.result) || value.result < -0x80000000 || value.result > 0x7fffffff) fail('ERR_NATIVE_REPLY');
  const out = { result: value.result };
  for (const key of ['responseResult', 'errorCode']) {
    if (value[key] === undefined || value[key] === null) out[key] = null;
    else if (Number.isSafeInteger(value[key])) out[key] = value[key];
    else fail('ERR_NATIVE_REPLY');
  }
  // No error strings, request/response bodies, UI-success or friendship claims.
  return Object.freeze(out);
}

async function directoryIdentity(journalDir) {
  const info = await fs.lstat(journalDir);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('ERR_JOURNAL_UNAVAILABLE');
  const canonical = await fs.realpath(journalDir);
  // Reject path aliases through symlinks; the operator owns this local directory
  // and its parents. Network mounts and hostile local writers cannot be attested.
  if (path.relative(canonical, journalDir) !== '') fail('ERR_JOURNAL_UNAVAILABLE');
  return { dev: info.dev, ino: info.ino };
}
async function assertDirectory(journalDir, original) {
  const current = await directoryIdentity(journalDir);
  if (current.dev !== original.dev || current.ino !== original.ino) fail('ERR_JOURNAL_CHANGED');
}
async function existingReservation(filename) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512) fail('ERR_JOURNAL_CORRUPT');
  const handle = await fs.open(filename, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 512) fail('ERR_JOURNAL_CORRUPT');
    // Bounded read even if an external writer grows the file after stat.
    const bytes = Buffer.alloc(513);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 512) fail('ERR_JOURNAL_CORRUPT');
    const v = snapshot(JSON.parse(bytes.toString('utf8', 0, bytesRead)), LEDGER_KEYS);
    if (v.version !== 1 || !HASH.test(v.keyHash) || !HASH.test(v.scopeHash) || !HASH.test(v.requestHash)) fail('ERR_JOURNAL_CORRUPT');
    return v;
  } finally { await handle.close(); }
}
async function reserveFile(filename, metadata, kind) {
  let handle;
  try { handle = await fs.open(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await existingReservation(filename);
    if (kind === 'key' && (previous.scopeHash !== metadata.scopeHash || previous.requestHash !== metadata.requestHash
      || previous.keyHash !== metadata.keyHash)) fail('ERR_IDEMPOTENCY_CONFLICT');
    fail(kind === 'key' ? 'ERR_ALREADY_RESERVED' : 'ERR_TARGET_RESERVED');
  }
  try {
    await handle.writeFile(JSON.stringify(metadata) + '\n', 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
}
async function reserve(journalDir, request) {
  const directory = await directoryIdentity(journalDir);
  const metadata = {
    version: 1,
    // Global key scope within this journal also blocks a key reused by another account.
    keyHash: hash(JSON.stringify(['key-v1', request.idempotencyKey])),
    scopeHash: hash(JSON.stringify(['target-v1', request.accountUin, request.targetUin])),
    requestHash: hash(JSON.stringify(Object.keys(request).sort().map(key => [key, request[key]]))),
  };
  await reserveFile(path.join(journalDir, `key-${metadata.keyHash}.json`), metadata, 'key');
  await reserveFile(path.join(journalDir, `target-${metadata.scopeHash}.json`), metadata, 'target');
  // fsync the directory where Node supports it. On Windows Node cannot portably
  // flush directory handles; file fsync protects process-crash reservations,
  // while power-loss persistence still depends on the operator's filesystem.
  if (process.platform !== 'win32') {
    const handle = await fs.open(journalDir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await assertDirectory(journalDir, directory);
  // No deletion, rollback or expiry: partial writes and failed preflight after
  // reservation consume the capability too. An uncertain attempt never retries.
}

function createFriendRuntime(rawConfig = {}, rawDependencies = {}) {
  const config = normalizeConfig(rawConfig);
  const dependencies = Object.freeze(snapshot(rawDependencies, DEPENDENCY_KEYS));
  for (const key of DEPENDENCY_KEYS) {
    if (dependencies[key] !== undefined && !localFunction(dependencies[key])) fail('ERR_INVALID_DEPENDENCY');
  }
  let stopped = false;
  let active = null;

  function validated(raw, dryRun) {
    if (!config.enabled) fail('ERR_RUNTIME_DISABLED');
    if (stopped) fail('ERR_RUNTIME_STOPPED');
    const input = snapshot(raw, REQUEST_KEYS);
    if (input.dryRun !== dryRun) fail('ERR_EXPLICIT_ACTION_REQUIRED');
    // All accepted request fields are primitives; the adapter enforces their
    // exact types. Build a private validated request, never accept caller args.
    input.dryRun = true;
    const envelope = buildEnvelope(input, config.planning);
    input.accountUin = envelope.plan.accountUin;
    return { input: Object.freeze(input), envelope };
  }
  function prepare(raw) {
    try {
      const { envelope } = validated(raw, true);
      return Object.freeze({ ...result('not_called', 'PREPARED'),
        nativeMappingVerified: envelope.nativeMappingVerified === true });
    } catch (error) { return result('not_called', errorCode(error, 'ERR_VALIDATION')); }
  }
  function stop() {
    stopped = true;
    if (active) active.cancel('ERR_RUNTIME_STOPPED');
    return result('not_called', 'STOPPED');
  }
  function execute(raw) {
    if (stopped) return Promise.resolve(result('not_called', 'ERR_RUNTIME_STOPPED'));
    if (active) return Promise.resolve(result('not_called', 'ERR_BUSY'));
    let resolveCaller;
    const caller = new Promise(resolve => { resolveCaller = resolve; });
    const operation = { cancelled: false, invoked: false, settled: false, cancel: null };
    // Set the latch before validation or any external callback: reentry cannot act.
    active = operation;
    let timer;
    function finish(value) {
      if (operation.settled) return;
      operation.settled = true;
      clearTimeout(timer);
      resolveCaller(value);
    }
    operation.cancel = code => {
      operation.cancelled = true;
      finish(result(operation.invoked ? 'unknown' : 'not_called', code));
    };
    function assertActive() {
      if (stopped || operation.cancelled || active !== operation) fail('ERR_RUNTIME_STOPPED');
    }
    timer = setTimeout(() => operation.cancel('ERR_TIMEOUT'), config.timeoutMs);
    async function run() {
      try {
        const { input, envelope } = validated(raw, false);
        mappingVerified(envelope);
        if (!localFunction(dependencies.getBinding) || !localFunction(dependencies.lookupRelationship)) fail('ERR_LOCAL_CAPABILITY_MISSING');
        const original = bindingSnapshot(dependencies.getBinding, config.planning);
        assertCurrent(original);
        assertActive();
        let relationship;
        try {
          const pending = Reflect.apply(dependencies.lookupRelationship, undefined,
            [Object.freeze({ accountUin: input.accountUin, targetUin: input.targetUin,
              sourceId: input.sourceId, sourceSubId: input.sourceSubId })]);
          if (!isPromise(pending)) fail('ERR_RELATIONSHIP_UNKNOWN');
          relationship = await promiseValue(pending);
        } catch { fail('ERR_RELATIONSHIP_UNKNOWN'); }
        assertActive();
        validateRelationship(relationship, input.accountUin, input.targetUin, input.addFriendSetting);
        assertCurrent(bindingSnapshot(dependencies.getBinding, config.planning, original));
        assertActive();
        try { await reserve(config.journalDir, input); }
        catch (error) { fail(errorCode(error, 'ERR_JOURNAL_UNAVAILABLE')); }
        assertActive();
        if (dependencies.authorize && await dependencies.authorize() !== true) fail('ERR_AUTHORIZATION');
        assertActive();
        // Rebuild fresh private Uint8Arrays only after all awaits. No args from
        // prepare(), IPC, the loader or the original caller are ever consumed.
        const invocation = buildEnvelope(input, config.planning);
        mappingVerified(invocation);
        const binding = bindingSnapshot(dependencies.getBinding, config.planning, original);
        assertCurrent(binding);
        assertActive();
        operation.invoked = true;
        // No await between the last current check and this single fixed call.
        const returned = Reflect.apply(binding.method, binding.receiver, invocation.nativeCall.args);
        let reply = returned;
        if (isPromise(returned)) {
          // Use the intrinsic Promise method, not an arbitrary reply.then getter.
          reply = await new Promise((resolve, reject) => {
            Reflect.apply(Promise.prototype.then, returned, [resolve, reject]);
          });
        }
        if (operation.cancelled || stopped) return;
        // The result belongs to the original session. A login/service change
        // while native work was pending must not be reported as a current result.
        try { assertCurrent(bindingSnapshot(dependencies.getBinding, config.planning, original)); }
        catch { finish(result('unknown', 'ERR_BINDING_LOST')); return; }
        if (operation.cancelled || stopped) return;
        let outcome;
        try { outcome = sanitizedOutcome(reply); }
        catch { finish(result('unknown', 'ERR_NATIVE_REPLY')); return; }
        finish(result('native_returned', 'NATIVE_RETURNED', outcome));
      } catch (error) {
        if (!operation.cancelled) finish(result(operation.invoked ? 'unknown' : 'not_called',
          operation.invoked ? 'ERR_NATIVE_REJECTED' : errorCode(error, 'ERR_PREFLIGHT')));
      } finally {
        // A timeout settles the caller but retains this latch until the pending
        // operation settles. Rejections remain handled; late results are ignored.
        if (active === operation) active = null;
      }
    }
    void run();
    return caller;
  }
  return Object.freeze({ prepare, execute, stop, invalidate: stop });
}

module.exports = { FriendRuntimeError, createFriendRuntime };
