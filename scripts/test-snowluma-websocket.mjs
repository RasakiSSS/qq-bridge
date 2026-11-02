import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { ReliableSnowLumaWebSocketClient } from '../src/snowluma-websocket.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('test deadline exceeded')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}
function fixture(t, options = {}) {
  const sockets = [];
  class Socket extends EventEmitter {
    readyState = 0;
    sent = [];
    constructor(url) { super(); this.url = url; sockets.push(this); }
    open() { this.readyState = 1; this.emit('open'); }
    close(code, reason) { this.readyState = 2; this.closedWith = { code, reason }; }
    end(code = 1006) { this.readyState = 3; this.emit('close', code, 'ended'); }
    send(value) { this.sent.push(JSON.parse(value)); }
    packet(value) { this.emit('message', JSON.stringify(value)); }
  }
  const client = new ReliableSnowLumaWebSocketClient({
    url: 'ws://127.0.0.1:9', webSocket: Socket, connectTimeoutMs: 500,
    reconnect: { minDelayMs: 5, maxDelayMs: 10 }, ...options,
  });
  t.after(() => client.close());
  return { client, sockets };
}

test('real Node WebSocket HTTP 401 settles and retries without a close event', async t => {
  let upgrades = 0;
  const server = http.createServer();
  const peers = new Set();
  server.on('connection', peer => { peers.add(peer); peer.on('close', () => peers.delete(peer)); });
  server.on('upgrade', (_req, socket) => {
    upgrades++;
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new ReliableSnowLumaWebSocketClient({
    url: `ws://127.0.0.1:${server.address().port}`, connectTimeoutMs: 500,
    reconnect: { minDelayMs: 5, maxDelayMs: 5, retries: 1 },
  });
  t.after(async () => {
    client.close();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  let closes = 0;
  const retried = new Promise(resolve => client.on('close', () => { if (++closes === 2) resolve(); }));
  await assert.rejects(bounded(client.connect()), /transport failed/);
  await bounded(retried);
  assert.equal(upgrades, 2);
  assert.equal(client.connectPromise, null);
  assert.equal(client.reconnectTimer, null);
});

test('error-only handshake is retired and unchanged credentials reconnect successfully', async t => {
  const { client, sockets } = fixture(t);
  const rejected = assert.rejects(client.connect(), /transport failed/);
  sockets[0].emit('error', new Error('failed'));
  await rejected;
  await delay(20);
  assert.equal(sockets.length, 2);
  const connected = client.connect();
  sockets[1].open();
  await connected;
  assert.equal(client.isConnected, true);
  assert.equal(sockets[1].url, sockets[0].url);
});

test('handshake deadline retires a transport that emits nothing', async t => {
  const { client, sockets } = fixture(t, { connectTimeoutMs: 10, reconnect: false });
  await assert.rejects(bounded(client.connect()), /handshake timed out/);
  assert.equal(client.connectPromise, null);
  assert.equal(client.isConnected, false);
  assert.equal(sockets[0].closedWith.code, 1000);
});

test('concurrent connect calls share one attempt', async t => {
  const { client, sockets } = fixture(t);
  const first = client.connect(), second = client.connect();
  assert.equal(first, second);
  assert.equal(sockets.length, 1);
  sockets[0].open();
  await Promise.all([first, second]);
});

test('manual close settles handshake waiters and cancels automatic retries', async t => {
  const { client, sockets } = fixture(t);
  const rejected = assert.rejects(client.connect(), /client closed/);
  client.close();
  await rejected;
  sockets[0].end();
  await delay(20);
  assert.equal(sockets.length, 1);
  assert.equal(client.reconnectTimer, null);
});

test('late events from replaced socket cannot clear connection or reject new requests', async t => {
  const { client, sockets } = fixture(t);
  const oldPromise = client.connect();
  sockets[0].open();
  await oldPromise;
  const oldCallbacks = Object.fromEntries(['open', 'close', 'message', 'error']
    .map(name => [name, sockets[0].listeners(name)[0]]));
  client.close(1000, 'token-refresh');
  client.accessToken = 'replacement-fixture-token';
  const replacement = client.connect();
  sockets[1].open();
  await replacement;
  const login = client.getLoginInfo();
  await Promise.resolve();
  oldCallbacks.close(1006, 'late');
  oldCallbacks.error(new Error('late'));
  oldCallbacks.open();
  oldCallbacks.message(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 1 }));
  const request = sockets[1].sent[0];
  assert.equal(request.action, 'get_login_info');
  sockets[1].packet({ status: 'ok', retcode: 0, echo: request.echo, data: { user_id: 123, nickname: 'fixture' } });
  assert.equal((await login).user_id, 123);
  assert.equal(client.isConnected, true);
  assert.equal(client.socket, sockets[1]);
  assert.equal(client.reconnectTimer, null);
});

test('explicit close rejects old handshake even if transport never closes, replacement can open', async t => {
  const { client, sockets } = fixture(t);
  const old = assert.rejects(client.connect(), /client closed/);
  client.close(1000, 'token-refresh');
  const next = client.connect();
  sockets[1].open();
  await Promise.all([old, next]);
  sockets[0].end();
  assert.equal(client.socket, sockets[1]);
});

test('open connection forwards events and rejects pending API calls on transport failure', async t => {
  const { client, sockets } = fixture(t, { reconnect: false });
  const connected = client.connect();
  sockets[0].open();
  await connected;
  const event = new Promise(resolve => client.onEvent(resolve));
  sockets[0].packet({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: true } });
  assert.equal((await event).status.good, true);
  const pending = assert.rejects(client.getLoginInfo(), /transport failed/);
  await Promise.resolve();
  sockets[0].emit('error', new Error('lost'));
  await pending;
  assert.equal(client.pending.size, 0);
  assert.equal(client.isConnected, false);
});

test('constructor exceptions settle, are credential-free, and obey retry limit', async t => {
  let created = 0;
  const { client } = fixture(t, { webSocket: class {
    constructor() { created++; throw new Error('secret-fixture-token'); }
  }, reconnect: { minDelayMs: 1, maxDelayMs: 1, retries: 1 } });
  const errors = [];
  client.on('error', error => errors.push(error.message));
  await assert.rejects(client.connect(), /construction failed/);
  await delay(20);
  assert.equal(created, 2);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(message => !message.includes('secret-fixture-token')));
  assert.equal(client.connectPromise, null);
});

