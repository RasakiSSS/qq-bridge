'use strict';

// Pure offline planning. No QQ loader, native service, network or sender is held
// here. Supplied pins constrain construction; they are not runtime attestation.
const { isProxy } = require('node:util').types;

const PROTOCOL_VERSION = 1;
const QQ_VERSION = '9.9.26-44343';
const WRAPPER_SHA256 = '29de02c5bec028643fc5d597e269f15be8bc75f7ea1620e53b50c6ff900288f2';
const MAJOR_SHA256 = 'aa23a73baf7cd41ad28969ce0f227789b936093838bb398e16e3e24672ac16f3';
const ROUTE = 'add-buddy';
const ACTION = 'request';
const MODES = new Set(['observe', 'dry-run']);
const CONFIG_KEYS = new Set([
  'enabled', 'mode', 'qqVersion', 'wrapperSha256', 'majorSha256', 'expectedUin', 'allowedTargetUins'
]);
const REQUEST_KEYS = new Set([
  'action', 'accountUin', 'targetUin', 'targetUid', 'reason', 'idempotencyKey', 'dryRun'
]);
const ENVELOPE_KEYS = new Set([
  ...REQUEST_KEYS, 'answer', 'remark', 'addFriendSetting', 'defaultCategory',
  'onlyChat', 'qzoneNotWatch', 'qzoneNotWatched', 'sourceId', 'sourceSubId'
]);

// Scope of the one observed group-temporary-chat route, not universal defaults.
const OBSERVED_SOURCE_ID = 5;
const OBSERVED_SOURCE_SUB_ID = 2;
const OBSERVED_CALL_FROM = 'GuildContactAddApplication';

class FriendAdapterError extends Error {
  constructor(code, message) { super(message); this.name = 'FriendAdapterError'; this.code = code; }
}
function fail(code, message) { throw new FriendAdapterError(code, message); }

