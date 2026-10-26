import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION,
  QQ_VERSION,
  ROUTE,
  WRAPPER_SHA256,
  MAJOR_SHA256,
  buildObservedAddBuddyEnvelope,
  FriendAdapterError,
  assertRuntimeAttestation,
  createFriendAdapter,
  normalizeAdapterConfig,
  readAddBuddyResult,
  readAddBuddyOutcome,
  OBSERVED_CALL_FROM,
  OBSERVED_SOURCE_ID,
  OBSERVED_SOURCE_SUB_ID,
} from '../plugins/qq-friend-probe/friend-adapter.cjs';

const expectedUin = '1927418344';
const targetUin = '280656999';
const pins = { qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256 };

function enabledConfig(extra = {}) {
  return { enabled: true, mode: 'dry-run', expectedUin, allowedTargetUins: [targetUin], ...pins, majorSha256: MAJOR_SHA256, ...extra };
}

function errorCode(fn) {
  try { fn(); } catch (error) {
    assert.ok(error instanceof FriendAdapterError);
    return error.code;
  }
  assert.fail('expected FriendAdapterError');
}

function validPlan(extra = {}) {
  return {
    action: ACTION,
    accountUin: expectedUin,
    targetUin,
    idempotencyKey: 'probe-20261025-01',
    dryRun: true,
    ...extra,
  };
}

test('default configuration is disabled and exposes no native sender', () => {
  const adapter = createFriendAdapter();
  assert.deepEqual(adapter.status(), {
    protocolVersion: 1,
    enabled: false,
    mode: 'disabled',
    route: ROUTE,
    requestAvailable: false,
    requestContractVerified: false,
    qqVersion: QQ_VERSION,
    wrapperSha256: WRAPPER_SHA256,
    planCount: 0,
    lastPlan: null,
  });
  assert.equal('invoke' in adapter, false);
  assert.equal('call' in adapter, false);
  assert.equal('send' in adapter, false);
  assert.equal(errorCode(() => adapter.plan(validPlan())), 'ERR_ADAPTER_DISABLED');
});

test('enabled mode requires exact QQ and wrapper pins', () => {
  assert.equal(normalizeAdapterConfig(enabledConfig()).enabled, true);
  assert.equal(errorCode(() => normalizeAdapterConfig(enabledConfig({ qqVersion: '9.9.36-53644' }))), 'ERR_VERSION_MISMATCH');
  assert.equal(errorCode(() => normalizeAdapterConfig(enabledConfig({ wrapperSha256: 'a'.repeat(64) }))), 'ERR_WRAPPER_MISMATCH');
  assert.equal(errorCode(() => normalizeAdapterConfig(enabledConfig({ mode: 'send' }))), 'ERR_INVALID_MODE');
});

test('enabled mode requires a verified bot identity and rejects self targets', () => {
  assert.equal(errorCode(() => normalizeAdapterConfig({ enabled: true, mode: 'dry-run', ...pins })), 'ERR_INVALID_UIN');
  assert.equal(errorCode(() => normalizeAdapterConfig(enabledConfig({ allowedTargetUins: [] }))), 'ERR_INVALID_TARGETS');
  assert.equal(errorCode(() => normalizeAdapterConfig(enabledConfig({ allowedTargetUins: new Proxy([targetUin], {}) }))), 'ERR_INVALID_TARGETS');
  assert.equal(errorCode(() => normalizeAdapterConfig(enabledConfig({ allowedTargetUins: [expectedUin] }))), 'ERR_INVALID_TARGETS');
  const adapter = createFriendAdapter(enabledConfig());
  assert.equal(errorCode(() => adapter.plan(validPlan({ targetUin: expectedUin }))), 'ERR_SELF_TARGET');
});

test('runtime attestation accepts only the pinned pair', () => {
  assert.equal(assertRuntimeAttestation(pins), true);
  assert.equal(errorCode(() => assertRuntimeAttestation({ ...pins, qqVersion: '9.9.36-53644' })), 'ERR_VERSION_MISMATCH');
  assert.equal(errorCode(() => assertRuntimeAttestation({ ...pins, wrapperSha256: 'b'.repeat(64) })), 'ERR_WRAPPER_MISMATCH');
  assert.equal(errorCode(() => assertRuntimeAttestation({ ...pins, extra: true })), 'ERR_UNKNOWN_FIELD');
});

