import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { QQ_VERSION, WRAPPER_SHA256, buildFriendRequest, readFriendRequestResult } =
  require('../plugins/qq-friend-probe/request-contract.cjs');
const context = { qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256 };
// Type fixtures only: these enum numbers are not approved service/default values.
const request = () => ({ buddyUin: '4000000000', buddyUid: 'u_test_fixture', phoneNumber: '',
  addFriendSetting: 1, sourceID: 7, sourceSubID: 8, qzoneNotWatch: false, qzoneNotWatched: false, onlyChat: false });

test('preserves a large QQ identifier as decimal text and does not mutate input', () => {
  const input = Object.freeze(request());
  const out = buildFriendRequest(input, context);
  assert.deepEqual(out, input);
  assert.notEqual(out, input);
  assert.equal(out.buddyUin, '4000000000');
});

test('rejects numeric, lossy, nondecimal, zero and out-of-range QQ identifiers', () => {
  for (const buddyUin of [4000000000, 4000000000n, '0', '01', '-1', '+1', '1.1', '1e8', '1x', '', ' 12345', '18446744073709551616']) {
    assert.throws(() => buildFriendRequest({ ...request(), buddyUin }, context), /buddyUin/);
  }
  assert.equal(buildFriendRequest({ ...request(), buddyUin: '18446744073709551615' }, context).buddyUin, '18446744073709551615');
});

test('never supplies settings, source numbers or privacy flags as guessed defaults', () => {
  for (const key of Object.keys(request())) {
    const input = request(); delete input[key];
    assert.throws(() => buildFriendRequest(input, context), /missing a required field/);
  }
});

test('enforces exact signed/unsigned integer widths without coercion', () => {
  for (const value of [NaN, Infinity, 1.2, '1', true, 0x100000000]) {
    for (const key of ['addFriendSetting', 'sourceID', 'sourceSubID', 'defaultCatgory']) {
      assert.throws(() => buildFriendRequest({ ...request(), [key]: value }, context), /integer range/);
    }
  }
  assert.equal(buildFriendRequest({ ...request(), addFriendSetting: -0x80000000, sourceID: 0xffffffff }, context).sourceID, 0xffffffff);
  assert.throws(() => buildFriendRequest({ ...request(), addFriendSetting: 0x80000000 }, context));
  assert.throws(() => buildFriendRequest({ ...request(), sourceID: -1 }, context));
});

test('requires real booleans and strings, preventing native silent conversion', () => {
  for (const key of ['qzoneNotWatch', 'qzoneNotWatched', 'onlyChat']) {
    for (const value of [0, 1, 'false', null, undefined]) assert.throws(() => buildFriendRequest({ ...request(), [key]: value }, context));
  }
  for (const key of ['buddyUid', 'phoneNumber', 'answer', 'remark', 'verifyInfo']) {
    assert.throws(() => buildFriendRequest({ ...request(), [key]: 42 }, context));
  }
  assert.throws(() => buildFriendRequest({ ...request(), buddyUid: '' }, context));
});

test('keeps omission, null and undefined for optional native values distinct', () => {
  const empty = buildFriendRequest(request(), context);
  for (const key of ['answer', 'remark', 'defaultCatgory', 'verifyInfo', 'securityVerify']) {
    assert.equal(Object.hasOwn(empty, key), false);
    for (const value of [null, undefined]) {
      const out = buildFriendRequest({ ...request(), [key]: value }, context);
      assert.equal(Object.hasOwn(out, key), true);
      assert.equal(out[key], value);
    }
  }
});

test('copies nested verification fields without logging or coercing their content', () => {
  const securityVerify = Object.freeze({ type: 3, ticket: 'PRIVATE_TICKET', randStr: 'PRIVATE_RANDOM', token: 'PRIVATE_TOKEN' });
  const out = buildFriendRequest({ ...request(), securityVerify }, context);
  assert.deepEqual(out.securityVerify, securityVerify);
  assert.notEqual(out.securityVerify, securityVerify);
  for (const key of Object.keys(securityVerify)) {
    const partial = { ...securityVerify }; delete partial[key];
    assert.throws(() => buildFriendRequest({ ...request(), securityVerify: partial }, context), (error) => !error.message.includes('PRIVATE_'));
  }
});

test('rejects accessors and proxies before evaluating them', () => {
  let touches = 0;
  const value = request();
  Object.defineProperty(value, 'buddyUid', { get() { touches++; throw Error('PRIVATE_GETTER'); } });
  assert.throws(() => buildFriendRequest(value, context), /accessors/);
  const proxy = new Proxy(request(), { getPrototypeOf() { touches++; throw Error('PRIVATE_PROXY'); } });
  assert.throws(() => buildFriendRequest(proxy, context), /plain record/);
  assert.equal(touches, 0);
});

test('rejects extra fields, symbols and inherited values without echoing them', () => {
  for (const input of [{ ...request(), PRIVATE_FIELD: 'PRIVATE_VALUE' }, { ...request(), [Symbol('PRIVATE_SYMBOL')]: 'x' }, Object.create(request()), []]) {
    assert.throws(() => buildFriendRequest(input, context), (error) => !error.message.includes('PRIVATE_'));
  }
  const v = Object.assign(Object.create(null), request());
  assert.deepEqual(buildFriendRequest(v, context), request());
  assert.throws(() => buildFriendRequest({ ...request(), defaultCategory: 1 }, context), /unexpected field/);
});

test('checks the version/hash before inspecting the request', () => {
  let touched = false;
  const input = new Proxy({}, { ownKeys() { touched = true; throw Error('No inspection'); } });
  for (const ctx of [undefined, { ...context, qqVersion: 'different' }, { ...context, wrapperSha256: '0'.repeat(64) }]) {
    assert.throws(() => buildFriendRequest(input, ctx), /wrapper/);
  }
  assert.equal(touched, false);
});

test('native fulfilled results retain the business code and never claim a friendship', () => {
  for (const result of [0, 1, -1]) {
    const out = readFriendRequestResult({ result, errMsg: 'Native message' }, context);
    assert.deepEqual(out, { result, errMsg: 'Native message' });
    assert.equal(Object.hasOwn(out, 'success'), false);
    assert.equal(Object.hasOwn(out, 'isFriend'), false);
  }
  for (const input of [{ result: '0', errMsg: '' }, { result: 0 }, { result: 0, errMsg: 7 }, { result: 0, errMsg: '', success: true }]) {
    assert.throws(() => readFriendRequestResult(input, context));
  }
});