test('manual shutdown inside error callback cancels the already scheduled retry', async t => {
  const { client, sockets } = fixture(t);
  client.on('error', () => client.close());
  const pending = assert.rejects(client.connect(), /transport failed/);
  sockets[0].emit('error', new Error('no retry'));
  await pending;
  await delay(20);
  assert.equal(sockets.length, 1);
});

test('reconnect from error callback cannot be followed by a stale close notification', async t => {
  const { client, sockets } = fixture(t);
  let connected = false, replacement;
  const events = [];
  client.on('open', () => { connected = true; events.push('open'); });
  client.on('close', () => { connected = false; events.push('close'); });
  client.once('error', () => {
    events.push('error');
    replacement = client.connect();
    sockets[1].open();
  });
  const old = assert.rejects(client.connect(), /transport failed/);
  sockets[0].emit('error', new Error('fixture'));
  await Promise.all([old, replacement]);
  assert.deepEqual(events, ['close', 'error', 'open']);
  assert.equal(connected, true);
  assert.equal(client.isConnected, true);
});

test('replacement created by close subscriber suppresses the retired error notification', async t => {
  const { client, sockets } = fixture(t);
  let replacement;
  const events = [];
  client.on('open', () => events.push('open'));
  client.on('error', () => events.push('error'));
  client.once('close', () => {
    events.push('close');
    replacement = client.connect();
    sockets[1].open();
  });
  const old = assert.rejects(client.connect(), /transport failed/);
  sockets[0].emit('error', new Error('fixture'));
  await Promise.all([old, replacement]);
  assert.deepEqual(events, ['close', 'open']);
  assert.equal(client.isConnected, true);
});