test('observe mode cannot create a request plan', () => {
  const adapter = createFriendAdapter({ enabled: true, mode: 'observe', expectedUin, allowedTargetUins: [targetUin], ...pins });
  assert.equal(errorCode(() => adapter.plan(validPlan())), 'ERR_OBSERVE_ONLY');
});

test('dry-run validates a bounded request without calling any native object', () => {
  const adapter = createFriendAdapter(enabledConfig({ allowedTargetUins: [targetUin] }));
  const plan = adapter.plan(validPlan({ reason: '离线契约测试' }));
  assert.deepEqual(plan, {
    action: ACTION,
    route: ROUTE,
    accountUin: expectedUin,
    targetUin,
    reason: '离线契约测试',
    idempotencyKey: 'probe-20261025-01',
    dryRun: true,
    accepted: false,
    requestSent: false,
    result: null,
    resultMeaning: 'not-called',
    requestContractVerified: false,
  });
  assert.equal(adapter.status().planCount, 1);
});

test('real send is rejected even when pins and identity match', () => {
  const adapter = createFriendAdapter(enabledConfig());
  assert.equal(errorCode(() => adapter.plan(validPlan({ dryRun: false }))), 'ERR_CONTRACT_UNVERIFIED');
  assert.equal(adapter.status().planCount, 0);
});

test('only the request action and exact request fields are accepted', () => {
  const adapter = createFriendAdapter(enabledConfig());
  assert.equal(errorCode(() => adapter.plan(validPlan({ action: 'delete-friend' }))), 'ERR_UNSUPPORTED_ACTION');
  assert.equal(errorCode(() => adapter.plan(validPlan({ method: 'reqToAddFriends' }))), 'ERR_UNKNOWN_FIELD');
  assert.equal(errorCode(() => adapter.plan(validPlan({ targetUin: 280656999 }))), 'ERR_INVALID_UIN');
  assert.equal(errorCode(() => adapter.plan(validPlan({ targetUin: '0280656999' }))), 'ERR_INVALID_UIN');
  assert.equal(errorCode(() => adapter.plan(validPlan({ idempotencyKey: 'x' }))), 'ERR_INVALID_IDEMPOTENCY');
});

test('proxy and accessor inputs fail closed', () => {
  const adapter = createFriendAdapter(enabledConfig());
  const proxy = new Proxy(validPlan(), {});
  assert.equal(errorCode(() => adapter.plan(proxy)), 'ERR_INVALID_RECORD');
  const accessor = { ...validPlan() };
  Object.defineProperty(accessor, 'reason', { get() { throw new Error('must not run'); }, enumerable: true });
  assert.equal(errorCode(() => adapter.plan(accessor)), 'ERR_ACCESSOR_FIELD');
});

test('account, target allowlist, UID and reason are bounded', () => {
  const adapter = createFriendAdapter(enabledConfig({ allowedTargetUins: [targetUin] }));
  assert.equal(errorCode(() => adapter.plan(validPlan({ accountUin: '123456789' }))), 'ERR_ACCOUNT_MISMATCH');
  assert.equal(errorCode(() => adapter.plan(validPlan({ targetUin: '123456789' }))), 'ERR_TARGET_NOT_ALLOWED');
  assert.equal(errorCode(() => adapter.plan(validPlan({ targetUid: 'bad' }))), 'ERR_INVALID_UID');
  assert.equal(errorCode(() => adapter.plan(validPlan({ reason: 'x'.repeat(201) }))), 'ERR_INVALID_REASON');
  assert.equal(adapter.plan(validPlan({ targetUid: 'u_0123456789', reason: '' })).requestSent, false);
});

test('result reader preserves uncertainty even for result zero', () => {
  assert.deepEqual(readAddBuddyResult({ result: 0, errMsg: '', context: { secret: 'opaque' }, req: { raw: true }, rsp: null }), {
    result: 0,
    errorMessagePresent: false,
    businessSuccessKnown: false,
    relationshipChanged: false,
  });
  assert.deepEqual(readAddBuddyResult({ result: 0, errMsg: '' }), {
    result: 0,
    errorMessagePresent: false,
    businessSuccessKnown: false,
    relationshipChanged: false,
  });
  assert.deepEqual(readAddBuddyResult({ result: 1, errMsg: 'rejected' }), {
    result: 1,
    errorMessagePresent: true,
    businessSuccessKnown: false,
    relationshipChanged: false,
  });
});

