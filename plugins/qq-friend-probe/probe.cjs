'use strict';

// Observe QQ's own calls. Never create a session, invoke a service getter, or send a request.
const isObject = (value) => value !== null && (typeof value === 'object' || typeof value === 'function');
const { normalizeObservation, observeRequest, initialDiagnostics } = require('./request-observer.cjs');
const { isProxy, isPromise } = require('node:util').types;

// Only fixed type/descriptor metadata is reportable; values and thrown errors stay private.
function inspectProperty(object, key) {
  const info = { targetType: object === null ? 'null' : typeof object, kind: 'missing',
    own: null, depth: null, valueType: null, configurable: null, writable: null,
    enumerable: null, hasGetter: null, hasSetter: null, extensible: null };
  if (!isObject(object)) return { info: { ...info, kind: 'invalid-target' }, descriptor: null };
  try {
    info.extensible = Object.isExtensible(object);
    let current = object;
    for (let depth = 0; current && depth < 16; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        const data = Object.hasOwn(descriptor, 'value');
        Object.assign(info, { kind: data ? 'data' : 'accessor', own: depth === 0, depth,
          valueType: data ? (descriptor.value === null ? 'null' : typeof descriptor.value) : null,
          configurable: !!descriptor.configurable, writable: data ? !!descriptor.writable : null,
          enumerable: !!descriptor.enumerable,
          hasGetter: data ? null : typeof descriptor.get === 'function',
          hasSetter: data ? null : typeof descriptor.set === 'function' });
        return { info, descriptor: data ? descriptor : null };
      }
      current = Object.getPrototypeOf(current);
    }
    if (current) info.kind = 'depth-limit';
  } catch {
    info.kind = 'inspection-failed';
  }
  return { info, descriptor: null };
}