test('a successful connection cancels its handshake deadline', async t => {
  const { client, sockets } = fixture(t, { connectTimeoutMs: 10 });
  const ready = client.connect();
  sockets[0].open();
  await ready;
  await delay(25);
  assert.equal(client.isConnected, true);
  assert.equal(sockets.length, 1);
});

test('CLOSING socket is retired before a new request connects, even with no request deadline', async t => {
  const { client, sockets } = fixture(t, { requestTimeoutMs: 0 });
  const initial = client.connect();
  sockets[0].open();
  await initial;
  const oldRequest = assert.rejects(client.getLoginInfo(), /no longer open/);
  await Promise.resolve();
  sockets[0].readyState = 2;
  const replacement = client.connect();
  await oldRequest;
  assert.equal(client.pending.size, 0);
  assert.equal(sockets[0].listenerCount('close'), 0);
  assert.equal(sockets[0].listenerCount('message'), 0);
  sockets[1].open();
  await replacement;
  sockets[0].end();
  assert.equal(client.isConnected, true);
});

test('reentrant close subscriber reconnects without creating a duplicate attempt', async t => {
  const { client, sockets } = fixture(t);
  const first = client.connect();
  sockets[0].open();
  await first;
  let fromClose;
  client.once('close', () => { fromClose = client.connect(); });
  sockets[0].readyState = 2;
  const fromRequest = client.connect();
  assert.equal(fromClose, fromRequest);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  await fromRequest;
});

test('manual shutdown during retirement prevents the requested replacement', async t => {
  const { client, sockets } = fixture(t);
  const first = client.connect();
  sockets[0].open();
  await first;
  client.once('close', () => client.close());
  sockets[0].readyState = 2;
  await assert.rejects(client.connect(), /client closed/);
  assert.equal(sockets.length, 1);
});

for (const removal of ['missing', 'throwing']) {
  test(`optional or broken listener removal cannot strand handshake (${removal})`, async t => {
    class Socket {
      readyState = 0;
      handlers = new Map();
      constructor() {
        if (removal === 'throwing') this.removeEventListener = () => { throw new Error('cleanup failed'); };
      }
      addEventListener(event, handler) { this.handlers.set(event, handler); }
      close() { this.readyState = 3; }
    }
    const { client } = fixture(t, { webSocket: Socket, reconnect: false });
    const rejected = assert.rejects(client.connect(), /transport failed/);
    const old = client.socket;
    old.handlers.get('error')(new Error('fixture'));
    await rejected;
    old.handlers.get('open')();
    old.handlers.get('close')({ code: 1006 });
    assert.equal(client.isConnected, false);
    assert.equal(old.readyState, 3);
    assert.equal(client.connectPromise, null);
  });
}

test('malformed data is an SDK parse error, not a transport reset', async t => {
  const { client, sockets } = fixture(t);
  const ready = client.connect();
  sockets[0].open();
  await ready;
  const errors = [];
  client.on('error', error => errors.push(error.name));
  sockets[0].emit('message', '{invalid');
  assert.deepEqual(errors, ['SnowLumaParseError']);
  assert.equal(client.isConnected, true);
});

test('close event without error settles and triggers one retry, including EventTarget shape', async t => {
  const { client, sockets } = fixture(t);
  const rejected = assert.rejects(client.connect(), /WebSocket closed/);
  sockets[0].readyState = 3;
  sockets[0].emit('close', { code: 1006, reason: 'fixture' });
  await rejected;
  await delay(20);
  assert.equal(sockets.length, 2);
  const ready = client.connect();
  sockets[1].open();
  await ready;
});
