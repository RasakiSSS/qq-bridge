import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const pins = require('../plugins/qq-friend-probe/friend-adapter.cjs');
const source = fs.readFileSync(new URL('../plugins/qq-friend-probe/validation-main.cjs', import.meta.url), 'utf8');
function fixture(extra = {}) {
  const token = 'a'.repeat(64), writes = [], actions = [], calls = [], readers = [];
  let handler, binderOpts, validationDeps, timer, stopped = 0;
  const config = { enabled: true, mode: 'maintenance-send-once', controlToken: token,
    reportDir: path.resolve('state/reports'), journalDir: path.resolve('state/journal'), wrapperPath: path.resolve('wrapper.node'),
    qqVersion: pins.QQ_VERSION, wrapperSha256: pins.WRAPPER_SHA256, majorSha256: pins.MAJOR_SHA256,
    expectedUin: '123456789', targetUin: '987654321', sourceGroup: '555555555', targetUid: 'u_0123456789012345678901',
    snowlumaHttpUrl: 'http://127.0.0.1:3000', snowlumaToken: 'PRIVATE', request: {}, ...extra.config };
  const server = { requestTimeout: 0, headersTimeout: 0, on() {}, close() { stopped++; },
    listen(port, host, cb) { assert.equal(port, 0); assert.equal(host, '127.0.0.1'); cb(); }, address: () => ({ port: 43210 }) };
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.resolve('fixture'), Buffer,
    process: { pid: 123 }, console: { warn() {} }, AbortSignal, fetch: async (url, options) => {
      const action = url.split('/').at(-1); calls.push(action);
      assert.equal(options.headers.authorization, 'Bearer PRIVATE'); assert.equal(options.redirect, 'error');
      let data = action === 'get_login_info' ? { user_id: 123456789 }
        : action === 'get_friend_list' ? [] : { group_id: 555555555, user_id: 987654321 };
      if (extra.wrongAccount && calls.filter(v => v === 'get_login_info').length === 2) data = { user_id: 111111111 };
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data }) };
    },
    setTimeout(fn) { timer = fn; return { unref() {} }; }, clearTimeout() {},
    require(name) {
      if (name === 'node:fs') return { existsSync: () => true, readFileSync: () => JSON.stringify(config), mkdirSync() {}, writeFileSync(p, text) { writes.push(JSON.parse(text)); } };
      if (name === 'node:http') return { createServer(fn) { handler = fn; return server; } };
      if (name === './friend-binding.cjs') return { startFriendBinding(opts) { binderOpts = opts; return { getBinding: () => ({}), stop() { stopped++; } }; } };
      if (name === './friend-requests.cjs') return { watchBuddyRequests: binding => {
        let closed = false;
        const reader = { ready: () => !closed && binding.ready !== false, stop() { closed = true; stopped++; } };
        readers.push(reader); return reader;
      } };
      if (name === './friend-validation.cjs') return { createFriendValidation(c, deps) { validationDeps = deps; return { async run(action) { actions.push(action); return { status: 'test', requestSent: false }; }, stop() { stopped++; } }; } };
      if (name === './friend-adapter.cjs') return pins;
      return require(name);
    },
  });
  vm.runInContext(source, context);
  async function request(method, url, headers = {}) {
    let code, body;
    await handler({ method, url, headers, resume() {} }, { writeHead(c) { code = c; }, end(v) { body = JSON.parse(v); } });
    return { code, body };
  }
  return { token, writes, actions, request, config, binder: () => binderOpts, deps: () => validationDeps,
    close: () => context.module.exports.stop(), expire: () => timer(), stopped: () => stopped, handler: () => handler, calls, readers };
}
test('unconfigured validation entry is inert in regular Node', () => {
  const r = spawnSync(process.execPath, ['-e', 'require("./plugins/qq-friend-probe/validation-main.cjs").stop()'], { encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
});
test('validation endpoint authenticates every action, rejects payloads and never auto-sends', async () => {
  const f = fixture(); assert.deepEqual(f.actions, []);
  for (const token of [undefined, 'wrong', 'b'.repeat(64)]) assert.equal((await f.request('POST', '/send-once', { 'x-maintenance-token': token })).code, 401);
  const auth = { 'x-maintenance-token': f.token };
  assert.equal((await f.request('GET', '/status', auth)).code, 200);
  for (const [method, url, headers] of [['GET', '/send-once', auth], ['POST', '/other', auth],
    ['POST', '/send-once', { ...auth, 'content-length': '2' }], ['POST', '/send-once', { ...auth, 'transfer-encoding': 'chunked' }]]) {
    assert.equal((await f.request(method, url, headers)).code, 400);
  }
  assert.deepEqual(f.actions, []);
  assert.equal((await f.request('POST', '/preflight', auth)).code, 200);
  assert.equal((await f.request('POST', '/send-once', auth)).code, 200);
  assert.deepEqual(f.actions, ['preflight', 'send-once']);
  const text = JSON.stringify(f.writes); assert.equal(text.includes('PRIVATE'), false); assert.equal(text.includes(f.token), false);
  f.expire(); assert.ok(f.stopped() >= 2); assert.equal((await f.request('POST', '/send-once', auth)).code, 400);
});
test('relationship provider checks account before/after friend list and checks the configured source group', async () => {
  const f = fixture(); const result = await f.deps().readFriendStatus();
  assert.equal(result.friend, false); assert.deepEqual(f.calls, ['get_login_info', 'get_friend_list', 'get_group_member_info', 'get_login_info']);
  const changed = fixture({ wrongAccount: true }); await assert.rejects(changed.deps().readFriendStatus());
  f.close(); changed.close();
});
test('invalid configuration stays inert and binding failure closes the control endpoint', () => {
  for (const config of [{ mode: 'send' }, { enabled: false }, { controlToken: '' }, { snowlumaHttpUrl: 'http://example.com:3000' }, { majorSha256: 'wrong' }]) {
    const f = fixture({ config }); assert.equal(f.handler(), undefined); assert.deepEqual(f.actions, []);
  }
  const f = fixture(); f.binder().onReport({ active: false, phase: 'account-mismatch' });
  assert.ok(f.stopped() >= 2); assert.equal(f.writes.at(-1).active, false);
});

test('later same-session handles do not discard the listener captured at login', async () => {
  const f = fixture();
  f.binder().onBuddyBinding({ ready: true });
  const first = f.deps().getRequestReader(); assert.equal(first, f.readers[0]);
  f.binder().onBuddyBinding({ ready: false });
  assert.equal(f.deps().getRequestReader(), first); assert.equal(first.ready(), true);
  const status = await f.request('GET', '/status', { 'x-maintenance-token': f.token });
  assert.equal(status.body.requestListenerReady, true);
  f.binder().onBuddyBinding(null);
  assert.equal(first.ready(), false); assert.equal(f.deps().getRequestReader(), null);
  f.close();
});