test('result reader rejects accessors, symbols and invalid result types', () => {
  const accessor = { result: 0, errMsg: '' };
  Object.defineProperty(accessor, 'errMsg', { get() { throw new Error('must not run'); }, enumerable: true });
  assert.equal(errorCode(() => readAddBuddyResult(accessor)), 'ERR_ACCESSOR_FIELD');
  const symbolValue = { result: 0, errMsg: '' };
  symbolValue[Symbol('opaque')] = 1;
  assert.equal(errorCode(() => readAddBuddyResult(symbolValue)), 'ERR_UNKNOWN_FIELD');
  assert.equal(errorCode(() => readAddBuddyResult({ result: 1.5, errMsg: '' })), 'ERR_INVALID_RESULT');
  assert.equal(errorCode(() => readAddBuddyResult({ result: 0, errMsg: 1 })), 'ERR_INVALID_RESULT');
});

test('observed group route builds a static AddBuddy envelope without sending', () => {
  const adapter = createFriendAdapter(enabledConfig());
  const built = adapter.buildEnvelope({
    action: ACTION,
    accountUin: expectedUin,
    targetUin,
    addFriendSetting: 1,
    answer: '通过群临时对话申请',
    remark: '测试备注',
    defaultCategory: 0,
    onlyChat: false,
    qzoneNotWatch: false,
    qzoneNotWatched: false,
    sourceId: OBSERVED_SOURCE_ID,
    sourceSubId: OBSERVED_SOURCE_SUB_ID,
    idempotencyKey: 'probe-envelope-01',
    dryRun: true,
  });
  const envelope = built.clientEnvelope;
  const req = envelope.reqInfo;
  assert.deepEqual(built.nativeCall.args, [envelope.callFrom, req, envelope.context]);
  assert.equal(built.nativeCall.args.length, 3);
  assert.equal(envelope.callFrom, OBSERVED_CALL_FROM);
  assert.deepEqual(req.targetInfo, { uin: targetUin });
  assert.equal(req.addFriendSetting, 1);
  assert.equal(req.answer, '通过群临时对话申请');
  assert.equal(req.sourceId, 5);
  assert.equal(req.sourceSubId, 2);
  assert.equal(req.isContactFriend, false);
  assert.equal(req.showMyCard, 1);
  assert.equal(req.myAllowFlag, 1);
  assert.equal(req.myFriendGroupId, 0);
  assert.deepEqual([...req.name], [...new TextEncoder().encode(targetUin)]);
  assert.deepEqual([...req.name1], [...new TextEncoder().encode(targetUin)]);
  assert.deepEqual([...req.remark], [...new TextEncoder().encode('测试备注')]);
  assert.deepEqual([...req.permissionInfo], [...new TextEncoder().encode(JSON.stringify({
    onlyChat: false, qzoneNotWatch: false, qzoneNotWatched: false,
  }))]);
  assert.deepEqual([...envelope.context], []);
  assert.equal(built.invocationVerified, false);
  assert.equal(built.requestSent, false);
  assert.equal('invoke' in adapter, false);
  assert.equal('call' in adapter, false);
});

test('envelope builder rejects unverified sources, target UIDs and implicit category defaults', () => {
  const adapter = createFriendAdapter(enabledConfig());
  const input = {
    action: ACTION, accountUin: expectedUin, targetUin, answer: 'x', defaultCategory: 0,
    remark: '', addFriendSetting: 1, onlyChat: false, qzoneNotWatch: false, qzoneNotWatched: false,
    sourceId: OBSERVED_SOURCE_ID, sourceSubId: OBSERVED_SOURCE_SUB_ID,
    idempotencyKey: 'probe-envelope-02', dryRun: true,
  };
  assert.equal(errorCode(() => adapter.buildEnvelope({ ...input, sourceId: 4 })), 'ERR_UNVERIFIED_SOURCE');
  assert.equal(errorCode(() => adapter.buildEnvelope({ ...input, targetUid: 'u_0123456789' })), 'ERR_UNSUPPORTED_TARGET_UID');
  assert.equal(errorCode(() => adapter.buildEnvelope({ ...input, defaultCategory: undefined })), 'ERR_INVALID_CATEGORY');
  assert.equal(errorCode(() => adapter.buildEnvelope({ ...input, answer: '' })), 'ERR_INVALID_ANSWER');
});

