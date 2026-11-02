'use strict';

// Observe a QQ-initiated call once. This module cannot initiate or replay a request.
const { isProxy, isPromise } = require('node:util').types;
const { QQ_VERSION, WRAPPER_SHA256, buildFriendRequest, readFriendRequestResult } = require('./request-contract.cjs');
const FIELDS = ['buddyUin', 'buddyUid', 'phoneNumber', 'addFriendSetting', 'answer', 'remark',
  'defaultCatgory', 'verifyInfo', 'securityVerify', 'sourceID', 'sourceSubID', 'qzoneNotWatch', 'qzoneNotWatched', 'onlyChat'];
const VALUES = ['addFriendSetting', 'defaultCatgory', 'sourceID', 'sourceSubID', 'qzoneNotWatch', 'qzoneNotWatched', 'onlyChat'];
const VERIFY_FIELDS = ['type', 'ticket', 'randStr', 'token'];
// Independently verified in the same wrapper's AddBuddyReq converter (RVA 0xBE74EC).
const ADD_FIELDS = ['targetInfo', 'addFriendSetting', 'myAllowFlag', 'answer', 'srcFlag', 'autoSend', 'sig',
  'sourceId', 'sourceSubId', 'name', 'srcDescription', 'friendSrcDesc', 'isContactFriend', 'remark', 'name1',
  'showMyCard', 'token', 'verify', 'deviceInfo', 'bSupportSecureTips', 'bSupportAddRelief', 'extInfo',
  'secSign', 'permissionInfo', 'myFriendGroupId'];
const ADD_VALUES = ['addFriendSetting', 'myAllowFlag', 'srcFlag', 'autoSend', 'sourceId', 'sourceSubId',
  'isContactFriend', 'showMyCard', 'bSupportSecureTips', 'bSupportAddRelief', 'myFriendGroupId'];
const TARGET_FIELDS = ['uid', 'uin', 'phoneNum', 'openid'];
const COUNTERS = ['calls', 'wrongReceiver', 'wrongArity', 'uninspectable', 'targetMismatch', 'conflictingIdentity',
  'alreadyCaptured', 'matched', 'inspectionError'];
const KINDS = ['missing', 'accessor', 'null', 'undefined', 'string', 'number', 'bigint', 'boolean', 'object', 'function', 'symbol'];

function normalizeObservation(config) {
  if (!config || typeof config.targetUin !== 'string' || !/^[1-9][0-9]{4,19}$/.test(config.targetUin)
    || config.qqVersion !== QQ_VERSION || config.wrapperSha256 !== WRAPPER_SHA256
    || (config.targetUid !== undefined && (typeof config.targetUid !== 'string' || !/^u_[A-Za-z0-9_-]{10,128}$/.test(config.targetUid)))
    || (config.observeAddBuddy !== undefined && typeof config.observeAddBuddy !== 'boolean')) {
    throw new TypeError('Request observation requires an explicit target and the verified wrapper');
  }
  return Object.freeze({ targetUin: config.targetUin, qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256,
    ...(config.targetUid ? { targetUid: config.targetUid } : {}), observeAddBuddy: config.observeAddBuddy === true });
}
function descriptors(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype ? Object.getOwnPropertyDescriptors(value) : null;
}
function shape(descriptor) {
  if (!descriptor) return { kind: 'missing' };
  if (!Object.hasOwn(descriptor, 'value')) return { kind: 'accessor' };
  const value = descriptor.value;
  const kind = value === null ? 'null' : typeof value;
  return kind === 'string' ? { kind, empty: value.length === 0 } : { kind };
}
function summarize(input, properties, context) {
  let contractMatched = false;
  try { buildFriendRequest(input, context); contractMatched = true; } catch { /* Never log values or errors. */ }
  const fields = Object.fromEntries(FIELDS.map(key => [key, shape(properties[key])]));
  const values = {};
  for (const key of VALUES) {
    const value = properties[key]?.value;
    if (typeof value === 'boolean' || (Number.isInteger(value) && value >= -0x80000000 && value <= 0xffffffff)) values[key] = value;
  }
  const nested = descriptors(properties.securityVerify?.value);
  const securityVerifyFields = nested ? Object.fromEntries(VERIFY_FIELDS.map(key => [key, shape(nested[key])])) : null;
  return { contractMatched, fields, values, securityVerifyFields,
    unexpectedFieldCount: Reflect.ownKeys(properties).filter(key => !FIELDS.includes(key)).length };
}

function summarizeAdd(args, properties) {
  const fields = Object.fromEntries(ADD_FIELDS.map(key => [key, shape(properties[key])]));
  const target = descriptors(properties.targetInfo?.value);
  const targetFields = Object.fromEntries(TARGET_FIELDS.map(key => [key, shape(target?.[key])]));
  const values = {};
  for (const key of ADD_VALUES) {
    const value = properties[key]?.value;
    if (typeof value === 'boolean' || (Number.isInteger(value) && value >= -0x80000000 && value <= 0xffffffff)) values[key] = value;
  }
  return { contractMatched: null, fields, targetFields, values,
    contextShape: shape({ value: args[0] }), thirdArgumentShape: shape({ value: args[2] }),
    unexpectedFieldCount: Reflect.ownKeys(properties).filter(key => !ADD_FIELDS.includes(key)).length };
}

