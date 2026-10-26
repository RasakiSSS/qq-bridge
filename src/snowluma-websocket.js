import { SnowLumaWebSocketClient, SnowLumaConnectionError, SnowLumaTimeoutError } from '@snowluma/sdk';

function listen(socket, event, handler) {
  if (socket.addEventListener) {
    socket.addEventListener(event, handler);
    return () => socket.removeEventListener?.(event, handler);
  }
  socket.on(event, handler);
  return () => socket.off ? socket.off(event, handler) : socket.removeListener?.(event, handler);
}

function closeInfo(args) {
  const first = args[0];
  return first && typeof first === 'object'
    ? { code: first.code, reason: first.reason }
    : { code: first, reason: String(args[1] ?? '') };
}

/**
 * Keep SDK message/API handling, but own socket lifetimes. SDK 1.14.20 waits for
 * close after a handshake error; Node 22's WebSocket can emit only error, leaving
 * connect() pending forever. Each attempt here settles independently, including
 * explicit close, and detached sockets cannot clear a replacement connection.
 */
export class ReliableSnowLumaWebSocketClient extends SnowLumaWebSocketClient {
  #attempt = null;

  constructor(options = {}) {
    super(options);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    if (!Number.isFinite(this.connectTimeoutMs) || this.connectTimeoutMs <= 0) {
      throw new TypeError('connectTimeoutMs must be a positive finite number');
    }
  }

  connect() {
    if (this.isConnected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    if (this.#attempt) {
      // A transport may enter CLOSING before delivering close. SDK requests can
      // call connect() in that gap: retire its pending requests/listeners first.
      this.#retire(this.#attempt, new SnowLumaConnectionError('SnowLuma WebSocket no longer open'),
        { code: 1006, reason: 'connection-not-open' }, false, false);
      if (this.closedByUser) return Promise.reject(new SnowLumaConnectionError('SnowLuma WebSocket client closed'));
      // A close subscriber may have already started a replacement.
      return this.connect();
    }
    this.closedByUser = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const attempt = { socket: null, off: [], timer: null, resolve, reject, opened: false };
    this.#attempt = attempt;
    this.connectPromise = promise;
    try {
      const url = new URL(this.url);
      if (this.accessToken) url.searchParams.set('access_token', this.accessToken);
      const socket = new this.WebSocketCtor(url.toString(), this.protocols);
      attempt.socket = socket;
      this.socket = socket;
      const on = (event, fn) => attempt.off.push(listen(socket, event, (...args) => {
        if (this.#attempt === attempt) fn(...args);
      }));
      on('open', () => {
        if (attempt.opened) return;
        attempt.opened = true;
        clearTimeout(attempt.timer);
        this.connectPromise = null;
        this.reconnectAttempts = 0;
        resolve();
        this.emitter.emit('open', undefined);
      });
      on('message', (...args) => {
        if (attempt.opened) this.handleMessage(args);
      });
      on('error', () => {
        // Keep transport errors credential-free: some implementations embed the
        // full URL (including access_token) in their error object/message.
        this.#retire(attempt, new SnowLumaConnectionError('SnowLuma WebSocket transport failed'),
          { code: 1006, reason: 'transport-error' }, true, true);
      });
      on('close', (...args) => this.#retire(attempt,
        new SnowLumaConnectionError('SnowLuma WebSocket closed'), closeInfo(args), false, true));
      attempt.timer = setTimeout(() => this.#retire(attempt,
        new SnowLumaTimeoutError('SnowLuma WebSocket handshake timed out', this.connectTimeoutMs),
        { code: 1006, reason: 'handshake-timeout' }, true, true), this.connectTimeoutMs);
    } catch {
      // Defer notification until callers can attach a rejection handler, and
      // avoid publishing URLs/credentials from constructor exceptions.
      queueMicrotask(() => this.#retire(attempt,
        new SnowLumaConnectionError('SnowLuma WebSocket construction failed'),
        { code: 1006, reason: 'construction-failed' }, true, true));
    }
    return promise;
  }

  #retire(attempt, error, info, reportError, retry) {
    if (this.#attempt !== attempt) return;
    this.#attempt = null;
    this.socket = null;
    this.connectPromise = null;
    clearTimeout(attempt.timer);
    for (const off of attempt.off) {
      try { off(); } catch { /* Attempt identity still guards callbacks. */ }
    }
    // Some EventEmitter-based sockets emit an asynchronous error on close while
    // CONNECTING. Leave only a no-op error sink, never a client-state listener.
    if (!attempt.socket?.addEventListener) attempt.socket?.on?.('error', () => {});
    attempt.reject(error);
    this.rejectPending(error);
    try {
      if (attempt.socket && attempt.socket.readyState !== 3) {
        attempt.socket.close(info.code === 1006 ? 1000 : (info.code ?? 1000),
          info.code === 1006 ? 'connection-reset' : (info.reason ?? 'normal'));
      }
    } catch { /* Broken transports still must settle and retry. */ }
    if (retry) this.scheduleReconnect();
    this.emitter.emit('close', info);
    // A close subscriber may have replaced the transport synchronously. The
    // retired promise is already rejected; do not notify its error as current.
    if (reportError && !this.#attempt) this.emitter.emit('error', error);
  }

  close(code = 1000, reason = 'normal') {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const error = new SnowLumaConnectionError('SnowLuma WebSocket client closed');
    if (this.#attempt) this.#retire(this.#attempt, error, { code, reason }, false, false);
    else this.rejectPending(error);
  }

  scheduleReconnect() {
    if (this.closedByUser || !this.reconnect || this.reconnectTimer || this.isConnected || this.connectPromise) return;
    const { retries = Infinity, minDelayMs = 1000, maxDelayMs = 30_000 } = this.reconnect;
    if (this.reconnectAttempts >= retries) return;
    const delay = Math.min(maxDelayMs, minDelayMs * 2 ** this.reconnectAttempts++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Each failed attempt already schedules its next retry. Do not let a
      // rejection from an older attempt schedule work for its replacement.
      void this.connect().catch(() => {});
    }, delay);
  }
}