function dataDescriptor(object, key) {
  for (let current = object, depth = 0; current && depth < 16; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return Object.hasOwn(descriptor, 'value') ? descriptor : null;
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function ownUin(config) {
  if (!config || typeof config !== 'object' || isProxy(config)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(config, 'selfUin');
  const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  return typeof value === 'string' && /^\d{5,20}$/.test(value) ? value : null;
}

function startProbe({ runtime, cache = {}, expectedUin, attestWrapper, onReport,
  requestObservation = null, onBinding = null, onBuddyBinding = null, persistent = false, acquireAddService = false, timeoutMs = 120000, now = Date.now, timers = { setTimeout, clearTimeout } }) {
  if (!/^\d{5,20}$/.test(expectedUin ?? '') || typeof expectedUin !== 'string') {
    throw new Error('expectedUin must be an explicit QQ account string');
  }
  if (!runtime || typeof attestWrapper !== 'function' || typeof onReport !== 'function') {
    throw new Error('Missing probe dependencies');
  }
  const observation = requestObservation === null ? null : normalizeObservation(requestObservation);
  // Local loader callback only, never configured through a model/IPC request.
  // A binding observer does not also wrap the outgoing request method.
  if (onBinding !== null && (typeof onBinding !== 'function' || isProxy(onBinding) || observation)) {
    throw new Error('A local binding observer cannot be combined with request observation');
  }
  if (onBuddyBinding !== null && (!onBinding || typeof onBuddyBinding !== 'function' || isProxy(onBuddyBinding))) {
    throw new Error('Buddy binding requires the local binding mode');
  }
  if ((persistent || acquireAddService) && !onBinding) throw new Error('Active service mode requires local binding');
  const maxTimeoutMs = observation || onBinding ? 1800000 : 300000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > maxTimeoutMs) {
    throw new Error(`timeoutMs must be between 1000 and ${maxTimeoutMs}`);
  }
  const isWrapper = (filename) => typeof filename === 'string' && /(?:^|[\\/])wrapper\.node$/i.test(filename);
  const state = {
    kind: 'passive-qq-friend-capability-probe',
    phase: 'waiting-wrapper', active: true, wrapperVerified: false,
    sessionObserved: false, identityMatched: false, initCallReturned: false,
    buddyServiceObserved: false, reqToAddFriendsPresent: null,
    loginOnlineVerified: false, requestSchemaVerified: false, requestSent: false,
    cleanupComplete: null,
    diagnostics: {}, hookFailure: null, observationRoute: null,
  };
  if (observation) Object.assign(state, { kind: 'passive-qq-friend-request-probe',
    requestSent: null, probeInitiatedRequest: false, qqRequestObserved: false,
    requestObservation: null, requestResult: null, requestRoute: null,
    addBuddyServiceObserved: false, addBuddyPresent: null,
    observationWindowMs: timeoutMs, observationExpiresAt: new Date(now() + timeoutMs).toISOString(),
    requestDiagnostics: { buddy: initialDiagnostics(), ...(observation.observeAddBuddy ? { 'add-buddy': initialDiagnostics() } : {}) } });
  const restores = [];
  const seenSessions = new WeakSet();
  let timer;
  let wrapperSeen = false;
  let lastReport = '';
  let binding = null;
  let buddyEpoch = 0;
  let epoch = 0;
  let initializedSession = null;
  function revokeBinding(includeBuddy = true) {
    binding = null;
    if (includeBuddy) buddyEpoch++;
    epoch++;
    // Invalidation precedes notification. Callback failures never retain authority.
    if (onBinding) { try { onBinding(null); } catch {} }
    if (includeBuddy && onBuddyBinding) { try { onBuddyBinding(null); } catch {} }
  }
  const snapshot = () => ({ ...state,
    ...(observation ? { requestObservation: state.requestObservation && structuredClone(state.requestObservation),
      requestResult: state.requestResult && { ...state.requestResult },
      requestDiagnostics: structuredClone(state.requestDiagnostics) } : {}),
    diagnostics: Object.fromEntries(Object.entries(state.diagnostics).map(([key, info]) => [key, { ...info }])),
    hookFailure: state.hookFailure ? { ...state.hookFailure } : null });
  function inspect(object, key, target) {
    const property = inspectProperty(object, key);
    state.diagnostics[target] = property.info;
    return property;
  }
  function failHook(target, reason) {
    // Keep the first failure, which caused the probe to stop progressing.
    state.hookFailure ??= { target, reason };
    return false;
  }
  function readObjectProperty(object, key, target) {
    const { info, descriptor } = inspect(object, key, target);
    if (info.kind !== 'data') { failHook(target, info.kind); return null; }
    if (!isObject(descriptor.value)) { failHook(target, 'not-object'); return null; }
    return descriptor.value;
  }
  function publish() {
    const report = snapshot();
    const serialized = JSON.stringify(report);
    if (serialized === lastReport) return;
    lastReport = serialized;
    try { onReport(report); } catch { /* Reporting must never affect QQ. */ }
  }
  function stop(reason = 'stopped') {
    if (!state.active) return snapshot();
    state.active = false;
    revokeBinding();
    state.phase = reason;
    if (timer !== undefined) timers.clearTimeout(timer);
    state.cleanupComplete = true;
    for (const restore of restores.reverse()) {
      try { if (!restore()) state.cleanupComplete = false; }
      catch { state.cleanupComplete = false; }
    }
    restores.length = 0;
    publish();
    return snapshot();
  }
  function observeSafely(action) {
    if (!state.active) return;
    try { action(); } catch { stop('observer-error'); }
  }
  function replaceFunction(object, key, target, makeReplacement) {
    const { info, descriptor } = inspect(object, key, target);
    if (info.kind !== 'data') return failHook(target, info.kind);
    if (typeof descriptor.value !== 'function') return failHook(target, 'not-function');
    const originalOwn = info.own ? descriptor : null;
    if (originalOwn && !originalOwn.configurable && !originalOwn.writable) return failHook(target, 'fixed-property');
    if (!originalOwn && !info.extensible) return failHook(target, 'non-extensible-target');
    const replacement = makeReplacement(descriptor.value);
    try {
      Object.defineProperty(object, key, originalOwn
        ? { ...originalOwn, value: replacement }
        : { value: replacement, writable: true, configurable: true, enumerable: descriptor.enumerable });
    } catch { return failHook(target, 'define-failed'); }
    restores.push(() => {
      const current = Object.getOwnPropertyDescriptor(object, key);
      // Do not overwrite a hook installed by somebody else after ours.
      if (current?.value !== replacement) return false;
      if (originalOwn) Object.defineProperty(object, key, originalOwn);
      else delete object[key];
      return true;
    });
    return true;
  }
  function patchMethod(object, key, target, after, before) {
    return replaceFunction(object, key, target, (original) => function (...args) {
      // Preserve native this, arguments, return/Promise identity and original exceptions.
      if (before) observeSafely(() => before(args, this));
      const result = Reflect.apply(original, this, args);
      observeSafely(() => after(args, result, this));
      return result;
    });
  }
  function patchConstructor(exports) {
    return replaceFunction(exports, 'NodeIQQNTWrapperSession', 'sessionConstructor', (original) => {
      // QQ 9.9.26 exports the native constructor, with no static create method.
      // Intercept only QQ's own calls. Never proxy the resulting native instance.
      const replacement = new Proxy(original, {
        apply(target, receiver, args) {
          const session = Reflect.apply(target, receiver, args);
          observeSafely(() => observeSession(session));
          return session;
        },
        construct(target, args, newTarget) {
          const session = Reflect.construct(target, args, newTarget === replacement ? target : newTarget);
          observeSafely(() => observeSession(session));
          return session;
        },
      });
      return replacement;
    });
  }
  function patchSessionGetterFacade(exports, factory, getter) {
    return replaceFunction(exports, 'NodeIQQNTWrapperSession', 'sessionConstructor', (original) => {
      if (original !== factory) throw new Error('Factory changed during observation setup');
      // The native static getter is fixed. Preserve it and expose a forwarding constructor
      // through the writable module export. A bound target has no own prototype/caller
      // properties that would conflict when copying the native constructor descriptors.
      // Inspect constructor descriptors only; never enumerate session or credential objects.
      const descriptors = Object.getOwnPropertyDescriptors(original);
      let facade;
      const forwardedGetter = function (...args) {
        const session = Reflect.apply(getter, this === facade ? original : this, args);
        observeSafely(() => observeSession(session));
        return session;
      };
      descriptors.getNTWrapperSession = { ...descriptors.getNTWrapperSession, value: forwardedGetter };
      const target = (function () {}).bind(null);
      Object.setPrototypeOf(target, Object.getPrototypeOf(original));
      facade = new Proxy(target, {
        apply(_target, receiver, args) {
          const session = Reflect.apply(original, receiver === facade ? original : receiver, args);
          observeSafely(() => observeSession(session));
          return session;
        },
        construct(_target, args, newTarget) {
          const session = Reflect.construct(original, args, newTarget === facade ? original : newTarget);
          observeSafely(() => observeSession(session));
          return session;
        },
      });
      Object.defineProperties(facade, descriptors);
      return facade;
    });
  }
  function inspectIfReady(record) {
    if (!record.identityMatched || !record.service) return;
    state.identityMatched = true;
    state.buddyServiceObserved = true;
    if (onBuddyBinding && !record.buddyBindings.has(record.service)) {
      const receiver = record.service;
      if (isProxy(receiver)) { stop('unsupported-buddy-binding'); return; }
      // QQ returns multiple JS handles for the same initialized session. An
      // earlier handle still owns its registered listener; a later getter is
      // not a new login. Revoke all handles on session/identity invalidation.
      const generation = buddyEpoch;
      const next = Object.freeze({ accountUin: expectedUin, receiver,
        isCurrent: () => state.active && generation === buddyEpoch && record.identityMatched });
      record.buddyBindings.set(receiver, next);
      onBuddyBinding(next);
    }
    state.reqToAddFriendsPresent = typeof dataDescriptor(record.service, 'reqToAddFriends')?.value === 'function';
    if (!observation && !onBinding) {
      stop(state.reqToAddFriendsPresent ? 'capability-present' : 'capability-not-observed');
      return;
    }
    if (!state.reqToAddFriendsPresent) {
      if (!onBinding && !observation.observeAddBuddy) stop('capability-not-observed');
      return;
    }
    if (observation) hookRequestService(record, record.service, 'buddy');
  }
  function inspectAddIfReady(record) {
    if ((!observation?.observeAddBuddy && !onBinding) || !record.identityMatched || !record.addService) return;
    state.addBuddyServiceObserved = true;
    state.addBuddyPresent = typeof dataDescriptor(record.addService, 'addBuddy')?.value === 'function';
    if (onBinding) {
      const receiver = record.addService;
      const method = dataDescriptor(receiver, 'addBuddy')?.value;
      if (!state.addBuddyPresent || isProxy(receiver) || isProxy(method)) { stop('unsupported-add-buddy-binding'); return; }
      if (binding?.receiver === receiver && binding.method === method) return;
      revokeBinding(false);
      if (!state.active) return;
      const generation = epoch;
      const next = Object.freeze({ accountUin: expectedUin, receiver, method, epoch: generation,
        isCurrent: () => state.active && binding === next && epoch === generation && record.identityMatched
          && record.addService === receiver && dataDescriptor(receiver, 'addBuddy')?.value === method });
      binding = next;
      state.phase = 'binding-ready';
      onBinding(next);
      publish();
    } else if (state.addBuddyPresent) hookRequestService(record, record.addService, 'add-buddy');
  }
  function hookRequestService(record, service, route) {
    const add = route === 'add-buddy';
    const observed = add ? record.addRequestServices : record.requestServices;
    if (observed.has(service)) return;
    const hooked = replaceFunction(service, add ? 'addBuddy' : 'reqToAddFriends', add ? 'addBuddyRequest' : 'friendRequest', original => observeRequest(original, {
      config: observation,
      route, expectedReceiver: service,
      // QQ may cache earlier wrappers from this same initialized session. All are valid
      // until identity invalidation, not just the last object returned by its getter.
      isActive: () => state.active && record.identityMatched && observed.has(service),
      diagnosticState: state.requestDiagnostics[route],
      onDiagnostic() { publish(); },
      onRequest(metadata) {
        // Across multiple service objects, only the first matching QQ request is recorded.
        if (state.qqRequestObserved) return false;
        state.qqRequestObserved = true;
        state.requestRoute = route;
        state.requestObservation = metadata;
        state.phase = 'waiting-request-result';
        publish();
        return true;
      },
      onFinish(phase, result) { state.requestResult = result; stop(phase); },
    }));
    if (!hooked) { if (!observation.observeAddBuddy) stop('unsupported-request-hook'); else publish(); return; }
    observed.add(service);
    if (!state.qqRequestObserved) state.phase = 'waiting-target-request';
    publish();
  }
  function observeSession(session) {
    if (!session || (typeof session !== 'object' && typeof session !== 'function') || seenSessions.has(session)) return;
    seenSessions.add(session);
    state.sessionObserved = true;
    const record = { identityMatched: false, service: null, initStarted: false, buddyBindings: new WeakMap(),
      requestServices: new WeakSet(), addRequestServices: new WeakSet() };
    const initPatched = patchMethod(session, 'init', 'sessionInit', (args, returned, receiver) => {
      if (onBinding && receiver !== session) { stop('session-receiver-mismatch'); return; }
      if (onBinding && isPromise(returned)) { stop('unsupported-async-init'); return; }
      const uin = ownUin(args[0]);
      if (!uin) { state.phase = 'waiting-account-identity'; publish(); return; }
      if (uin !== expectedUin) {
        state.identityMatched = false;
        stop('account-mismatch');
        return;
      }
      record.identityMatched = true;
      state.identityMatched = true;
      state.initCallReturned = true;
      inspectIfReady(record);
      if (state.active && acquireAddService && !record.addService) {
        const getter = dataDescriptor(session, 'getAddBuddyService')?.value;
        if (typeof getter !== 'function' || isProxy(getter)) { stop('unsupported-add-buddy-getter'); return; }
        Reflect.apply(getter, session, []);
      }
      if (state.active) inspectAddIfReady(record);
      publish();
    }, () => {
      if (onBinding && initializedSession && initializedSession !== session) stop('session-replaced');
      if (onBinding) initializedSession = session;
      // A second init invalidates an in-flight observation, even if native init throws.
      if ((observation || onBinding) && record.initStarted) stop('account-reinitialized');
      if (onBinding) revokeBinding();
      // Invalidate before a new init, including nested service calls or a native throw.
      record.identityMatched = false;
      if (record.initStarted) { record.service = null; record.addService = null; }
      record.initStarted = true;
      state.identityMatched = false;
      state.initCallReturned = false;
      publish();
    });
    if (!initPatched) { stop('unsupported-session-hook'); return; }
    const servicePatched = patchMethod(session, 'getBuddyService', 'sessionBuddyGetter', (_args, service, receiver) => {
      if (onBuddyBinding && receiver !== session) { stop('session-receiver-mismatch'); return; }
      if (service && (typeof service === 'object' || typeof service === 'function')) record.service = service;
      else if (onBuddyBinding) { record.service = null; stop('buddy-service-unavailable'); return; }
      inspectIfReady(record);
    });
    if (!initPatched || !servicePatched) { stop('unsupported-session-hook'); return; }
    if (observation?.observeAddBuddy || onBinding) {
      // This route is optional. An absent/fixed getter must not disable the legacy route.
      const addPatched = patchMethod(session, 'getAddBuddyService', 'sessionAddBuddyGetter', (_args, service, receiver) => {
        if (onBinding && receiver !== session) { stop('session-receiver-mismatch'); return; }
        if (isObject(service)) record.addService = service;
        else if (onBinding) { revokeBinding(false); record.addService = null; }
        inspectAddIfReady(record);
      });
      if (onBinding && !addPatched) { stop('unsupported-add-buddy-getter'); return; }
    }
    state.phase = 'waiting-qq-session-calls';
    publish();
  }

  if (Object.keys(cache).some(isWrapper)) {
    stop('wrapper-already-loaded');
    return { stop, snapshot };
  }
  const hooked = patchMethod(runtime, 'dlopen', 'loader', (args) => {
    const [module, filename] = args;
    if (!isWrapper(filename)) return;
    if (wrapperSeen) { if (onBinding) stop('wrapper-reloaded'); return; }
    wrapperSeen = true;
    if (attestWrapper(filename) !== true) { stop('wrapper-attestation-failed'); return; }
    state.wrapperVerified = true;
    const exports = readObjectProperty(module, 'exports', 'moduleExports');
    const factory = exports && readObjectProperty(exports, 'NodeIQQNTWrapperSession', 'sessionFactory');
    if (!factory) { stop('unsupported-factory-hook'); return; }
    const create = inspect(factory, 'create', 'factoryCreate');
    // The local binary and upstream wrapper types also expose getNTWrapperSession.
    // Observe QQ's call without reading its argument or invoking the getter ourselves.
    let route = 'static-create';
    let factoryHooked;
    if (create.info.kind === 'missing') {
      const getter = inspect(factory, 'getNTWrapperSession', 'sessionGetter');
      if (getter.info.kind !== 'missing') {
        route = 'static-session-getter';
        if (typeof factory === 'function' && getter.info.own && getter.info.valueType === 'function'
          && getter.info.configurable === false && getter.info.writable === false) {
          route = 'static-session-getter-facade';
          factoryHooked = patchSessionGetterFacade(exports, factory, getter.descriptor.value);
        } else factoryHooked = patchMethod(factory, 'getNTWrapperSession', 'sessionGetter', (_args, session) => observeSession(session));
      } else if (typeof factory === 'function') {
        // These diagnostics describe only named properties, never arbitrary native data.
        const prototype = inspect(factory, 'prototype', 'factoryPrototype');
        if (isObject(prototype.descriptor?.value)) {
          inspect(prototype.descriptor.value, 'getNTWrapperSession', 'prototypeSessionGetter');
          inspect(prototype.descriptor.value, 'init', 'prototypeInit');
          inspect(prototype.descriptor.value, 'getBuddyService', 'prototypeBuddyGetter');
        }
        route = 'native-constructor';
        factoryHooked = patchConstructor(exports);
      } else factoryHooked = failHook('factoryCreate', 'missing');
    } else factoryHooked = patchMethod(factory, 'create', 'factoryCreate', (_args, session) => observeSession(session));
    if (!factoryHooked) {
      stop('unsupported-factory-hook');
      return;
    }
    state.observationRoute = route;
    state.phase = 'waiting-qq-session-create';
    publish();
  });
  if (!hooked) stop('unsupported-loader-hook');
  else {
    if (!persistent) timer = timers.setTimeout(() => stop('timeout'), timeoutMs);
    timer?.unref?.();
    publish();
  }
  return { stop, snapshot };
}

module.exports = { startProbe };