function matchTarget(properties, uinKey, uidKey, config) {
  const uin = properties?.[uinKey]?.value;
  const uid = properties?.[uidKey]?.value;
  const uinMatches = uin === config.targetUin || (Number.isSafeInteger(uin) && String(uin) === config.targetUin);
  const uidMatches = !!config.targetUid && uid === config.targetUid;
  const emptyUin = uin === undefined || uin === null || uin === '' || uin === '0' || uin === 0;
  const emptyUid = uid === undefined || uid === null || uid === '';
  if ((uidMatches && !emptyUin && !uinMatches) || (uinMatches && config.targetUid && !emptyUid && !uidMatches)) return 'conflictingIdentity';
  return uinMatches || uidMatches ? 'matched' : 'targetMismatch';
}

function initialDiagnostics() {
  return { ...Object.fromEntries(COUNTERS.map(key => [key, 0])),
    uinKinds: Object.fromEntries(KINDS.map(key => [key, 0])), uidKinds: Object.fromEntries(KINDS.map(key => [key, 0])) };
}

function readAddResult(value) {
  // Native result includes context, req and rsp. Never copy or inspect their content.
  const p = descriptors(value);
  const code = p?.result?.value;
  const message = p?.errMsg?.value;
  if (!Number.isInteger(code) || code < -0x80000000 || code > 0x7fffffff || typeof message !== 'string') {
    throw new TypeError('Unexpected AddBuddy result');
  }
  return { result: code, errorMessagePresent: message.length > 0 };
}

function observeRequest(original, { config, isActive, expectedReceiver, onRequest, onFinish,
  route = 'buddy', onDiagnostic = () => {}, diagnosticState }) {
  if (!['buddy', 'add-buddy'].includes(route)) throw new TypeError('Unknown request observation route');
  const context = { qqVersion: config.qqVersion, wrapperSha256: config.wrapperSha256 };
  const diagnostic = diagnosticState ?? initialDiagnostics();
  const bump = key => { diagnostic[key] = Math.min(1000, diagnostic[key] + 1); };
  const publishDiagnostic = () => { try { onDiagnostic(structuredClone(diagnostic)); } catch { /* No effect on QQ. */ } };
  let captured = false;
  return function (...args) {
    const safely = action => { try { if (isActive(this)) action(); } catch { /* Observation never changes a QQ call. */ } };
    let selected = false;
    safely(() => {
      bump('calls');
      try {
        if (expectedReceiver !== undefined && this !== expectedReceiver) { bump('wrongReceiver'); return; }
        if (captured) { bump('alreadyCaptured'); return; }
        if (args.length !== (route === 'buddy' ? 1 : 3)) { bump('wrongArity'); return; }
        const input = args[route === 'buddy' ? 0 : 1];
        const properties = descriptors(input);
        if (!properties) { bump('uninspectable'); return; }
        const target = route === 'buddy' ? properties : descriptors(properties.targetInfo?.value);
        const [uinKey, uidKey] = route === 'buddy' ? ['buddyUin', 'buddyUid'] : ['uin', 'uid'];
        for (const [counter, key] of [['uinKinds', uinKey], ['uidKinds', uidKey]]) {
          const kind = shape(target?.[key]).kind;
          diagnostic[counter][kind] = Math.min(1000, diagnostic[counter][kind] + 1);
        }
        const match = matchTarget(target, uinKey, uidKey, config);
        bump(match);
        if (match !== 'matched') return;
        captured = true;
        selected = onRequest(route === 'buddy' ? summarize(input, properties, context) : summarizeAdd(args, properties)) !== false;
      } catch { bump('inspectionError'); }
      finally { publishDiagnostic(); }
    });
    let result;
    try { result = Reflect.apply(original, this, args); }
    catch (error) {
      if (selected) safely(() => onFinish('request-native-threw', null));
      throw error;
    }
    if (selected) safely(() => {
      if (!isPromise(result)) { onFinish('request-return-not-promise', null); return; }
      // Preserve the exact returned Promise. Observe settlement without reading .then on it.
      // Attaching a rejection handler affects unhandled-rejection bookkeeping, not its outcome.
      Promise.prototype.then.call(result,
        value => safely(() => {
          let parsed;
          try { parsed = route === 'buddy' ? readFriendRequestResult(value, context) : readAddResult(value); }
          catch { onFinish('request-result-shape-mismatch', null); return; }
          onFinish('request-result-observed', { result: parsed.result,
            errorMessagePresent: route === 'buddy' ? parsed.errMsg.length > 0 : parsed.errorMessagePresent });
        }),
        () => safely(() => onFinish('request-promise-rejected', null)));
    });
    return result;
  };
}

module.exports = { normalizeObservation, observeRequest, initialDiagnostics };