// Snapshot only own data descriptors. Later reads never reach inherited getters,
// including an accessor inserted into Object.prototype for an omitted field.
function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) {
    fail('ERR_INVALID_RECORD', `${label} must be a plain record`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail('ERR_INVALID_RECORD', `${label} must be a plain record`);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) fail('ERR_UNKNOWN_FIELD', `${label} contains an unknown field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('ERR_ACCESSOR_FIELD', `${label} cannot contain accessor fields`);
    out[key] = descriptor.value;
  }
  return out;
}
function uin(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{4,19}$/.test(value) || BigInt(value) > 0xffffffffffffffffn) {
    fail('ERR_INVALID_UIN', `${label} must be a decimal QQ account string within uint64`);
  }
  return value;
}
function optionalUid(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^u_[A-Za-z0-9_-]{10,128}$/.test(value)) fail('ERR_INVALID_UID', 'targetUid has an invalid format');
  return value;
}
function targets(value, self) {
  if (!value || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype) fail('ERR_INVALID_TARGETS', 'allowedTargetUins must be a plain array');
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isInteger(length) || length < 1 || length > 100 || Reflect.ownKeys(value).length !== length + 1) {
    fail('ERR_INVALID_TARGETS', 'allowedTargetUins must contain 1 to 100 own data entries');
  }
  const list = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('ERR_INVALID_TARGETS', 'allowedTargetUins cannot contain holes or accessors');
    const target = uin(descriptor.value, 'allowedTargetUins entry');
    if (target === self) fail('ERR_INVALID_TARGETS', 'adapter target cannot be the bot account');
    list.push(target);
  }
  return Object.freeze([...new Set(list)]);
}
function normalizeAdapterConfig(raw = {}) {
  const input = record(raw, CONFIG_KEYS, 'adapter config');
  const enabled = input.enabled === true;
  const mode = input.mode === undefined ? 'observe' : input.mode;
  if (typeof mode !== 'string' || (!MODES.has(mode) && mode !== 'disabled')) fail('ERR_INVALID_MODE', 'adapter mode must be disabled, observe, or dry-run');
  if (!enabled) return Object.freeze({ protocolVersion: PROTOCOL_VERSION, enabled: false, mode: 'disabled',
    qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256, majorSha256: null, expectedUin: null, allowedTargetUins: Object.freeze([]) });
  if (mode === 'disabled') fail('ERR_INVALID_MODE', 'enabled adapter cannot use disabled mode');
  if (input.qqVersion !== QQ_VERSION) fail('ERR_VERSION_MISMATCH', 'QQ version is not supported by this adapter');
  if (input.wrapperSha256 !== WRAPPER_SHA256) fail('ERR_WRAPPER_MISMATCH', 'wrapper hash is not supported by this adapter');
  if (input.majorSha256 !== undefined && input.majorSha256 !== MAJOR_SHA256) fail('ERR_MAJOR_MISMATCH', 'client construction hash is not supported by this adapter');
  const expectedUin = uin(input.expectedUin, 'expectedUin');
  return Object.freeze({ protocolVersion: PROTOCOL_VERSION, enabled: true, mode, qqVersion: QQ_VERSION,
    wrapperSha256: WRAPPER_SHA256, majorSha256: input.majorSha256 ?? null, expectedUin,
    allowedTargetUins: targets(input.allowedTargetUins, expectedUin) });
}
function assertRuntimeAttestation(input = {}) {
  const pins = record(input, new Set(['qqVersion', 'wrapperSha256']), 'runtime attestation');
  if (pins.qqVersion !== QQ_VERSION) fail('ERR_VERSION_MISMATCH', 'runtime QQ version is not supported');
  if (pins.wrapperSha256 !== WRAPPER_SHA256) fail('ERR_WRAPPER_MISMATCH', 'runtime wrapper hash is not supported');
  return true;
}
function assertPlanning(config) {
  if (!config.enabled) fail('ERR_ADAPTER_DISABLED', 'friend adapter is disabled');
  if (config.mode !== 'dry-run') fail('ERR_OBSERVE_ONLY', 'friend adapter is observe-only');
}
function normalizeRequest(input, config) {
  if (input.action !== ACTION) fail('ERR_UNSUPPORTED_ACTION', 'only the request action is defined');
  if (input.accountUin !== undefined && uin(input.accountUin, 'accountUin') !== config.expectedUin) fail('ERR_ACCOUNT_MISMATCH', 'request account does not match the configured bot account');
  const targetUin = uin(input.targetUin, 'targetUin');
  if (targetUin === config.expectedUin) fail('ERR_SELF_TARGET', 'the bot account cannot be its own target');
  if (!config.allowedTargetUins.includes(targetUin)) fail('ERR_TARGET_NOT_ALLOWED', 'target is outside the adapter target allowlist');
  const targetUid = optionalUid(input.targetUid);
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 200)) fail('ERR_INVALID_REASON', 'reason must be a string of at most 200 characters');
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) fail('ERR_INVALID_IDEMPOTENCY', 'idempotencyKey must be an explicit bounded identifier');
  if (input.dryRun !== true) fail('ERR_CONTRACT_UNVERIFIED', 'AddBuddy request contract is not verified; only dry-run is available');
  return Object.freeze({ action: ACTION, route: ROUTE, accountUin: config.expectedUin, targetUin,
    ...(targetUid ? { targetUid } : {}), ...(input.reason ? { reason: input.reason } : {}),
    idempotencyKey: input.idempotencyKey, dryRun: true });
}
function buildEnvelope(input, config) {
  assertPlanning(config);
  if (config.majorSha256 !== MAJOR_SHA256) fail('ERR_MAJOR_MISMATCH', 'envelope construction requires the pinned client hash');
  const v = record(input, ENVELOPE_KEYS, 'request envelope');
  const plan = normalizeRequest(v, config);
  if (v.targetUid !== undefined) fail('ERR_UNSUPPORTED_TARGET_UID', 'the observed group route carries UIN only');
  if (typeof v.answer !== 'string' || v.answer.length < 1 || v.answer.length > 500) fail('ERR_INVALID_ANSWER', 'answer must be a non-empty string of at most 500 characters');
  if (typeof v.remark !== 'string' || v.remark.length > 500) fail('ERR_INVALID_REMARK', 'remark must be an explicit string of at most 500 characters');
  if (!Number.isInteger(v.defaultCategory) || v.defaultCategory < 0 || v.defaultCategory > 0xffffffff) fail('ERR_INVALID_CATEGORY', 'defaultCategory must be an explicit uint32');
  if (v.sourceId !== OBSERVED_SOURCE_ID || v.sourceSubId !== OBSERVED_SOURCE_SUB_ID) fail('ERR_UNVERIFIED_SOURCE', 'only the observed group-temporary-chat source pair is supported');
  // The QQ client FORWARDS this setting from target lookup; 1 is the observed
  // supported case, not a source-route default or permission to bypass a setting.
  if (v.addFriendSetting !== 1) fail('ERR_UNVERIFIED_SETTING', 'only an explicit observed target setting of 1 is supported');
  for (const key of ['onlyChat', 'qzoneNotWatch', 'qzoneNotWatched']) {
    if (typeof v[key] !== 'boolean') fail('ERR_INVALID_FLAG', 'all three permission flags must be explicit booleans');
  }
  const encode = value => new TextEncoder().encode(value);
  const clientEnvelope = Object.freeze({
    callFrom: OBSERVED_CALL_FROM,
    reqInfo: Object.freeze({
      targetInfo: Object.freeze({ uin: plan.targetUin }), addFriendSetting: v.addFriendSetting, answer: v.answer,
      sourceId: v.sourceId, sourceSubId: v.sourceSubId, isContactFriend: false,
      remark: encode(v.remark), showMyCard: 1, myFriendGroupId: v.defaultCategory,
      name: encode(plan.targetUin), name1: encode(plan.targetUin), myAllowFlag: 1,
      permissionInfo: encode(JSON.stringify({ onlyChat: v.onlyChat, qzoneNotWatch: v.qzoneNotWatch, qzoneNotWatched: v.qzoneNotWatched })),
    }),
    context: new Uint8Array(),
  });
  return Object.freeze({ plan, invocationVerified: false, requestSent: false,
    nativeMappingVerified: true, clientEnvelope,
    nativeCall: Object.freeze({ method: 'addBuddy',
      // QQ 9.9.26 module 22634.XV registers these three field names, in this
      // order. Module 55190 maps those names over the envelope then spreads
      // them into the native method with its service as receiver. See
      // docs/QQ_ADD_BUDDY_STATIC_BUILDER.md; this is not delivery verification.
      args: Object.freeze([clientEnvelope.callFrom, clientEnvelope.reqInfo, clientEnvelope.context]) }),
  });
}
// Public pure entry point applies the same policy as the bound adapter method.
function buildObservedAddBuddyEnvelope(input, rawConfig = {}) {
  return buildEnvelope(input, normalizeAdapterConfig(rawConfig));
}
function readAddBuddyResult(input) {
  const value = record(input, new Set(['result', 'errMsg', 'context', 'req', 'rsp']), 'AddBuddy result');
  if (!Object.hasOwn(value, 'result') || !Number.isInteger(value.result) || value.result < -0x80000000 || value.result > 0x7fffffff) fail('ERR_INVALID_RESULT', 'AddBuddy result.result must be an int32');
  if (!Object.hasOwn(value, 'errMsg') || typeof value.errMsg !== 'string') fail('ERR_INVALID_RESULT', 'AddBuddy result.errMsg must be a string');
  return Object.freeze({ result: value.result, errorMessagePresent: value.errMsg.length > 0,
    businessSuccessKnown: false, relationshipChanged: false });
}
// The QQ UI success branch checks all THREE codes. Never copy targetInfo,
// request/context, error strings or arbitrary response fields into this summary.
function readAddBuddyOutcome(input) {
  const base = readAddBuddyResult(input);
  const rsp = Object.getOwnPropertyDescriptor(input, 'rsp')?.value;
  function code(key) {
    if (!rsp || typeof rsp !== 'object' || isProxy(rsp) || Array.isArray(rsp)) return null;
    const proto = Object.getPrototypeOf(rsp);
    if (proto !== Object.prototype && proto !== null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(rsp, key);
    const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    return Number.isSafeInteger(value) ? value : null;
  }
  const responseResult = code('result'), errorCode = code('errorCode');
  const uiSuccessConditionMet = base.result !== 0
    || (responseResult !== null && responseResult !== 0) || (errorCode !== null && errorCode !== 0) ? false
    : responseResult === null || errorCode === null ? null : true;
  return Object.freeze({ ...base, responseResult, errorCode, uiSuccessConditionMet });
}

function createFriendAdapter(raw = {}) {
  const config = normalizeAdapterConfig(raw);
  const state = { planCount: 0, lastPlan: null };
  return Object.freeze({
    config,
    status() {
      return { protocolVersion: config.protocolVersion, enabled: config.enabled, mode: config.mode,
        route: ROUTE, requestAvailable: false, requestContractVerified: false,
        qqVersion: config.qqVersion, wrapperSha256: config.wrapperSha256,
        planCount: state.planCount, lastPlan: state.lastPlan && { ...state.lastPlan } };
    },
    plan(input) {
      assertPlanning(config);
      const plan = normalizeRequest(record(input, REQUEST_KEYS, 'request plan'), config);
      state.planCount++;
      state.lastPlan = { ...plan };
      return Object.freeze({ ...plan, accepted: false, requestSent: false,
        result: null, resultMeaning: 'not-called', requestContractVerified: false });
    },
    buildEnvelope(input) { return buildEnvelope(input, config); },
    readResult: readAddBuddyResult,
    readOutcome: readAddBuddyOutcome,
  });
}
module.exports = { PROTOCOL_VERSION, QQ_VERSION, WRAPPER_SHA256, MAJOR_SHA256, ROUTE, ACTION,
  FriendAdapterError, normalizeAdapterConfig, assertRuntimeAttestation,
  readAddBuddyResult, readAddBuddyOutcome, buildObservedAddBuddyEnvelope, createFriendAdapter,
  OBSERVED_SOURCE_ID, OBSERVED_SOURCE_SUB_ID, OBSERVED_CALL_FROM };
