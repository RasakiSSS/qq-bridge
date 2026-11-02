import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../plugins/qq-friend-probe/production-main.cjs', import.meta.url), 'utf8');
function fixture(options = {}) {
  const token = 'a'.repeat(64), calls = [], writes = [], validations = [];
  const config = { enabled: true, mode: 'production', controlToken: token, expectedUin: '123456789',
    reportDir: path.resolve('fixture/reports'), journalDir: path.resolve('fixture/journal'),
    bridgeDir: path.resolve('fixture/bridge'), snowlumaHome: path.resolve('fixture/snowluma') };
  let handler, binderOptions, closed = false, authCount = 0;
  const server = { on() {}, close() { closed = true; }, address: () => ({ port: 12345 }), listen(p, host, cb) { assert.equal(host, '127.0.0.1'); cb(); } };
  const context = vm.createContext({ __dirname: path.resolve('fixture'), module: { exports: {} }, Buffer, process: { pid: 1 }, console, AbortSignal,
    fetch: async (url, init) => {
      const action = url.split('/').at(-1); calls.push(action);
      if (action === 'native-authorize') {
        if (options.unified) {
          assert.ok(url.endsWith('/api/unified/relationships/native-authorize'));
          assert.equal(init.headers['x-unified-native-grant'], 'b'.repeat(64));
          assert.equal(init.headers['x-agent-token'], undefined);
          assert.equal(init.headers['x-console-token'], 'console-secret');
          assert.deepEqual(JSON.parse(init.body), { key: 'unified:123456789', userId: input.userId,
            groupId: input.groupId, answer: input.answer, operationId: input.operationId });
        } else assert.equal(init.headers['x-agent-token'], 'agent-secret');
        authCount++;
        return { ok: true, json: async () => ({ ok: !(options.revoke && authCount > 1) }) };
      }
      assert.equal(init.headers.authorization, 'Bearer onebot-secret');
      const data = action === 'get_login_info' ? { user_id: options.wrongAccount ? 111111111 : 123456789 }
        : action === 'get_friend_list' ? [] : { user_id: 987654321, group_id: 555555555 };
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data }) };
    }, require(name) {
      if (name === 'node:fs') return { existsSync: () => true, mkdirSync() {}, writeFileSync(p, s) { writes.push(s); }, readFileSync(p) {
        return JSON.stringify(p === path.join(config.bridgeDir, 'config.json') ? { consoleToken: 'console-secret' }
          : p.includes('onebot_') ? { networks: { httpServers: [{ port: 3000, accessToken: 'onebot-secret' }] } } : config);
      } };
      if (name === 'node:http') return { createServer(fn) { handler = fn; return server; } };
      if (name === './friend-binding.cjs') return { startFriendBinding(opts) { binderOptions = opts; return { getBinding: () => ({}), stop() {} }; } };
      if (name === './friend-requests.cjs') return { watchBuddyRequests(b, opts) {
        assert.equal(opts.dynamicTargets, true); let live = true;
        return { ready: () => live, stop() { live = false; }, read: async uid => { assert.equal(uid, 'u_0123456789012345678901'); return { pending: false }; } };
      } };
      if (name === './friend-validation.cjs') return { createFriendValidation(c, deps) {
        validations.push(c); return { stop() {}, async run(action) {
          assert.equal(action, 'send-once'); await deps.readFriendStatus(); await deps.getRequestReader().read();
          const allowed = await deps.authorize(); return { status: allowed ? 'native_returned' : 'not_called', nativeInvoked: allowed };
        } };
      } };
      if (name === './friend-adapter.cjs') return require('../plugins/qq-friend-probe/friend-adapter.cjs');
      return require(name);
    } });
  vm.runInContext(source, context);
  async function request(body, secret = token, method = 'POST', url = '/request') {
    let code, result;
    const req = { method, url, headers: { 'x-native-friend-token': secret }, resume() {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    await handler(req, { writeHead(c) { code = c; }, end(s) { result = JSON.parse(s); } }); return { code, result };
  }
  return { request, calls, writes, validations, binder: binderOptions, closed: () => closed, stop: () => context.module.exports.stop() };
}
const input = { userId: '987654321', groupId: '555555555', targetUid: 'u_0123456789012345678901', answer: 'hello', operationId: 'decision-001', key: 'private:123', agentToken: 'agent-secret' };
test('production entry never auto-sends, authenticates fixed endpoint, scopes requests and persists decision journal', async () => {
  const f = fixture(); assert.equal(f.validations.length, 0); assert.equal(f.binder.persistent, true); assert.equal(f.binder.acquireAddService, true);
  assert.equal((await f.request(input, 'wrong')).code, 401);
  assert.equal((await f.request({ ...input, method: 'arbitrary' })).code, 400);
  assert.equal((await f.request(input)).result.nativeInvoked, false);
  f.binder.onBuddyBinding({});
  assert.equal((await f.request(input)).result.nativeInvoked, true);
  assert.equal((await f.request(input)).result.nativeInvoked, true); // Runtime owns reservation; entry must keep identical journal.
  assert.equal(f.validations[0].journalDir, f.validations[1].journalDir);
  assert.equal(f.validations[0].request.sourceId, 5); assert.equal(f.validations[0].request.sourceSubId, 2);
  for (const secret of ['agent-secret', 'console-secret', 'onebot-secret', 'hello']) assert.equal(f.writes.join('').includes(secret), false);
  f.binder.onReport({ active: false, phase: 'account-mismatch' }); assert.equal(f.closed(), true); f.stop();
});
test('production entry rechecks bridge authorization and account before native invocation', async () => {
  const f = fixture({ revoke: true }); f.binder.onBuddyBinding({});
  assert.equal((await f.request(input)).result.nativeInvoked, false); f.stop();
  const g = fixture({ wrongAccount: true }); g.binder.onBuddyBinding({});
  assert.equal((await g.request(input)).code, 500); g.stop();
});

test('production entry uses scoped unified grants and rechecks revocation before sending', async () => {
  for (const revoke of [false, true]) {
    const f = fixture({ unified: true, revoke }); f.binder.onBuddyBinding({});
    assert.equal((await f.request({ ...input, key: 'unified:123456789', agentToken: 'b'.repeat(64) })).result.nativeInvoked, !revoke);
    assert.equal(f.writes.join('').includes('b'.repeat(64)), false);
    f.stop();
  }
});