function validEnvelope(extra = {}) {
  return { ...validPlan(), answer: 'verification text', remark: '', defaultCategory: 0,
    addFriendSetting: 1, sourceId: 5, sourceSubId: 2,
    onlyChat: false, qzoneNotWatch: false, qzoneNotWatched: false, ...extra };
}

test('public envelope helper enforces disabled, observe, pins and target policy', () => {
  const input = validEnvelope();
  assert.equal(errorCode(() => buildObservedAddBuddyEnvelope(input)), 'ERR_ADAPTER_DISABLED');
  assert.equal(errorCode(() => buildObservedAddBuddyEnvelope(input, enabledConfig({ enabled: false }))), 'ERR_ADAPTER_DISABLED');
  assert.equal(errorCode(() => buildObservedAddBuddyEnvelope(input, enabledConfig({ mode: 'observe' }))), 'ERR_OBSERVE_ONLY');
  assert.equal(errorCode(() => buildObservedAddBuddyEnvelope(input, enabledConfig({ majorSha256: undefined }))), 'ERR_MAJOR_MISMATCH');
  assert.equal(errorCode(() => buildObservedAddBuddyEnvelope(input, enabledConfig({ wrapperSha256: '0'.repeat(64) }))), 'ERR_WRAPPER_MISMATCH');
  assert.equal(errorCode(() => buildObservedAddBuddyEnvelope(input, enabledConfig({ allowedTargetUins: [] }))), 'ERR_INVALID_TARGETS');
  assert.equal(errorCode(() => buildObservedAddBuddyEnvelope(input, enabledConfig({ allowedTargetUins: ['123456789'] }))), 'ERR_TARGET_NOT_ALLOWED');
  assert.equal(errorCode(() => buildObservedAddBuddyEnvelope({ ...input, dryRun: false }, enabledConfig())), 'ERR_CONTRACT_UNVERIFIED');
});

test('all target settings and permission choices must be supplied explicitly', () => {
  const adapter = createFriendAdapter(enabledConfig());
  for (const setting of [undefined, 0, 2, '1', null]) {
    assert.equal(errorCode(() => adapter.buildEnvelope(validEnvelope({ addFriendSetting: setting }))), 'ERR_UNVERIFIED_SETTING');
  }
  for (const key of ['onlyChat', 'qzoneNotWatch', 'qzoneNotWatched']) {
    for (const bad of [undefined, null, 0, 1, 'false']) {
      assert.equal(errorCode(() => adapter.buildEnvelope(validEnvelope({ [key]: bad }))), 'ERR_INVALID_FLAG');
    }
  }
  assert.equal(errorCode(() => adapter.buildEnvelope(validEnvelope({ remark: undefined }))), 'ERR_INVALID_REMARK');
  assert.equal(errorCode(() => adapter.buildEnvelope(validEnvelope({ defaultCategory: 0x100000000 }))), 'ERR_INVALID_CATEGORY');
  assert.equal(errorCode(() => adapter.plan(validEnvelope())), 'ERR_UNKNOWN_FIELD');
});

test('inherited optional getters are never evaluated and cannot supply required values', () => {
  const adapter = createFriendAdapter(enabledConfig());
  let reads = 0;
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'answer');
  Object.defineProperty(Object.prototype, 'answer', { configurable: true, get() { reads++; return 'inherited'; } });
  try {
    const input = validEnvelope();
    delete input.answer;
    assert.equal(errorCode(() => adapter.buildEnvelope(input)), 'ERR_INVALID_ANSWER');
    assert.equal(reads, 0);
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'answer', original);
    else delete Object.prototype.answer;
  }
});

