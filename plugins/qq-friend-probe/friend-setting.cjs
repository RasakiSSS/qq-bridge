'use strict';

// Read-only, fixed getBuddySetting call. Never sends an application and never
// interprets the absence of an outgoing-request field as pending:false.
const { isProxy, isPromise } = require('node:util').types;
const { normalizeAdapterConfig, QQ_VERSION, WRAPPER_SHA256, MAJOR_SHA256 } = require('./friend-adapter.cjs');
const own = (object, key) => {
  if (!object || typeof object !== 'object' || isProxy(object)) return undefined;
  const d = Object.getOwnPropertyDescriptor(object, key);
  return d && Object.hasOwn(d, 'value') ? d.value : undefined;
};
function dataMethod(object, key) {
  for (let depth = 0; object && depth < 12; depth++, object = Object.getPrototypeOf(object)) {
    if (isProxy(object)) return null;
    const d = Object.getOwnPropertyDescriptor(object, key);
    if (d) return Object.hasOwn(d, 'value') && typeof d.value === 'function' && !isProxy(d.value) ? d.value : null;
  }
  return null;
}
const unknown = code => Object.freeze({ status: 'unknown', code, requestSent: false });

function createBuddySettingReader(rawConfig, getBinding, { timeoutMs = 10000 } = {}) {
  const config = normalizeAdapterConfig(rawConfig);
  if (config.majorSha256 !== MAJOR_SHA256 || typeof getBinding !== 'function' || isProxy(getBinding)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('ERR_INVALID_SETTING_READER');
  let busy = false;
  let stopped = false;
  let cancel = null;
  function bindingNow() {
    const value = getBinding();
    if (isPromise(value)) {
      void Reflect.apply(Promise.prototype.then, value, [undefined, () => {}]);
      return null;
    }
    return value;
  }
  function read(input) {
    if (!config.enabled || config.mode !== 'dry-run' || stopped) return Promise.resolve(unknown('ERR_READER_DISABLED'));
    if (busy) return Promise.resolve(unknown('ERR_BUSY'));
    let targetUin, sourceId, sourceSubId;
    try {
      if (!input || typeof input !== 'object' || isProxy(input) || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
        || Reflect.ownKeys(input).length !== 3
        || Reflect.ownKeys(input).some(k => !['targetUin', 'sourceId', 'sourceSubId'].includes(k))) return Promise.resolve(unknown('ERR_INVALID_QUERY'));
      targetUin = own(input, 'targetUin'); sourceId = own(input, 'sourceId'); sourceSubId = own(input, 'sourceSubId');
      if (!config.allowedTargetUins.includes(targetUin) || sourceId !== 5 || sourceSubId !== 2) return Promise.resolve(unknown('ERR_INVALID_QUERY'));
    } catch { return Promise.resolve(unknown('ERR_INVALID_QUERY')); }
    busy = true;
    let settled = false, timedOut = false, resolveCaller;
    const caller = new Promise(resolve => { resolveCaller = resolve; });
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolveCaller(value); } };
    cancel = () => { timedOut = true; finish(unknown('ERR_READER_STOPPED')); };
    const timer = setTimeout(() => { timedOut = true; finish(unknown('ERR_TIMEOUT')); }, timeoutMs);
    async function run() {
      try {
        const b = bindingNow();
        const current = own(b, 'isCurrent');
        const receiver = own(b, 'receiver');
        if (own(b, 'accountUin') !== config.expectedUin || own(b, 'qqVersion') !== QQ_VERSION
          || own(b, 'wrapperSha256') !== WRAPPER_SHA256 || own(b, 'majorSha256') !== MAJOR_SHA256
          || typeof current !== 'function' || isProxy(current) || current() !== true) {
          finish(unknown('ERR_BINDING_UNAVAILABLE')); return;
        }
        const method = dataMethod(receiver, 'getBuddySetting');
        if (!method || stopped || timedOut || current() !== true || stopped || timedOut) { finish(unknown('ERR_BINDING_UNAVAILABLE')); return; }
        // ApplicationService bytecode 224–407 and module 22634.XV prove this
        // UIN/source request, constant callFrom, empty bytes, and argument order.
        const returned = Reflect.apply(method, receiver, ['GuildGetContactSettingsApplication',
          { targetInfo: { uin: targetUin }, sourceId, sourceSubId }, new Uint8Array()]);
        if (!isPromise(returned)) { finish(unknown('ERR_SETTING_REPLY')); return; }
        const response = await new Promise((resolve, reject) => Reflect.apply(Promise.prototype.then, returned, [resolve, reject]));
        if (stopped || timedOut) return;
        if (bindingNow() !== b || own(b, 'isCurrent') !== current || current() !== true || dataMethod(receiver, 'getBuddySetting') !== method) {
          finish(unknown('ERR_BINDING_LOST')); return;
        }
        const rsp = own(response, 'rsp');
        const setting = own(rsp, 'querySetting'), isContactFriend = own(rsp, 'isContactFriend'), error = own(rsp, 'errorCode');
        if (own(response, 'result') !== 0 || (error !== undefined && error !== 0)
          || !Number.isInteger(setting) || setting < 0 || setting > 0x7fffffff || typeof isContactFriend !== 'boolean') {
          finish(unknown('ERR_SETTING_REPLY')); return;
        }
        finish(Object.freeze({ status: 'read', requestSent: false, accountUin: config.expectedUin, targetUin,
          // Preserve the native contact flag literally. Its name does not prove
          // QQ friend-list membership; verify that through the actual friend list.
          addFriendSetting: setting, isContactFriend, friend: null, pending: null }));
      } catch { if (!stopped && !timedOut) finish(unknown('ERR_SETTING_QUERY')); }
      finally { busy = false; cancel = null; }
    }
    void run();
    return caller;
  }
  return Object.freeze({ read, stop() { stopped = true; cancel?.(); } });
}
module.exports = { createBuddySettingReader };
