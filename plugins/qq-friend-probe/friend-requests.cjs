'use strict';

// Read QQ's client request-list view through a listener QQ registers itself.
// No listener is registered by this module; no unread counter is cleared.
const { isProxy, isPromise } = require('node:util').types;
const { QQ_VERSION, WRAPPER_SHA256, MAJOR_SHA256 } = require('./friend-adapter.cjs');
const own = (o, k) => {
  if (!o || typeof o !== 'object' || isProxy(o)) return undefined;
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d && Object.hasOwn(d, 'value') ? d.value : undefined;
};
function descriptor(o, k) {
  for (let n = 0; o && n < 16; n++, o = Object.getPrototypeOf(o)) {
    if (isProxy(o)) return null;
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (d) return Object.hasOwn(d, 'value') ? d : null;
  }
  return null;
}
const unknown = code => Object.freeze({ status: 'unknown', code, pending: null, scope: 'client-request-list', requestSent: false });
function summarizeBuddyRequests(data, targetUid) {
  const rows = own(data, 'buddyReqs');
  if (!Array.isArray(rows) || isProxy(rows) || rows.length > 20000) return unknown('ERR_REQUEST_LIST');
  let pending = false, matched = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = own(rows, String(i)), uid = own(row, 'friendUid');
    if (typeof uid !== 'string' || !/^u_[A-Za-z0-9_-]{5,128}$/.test(uid)) return unknown('ERR_REQUEST_LIST');
    if (uid !== targetUid) continue;
    const type = own(row, 'reqType'), decided = own(row, 'isDecide');
    if (!Number.isInteger(type) || type < 0 || type > 13 || typeof decided !== 'boolean') return unknown('ERR_REQUEST_LIST');
    matched++;
    // Keep incoming and outgoing unresolved requests distinct from decided
    // history. This view has no server-global completeness assertion.
    if (!decided && [0, 1, 13].includes(type)) pending = true;
    else if (!decided) return unknown('ERR_REQUEST_STATE');
  }
  return Object.freeze({ status: 'read', pending, matched, scope: 'client-request-list', requestSent: false });
}