test('allowlist rejects holes, accessors and custom methods without invoking them', () => {
  let reads = 0;
  const accessor = [];
  Object.defineProperty(accessor, '0', { get() { reads++; return targetUin; }, enumerable: true });
  const custom = [targetUin];
  custom.map = () => { reads++; return [targetUin]; };
  for (const value of [new Array(1), accessor, custom]) {
    assert.equal(errorCode(() => normalizeAdapterConfig(enabledConfig({ allowedTargetUins: value }))), 'ERR_INVALID_TARGETS');
  }
  assert.equal(reads, 0);
});

test('QQ identifiers preserve uint64 and reject overflow before construction', () => {
  const max = '18446744073709551615';
  const adapter = createFriendAdapter(enabledConfig({ allowedTargetUins: [max] }));
  assert.equal(adapter.buildEnvelope(validEnvelope({ targetUin: max })).clientEnvelope.reqInfo.targetInfo.uin, max);
  assert.equal(errorCode(() => normalizeAdapterConfig(enabledConfig({ allowedTargetUins: ['18446744073709551616'] }))), 'ERR_INVALID_UIN');
  assert.equal(errorCode(() => adapter.buildEnvelope(validEnvelope({ targetUin: '99999999999999999999' }))), 'ERR_INVALID_UIN');
});

test('mixed permission choices retain exact JSON keys/order and returned bytes are isolated', () => {
  const adapter = createFriendAdapter(enabledConfig());
  const input = validEnvelope({ onlyChat: true, qzoneNotWatch: false, qzoneNotWatched: true, remark: '备注😀' });
  const first = adapter.buildEnvelope(input);
  assert.equal(first.nativeMappingVerified, true);
  assert.equal(new TextDecoder().decode(first.clientEnvelope.reqInfo.permissionInfo), '{"onlyChat":true,"qzoneNotWatch":false,"qzoneNotWatched":true}');
  assert.equal(Buffer.from(first.clientEnvelope.reqInfo.remark).toString('hex'), 'e5a487e6b3a8f09f9880');
  first.clientEnvelope.reqInfo.remark.fill(0);
  assert.equal(new TextDecoder().decode(adapter.buildEnvelope(input).clientEnvelope.reqInfo.remark), '备注😀');
  assert.equal(adapter.status().lastPlan, null);
  assert.equal(input.remark, '备注😀');
});

test('UI success requires all three zero codes without asserting friendship', () => {
  for (const [result, responseResult, errorCode, expected] of [
    [0, 0, 0, true], [1, 0, 0, false], [0, 1, 0, false], [0, 0, 162, false],
    [0, undefined, 0, null], [0, 0, undefined, null], [0, '0', 0, null],
    [0, undefined, 162, false], [0, 1, undefined, false],
  ]) {
    const summary = readAddBuddyOutcome({ result, errMsg: '', rsp: { result: responseResult, errorCode, targetInfo: { opaque: 'private' } } });
    assert.equal(summary.uiSuccessConditionMet, expected);
    assert.equal(summary.businessSuccessKnown, false);
    assert.equal(summary.relationshipChanged, false);
    assert.ok(!JSON.stringify(summary).includes('private'));
  }
  assert.equal(readAddBuddyOutcome({ result: 0, errMsg: '' }).uiSuccessConditionMet, null);
});

test('outcome summary reads only owned numeric codes and never evaluates response accessors', () => {
  let reads = 0;
  const rsp = { errorCode: 0 };
  Object.defineProperty(rsp, 'result', { get() { reads++; return 0; } });
  Object.defineProperty(rsp, 'errorString', { get() { reads++; throw new Error('private'); } });
  const summary = readAddBuddyOutcome({ result: 0, errMsg: '', rsp });
  assert.equal(summary.uiSuccessConditionMet, null);
  assert.equal(reads, 0);
  const proxy = new Proxy({}, { getPrototypeOf() { reads++; throw new Error('private'); } });
  assert.equal(readAddBuddyOutcome({ result: 0, errMsg: '', rsp: proxy }).uiSuccessConditionMet, null);
  assert.equal(reads, 0);
});

test('configuration and status snapshots are immutable', () => {
  const adapter = createFriendAdapter(enabledConfig({ allowedTargetUins: [targetUin] }));
  assert.equal(Object.isFrozen(adapter.config), true);
  assert.equal(Object.isFrozen(adapter.config.allowedTargetUins), true);
  const status = adapter.status();
  status.lastPlan = { requestSent: true };
  assert.equal(adapter.status().lastPlan, null);
});
