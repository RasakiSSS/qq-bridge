import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuddySettingReader } from '../plugins/qq-friend-probe/friend-setting.cjs';
import { QQ_VERSION, WRAPPER_SHA256, MAJOR_SHA256 } from '../plugins/qq-friend-probe/friend-adapter.cjs';
const accountUin = '123456789', targetUin = '987654321';
const config = { enabled: true, mode: 'dry-run', expectedUin: accountUin, allowedTargetUins: [targetUin],
  qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256, majorSha256: MAJOR_SHA256 };
const query = () => ({ targetUin, sourceId: 5, sourceSubId: 2 });
const response = () => ({ result: 0, rsp: { querySetting: 1, isContactFriend: false, errorCode: 0 } });
function fixture(method, options = {}) {
  const receiver = { getBuddySetting: method, addBuddy() { assert.fail('must never send'); } };
  const b = { ...config, accountUin, receiver, isCurrent: () => true };
  const reader = createBuddySettingReader(config, () => b, options);
  return { reader, b, receiver };
}
test('read-only target query preserves exact arguments and receiver; pending stays unknown', async () => {
  const f = fixture(async function (...args) {
    assert.equal(this, f.receiver);
    assert.deepEqual(args, ['GuildGetContactSettingsApplication', { targetInfo: { uin: targetUin }, sourceId: 5, sourceSubId: 2 }, new Uint8Array()]);
    return { ...response(), private: 'PRIVATE', context: 'PRIVATE' };
  });
  const value = await f.reader.read(query());
  assert.deepEqual(value, { status: 'read', requestSent: false, accountUin, targetUin, addFriendSetting: 1, isContactFriend: false, friend: null, pending: null });
});
test('bad target/source/extra fields/accessors and missing binding never call the service', async () => {
  const f = fixture(() => assert.fail('invalid query called'));
  const accessor = query(); Object.defineProperty(accessor, 'targetUin', { get() { assert.fail('query getter'); } });
  for (const value of [null, {}, { ...query(), targetUin: accountUin }, { ...query(), sourceId: 1 },
    { ...query(), sourceSubId: 1 }, { ...query(), method: 'addBuddy' }, accessor, new Proxy(query(), {})]) {
    assert.equal((await f.reader.read(value)).status, 'unknown');
  }
  f.b.accountUin = targetUin;
  assert.equal((await f.reader.read(query())).code, 'ERR_BINDING_UNAVAILABLE');
});
test('missing or malformed response fields never become known settings or friendship', async () => {
  const accessor = { result: 0 }; Object.defineProperty(accessor, 'rsp', { get() { assert.fail('reply getter'); } });
  for (const value of [null, {}, accessor, new Proxy(response(), {}), { result: 7, rsp: response().rsp },
    { result: 0, rsp: { querySetting: 1 } }, { result: 0, rsp: { querySetting: '1', isContactFriend: false } },
    { result: 0, rsp: { ...response().rsp, errorCode: 6 } }]) {
    const f = fixture(async () => value);
    assert.equal((await f.reader.read(query())).code, 'ERR_SETTING_REPLY');
  }
});
test('binding changes in flight invalidate a response and getters are never invoked', async () => {
  let resolve;
  const f = fixture(() => new Promise(r => { resolve = r; }));
  const pending = f.reader.read(query()); f.b.isCurrent = () => false;
  // Original captured current function is also revoked by the loader; emulate it.
  f.receiver.getBuddySetting = () => assert.fail('replacement');
  resolve(response());
  assert.equal((await pending).code, 'ERR_BINDING_LOST');
  const g = fixture(async () => response());
  Object.defineProperty(g.receiver, 'getBuddySetting', { get() { assert.fail('method getter'); } });
  assert.equal((await g.reader.read(query())).code, 'ERR_BINDING_UNAVAILABLE');
});
test('timeout and stop settle callers, block concurrent calls, and consume late rejection', async () => {
  for (const stop of [false, true]) {
    let reject;
    const f = fixture(() => new Promise((resolve, no) => { reject = no; }), { timeoutMs: 20 });
    const pending = f.reader.read(query());
    assert.equal((await f.reader.read(query())).code, 'ERR_BUSY');
    if (stop) f.reader.stop();
    assert.equal((await pending).code, stop ? 'ERR_READER_STOPPED' : 'ERR_TIMEOUT');
    reject(new Error('PRIVATE'));
    await new Promise(r => setImmediate(r));
  }
});

test('reentrant stop in the last current check prevents a query; async binding rejection is consumed', async () => {
  const f = fixture(() => assert.fail('query after stop'));
  let calls = 0;
  f.b.isCurrent = () => { if (++calls === 2) f.reader.stop(); return true; };
  assert.equal((await f.reader.read(query())).code, 'ERR_READER_STOPPED');
  const reader = createBuddySettingReader(config, () => Promise.reject(new Error('PRIVATE')));
  assert.equal((await reader.read(query())).code, 'ERR_BINDING_UNAVAILABLE');
  await new Promise(r => setImmediate(r));
});
