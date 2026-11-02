'use strict';

// Pure, offline preparation. This module never loads QQ or calls a native method.
// Field layout is verified only for the exact wrapper below; enum meanings are not.
const { isProxy } = require('node:util').types;
const QQ_VERSION = '9.9.26-44343';
const WRAPPER_SHA256 = '29de02c5bec028643fc5d597e269f15be8bc75f7ea1620e53b50c6ff900288f2';
const REQUIRED = ['buddyUin', 'buddyUid', 'phoneNumber', 'addFriendSetting',
  'sourceID', 'sourceSubID', 'qzoneNotWatch', 'qzoneNotWatched', 'onlyChat'];
const OPTIONAL = ['answer', 'remark', 'defaultCatgory', 'verifyInfo', 'securityVerify'];
const VERIFY = ['type', 'ticket', 'randStr', 'token'];

function fail(field, message) {
  // field and message are fixed internal labels; never echo supplied values or unknown keys.
  throw new TypeError(`Friend request contract: ${field} ${message}`);
}
function record(value, label, allowed, required) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) fail(label, 'must be a plain record');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(label, 'must be a plain record');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) fail(label, 'has an unexpected field');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => !Object.hasOwn(descriptors[key], 'value'))) fail(label, 'cannot contain accessors');
  for (const key of required) if (!Object.hasOwn(descriptors, key)) fail(label, 'is missing a required field');
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function string(value, field, nonempty = false) {
  if (typeof value !== 'string' || (nonempty && value.length === 0)) fail(field, 'must be a string' + (nonempty ? ' with content' : ''));
  return value;
}
function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(field, 'is outside its integer range');
  return value;
}
const uint32 = (value, field) => integer(value, field, 0, 0xffffffff);
const int32 = (value, field) => integer(value, field, -0x80000000, 0x7fffffff);
function boolean(value, field) {
  if (typeof value !== 'boolean') fail(field, 'must be a boolean');
  return value;
}
function verifyContext(context) {
  const c = record(context, 'wrapper', ['qqVersion', 'wrapperSha256'], ['qqVersion', 'wrapperSha256']);
  if (c.qqVersion !== QQ_VERSION || c.wrapperSha256 !== WRAPPER_SHA256) fail('wrapper', 'does not match the verified version and hash');
}

function buildFriendRequest(input, context) {
  verifyContext(context);
  const v = record(input, 'request', [...REQUIRED, ...OPTIONAL], REQUIRED);
  // The native number path goes through int32 before stoull. Require decimal text.
  if (typeof v.buddyUin !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v.buddyUin)
    || BigInt(v.buddyUin) > 0xffffffffffffffffn) fail('buddyUin', 'must be a positive uint64 decimal string');
  const out = {
    buddyUin: v.buddyUin,
    buddyUid: string(v.buddyUid, 'buddyUid', true),
    phoneNumber: string(v.phoneNumber, 'phoneNumber'),
    addFriendSetting: int32(v.addFriendSetting, 'addFriendSetting'),
    sourceID: uint32(v.sourceID, 'sourceID'),
    sourceSubID: uint32(v.sourceSubID, 'sourceSubID'),
    qzoneNotWatch: boolean(v.qzoneNotWatch, 'qzoneNotWatch'),
    qzoneNotWatched: boolean(v.qzoneNotWatched, 'qzoneNotWatched'),
    onlyChat: boolean(v.onlyChat, 'onlyChat'),
  };
  // Preserve omitted/null/undefined optional values. Do not invent native defaults.
  for (const key of OPTIONAL) {
    if (!Object.hasOwn(v, key)) continue;
    const value = v[key];
    if (value == null) { out[key] = value; continue; }
    if (key === 'defaultCatgory') out[key] = uint32(value, key); // Native spelling is intentional.
    else if (key === 'securityVerify') {
      const s = record(value, 'securityVerify', VERIFY, VERIFY);
      out[key] = { type: uint32(s.type, 'securityVerify.type'), ticket: string(s.ticket, 'securityVerify.ticket'),
        randStr: string(s.randStr, 'securityVerify.randStr'), token: string(s.token, 'securityVerify.token') };
    } else out[key] = string(value, key);
  }
  return out;
}

function readFriendRequestResult(input, context) {
  verifyContext(context);
  const v = record(input, 'result', ['result', 'errMsg'], ['result', 'errMsg']);
  // Resolving the native Promise does not mean success or that a friendship exists.
  return { result: int32(v.result, 'result.result'), errMsg: string(v.errMsg, 'result.errMsg') };
}

module.exports = { QQ_VERSION, WRAPPER_SHA256, buildFriendRequest, readFriendRequestResult };