function watchBuddyRequests(binding, { targetUid, dynamicTargets = false, timeoutMs = 10000, onReady = () => {} } = {}) {
  if ((!dynamicTargets && !/^u_[A-Za-z0-9_-]{5,128}$/.test(targetUid ?? '')) || !Number.isInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 120000 || typeof onReady !== 'function'
    || own(binding, 'qqVersion') !== QQ_VERSION || own(binding, 'wrapperSha256') !== WRAPPER_SHA256
    || own(binding, 'majorSha256') !== MAJOR_SHA256) throw new Error('ERR_INVALID_REQUEST_READER');
  const service = own(binding, 'receiver'), current = own(binding, 'isCurrent');
  if (!service || isProxy(service) || typeof current !== 'function' || isProxy(current)) throw new Error('ERR_INVALID_REQUEST_READER');
  const restores = [], listeners = new WeakSet(), registered = new Map();
  let stopped = false, ready = false, active = null;
  function live() { try { return !stopped && current() === true; } catch { return false; } }
  function finish(value) {
    if (!active) return;
    const op = active; active = null; clearTimeout(op.timer); op.resolve(value);
  }
  function wrap(object, key, factory) {
    if (!object || isProxy(object)) return false;
    const d = descriptor(object, key), originalOwn = Object.getOwnPropertyDescriptor(object, key);
    if (!d || typeof d.value !== 'function' || isProxy(d.value)
      || (originalOwn && !originalOwn.configurable && !originalOwn.writable)
      || (!originalOwn && !Object.isExtensible(object))) return false;
    const wrapped = factory(d.value);
    Object.defineProperty(object, key, originalOwn ? { ...originalOwn, value: wrapped }
      : { value: wrapped, configurable: true, writable: true, enumerable: d.enumerable });
    restores.push(() => {
      if (Object.getOwnPropertyDescriptor(object, key)?.value !== wrapped) return false;
      if (originalOwn) Object.defineProperty(object, key, originalOwn); else delete object[key];
      return true;
    });
    return true;
  }
  function stop() {
    stopped = true; ready = false; registered.clear(); finish(unknown('ERR_REQUEST_READER_STOPPED'));
    let cleanupComplete = true;
    for (const restore of restores.splice(0).reverse()) { try { if (!restore()) cleanupComplete = false; } catch { cleanupComplete = false; } }
    return { cleanupComplete };
  }
  function observe(listener) {
    if (!listener || typeof listener !== 'object' || isProxy(listener)) return false;
    if (listeners.has(listener)) return true;
    const ok = wrap(listener, 'onBuddyReqChange', original => function (...args) {
      // Snapshot the limited target status before QQ's callback can mutate data.
      let summary;
      try { if (live() && active && [...registered.values()].includes(listener)) summary = summarizeBuddyRequests(args[0], active.targetUid); } catch { summary = unknown('ERR_REQUEST_LIST'); }
      try { return Reflect.apply(original, this, args); }
      finally { if (summary && active) finish(live() ? summary : unknown('ERR_BINDING_LOST')); }
    });
    if (ok) listeners.add(listener);
    return ok;
  }
  if (!live()) throw new Error('ERR_BINDING_UNAVAILABLE');
  try {
    if (!wrap(service, 'addKernelBuddyListener', original => function (...args) {
      let observed = false;
      try { if (this === service && live()) observed = observe(args[0]); } catch { stop(); }
      let returned;
      try { returned = Reflect.apply(original, this, args); }
      catch (error) { stop(); throw error; }
      if (observed && live()) {
        // Native registration returns its listener id synchronously. Do not
        // infer readiness from a failed or asynchronous registration.
        // Local wrapper RVA DBBC59..DBBC68 converts the id to a UTF-8 string.
        if (typeof returned !== 'string' || !returned || returned.length > 256) stop();
        else { registered.set(returned, args[0]); ready = true; try { onReady(); } catch { stop(); } }
      }
      return returned;
    })) throw new Error('ERR_REQUEST_LISTENER_HOOK');
    if (!wrap(service, 'removeKernelBuddyListener', original => function (...args) {
      if (this === service && registered.has(args[0])) {
        registered.delete(args[0]); ready = registered.size > 0;
        if (active) { finish(unknown('ERR_REQUEST_LISTENER_REMOVED')); stop(); }
      }
      return Reflect.apply(original, this, args);
    })) throw new Error('ERR_REQUEST_LISTENER_HOOK');
  } catch (e) { stop(); throw e; }
  return Object.freeze({
    ready: () => ready && live(), stop,
    read(queryUid = targetUid) {
      if (!/^u_[A-Za-z0-9_-]{5,128}$/.test(queryUid ?? '') || (!dynamicTargets && queryUid !== targetUid)) return Promise.resolve(unknown('ERR_REQUEST_TARGET'));
      if (!live() || !ready) return Promise.resolve(unknown('ERR_REQUEST_LISTENER_UNAVAILABLE'));
      if (active) return Promise.resolve(unknown('ERR_BUSY'));
      return new Promise(resolve => {
        const op = { resolve, timer: null, targetUid: queryUid }; active = op;
        // No correlation id in onBuddyReqChange: after a timeout, retire this
        // reader so a late event cannot satisfy a later query.
        op.timer = setTimeout(() => { finish(unknown('ERR_REQUEST_TIMEOUT')); stop(); }, timeoutMs);
        try {
          const method = descriptor(service, 'getBuddyReq')?.value;
          if (typeof method !== 'function' || isProxy(method) || !live()) { finish(unknown('ERR_BINDING_LOST')); return; }
          // Verified local registry + wrapper ABI: exactly zero arguments.
          const returned = Reflect.apply(method, service, []);
          if (isPromise(returned)) Reflect.apply(Promise.prototype.then, returned, [undefined, () => {
            if (active === op) { finish(unknown('ERR_REQUEST_QUERY')); stop(); }
          }]);
          // The function's return is not a list. Only onBuddyReqChange resolves.
        } catch { if (active === op) { finish(unknown('ERR_REQUEST_QUERY')); stop(); } }
      });
    },
  });
}
module.exports = { summarizeBuddyRequests, watchBuddyRequests };
