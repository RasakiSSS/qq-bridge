import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedActions } from '../src/unified/actions.js';
import { UnifiedTools } from '../src/unified/tools.js';
import { UnifiedRelationships, UnifiedNativeGrants } from '../src/unified/relationships.js';

function fixture(t) {
  const store = new UnifiedStore(); t.after(() => store.close());
  const ctx = { account: '100', ownerQQ: '200', enabled: true };
  store.account('100'); store.db.prepare("UPDATE accounts SET session_id='main'").run();
  const scenes = new UnifiedScenes({ store, getContext: () => ctx, isAllowed: () => true });
  const requests = [], native = []; let hook = async () => {}, allowed = true;
  const relationships = new UnifiedRelationships({ scenes, policy: () => { if (!allowed) throw Object.assign(Error(), { code: 'ACTION_DENIED' }); },
    request: async (action, input) => {
      requests.push({ action, input }); await hook(action);
      return { status: 'ok', retcode: 0, data: action === 'get_login_info' ? { user_id: 100 } : {} };
    }, nativeRequest: async input => { native.push(input); input.assertCurrent(); return { status: 'succeeded' }; } });
  const handlers = Object.fromEntries(['accept_request', 'reject_request', 'delete_friend', 'leave_group', 'request_friend'].map(a => [`relationship:${a}`, relationships.handler(a)]));
  const actions = new UnifiedActions({ store, scenes, handlers });
  const tools = new UnifiedTools({ scenes, actions, relationships }), token = tools.issueMainCredential();
  return { store, ctx, scenes, relationships, tools, requests, native,
    hook: fn => hook = fn, disable: () => allowed = false,
    add: (flag = 'opaque-flag') => relationships.ingest({ self_id: 100, post_type: 'request', request_type: 'friend', user_id: 201, flag, comment: 'hello' }),
    call: (name, args = {}, callId = name) => tools.call(token, name, args, { sessionId: 'main', callId }),
  };
}

test('global relation tools work at menu in v2, refuse v1, and never enter or reset a chat', async t => {
  const f = fixture(t); f.scenes.setPermission('v1');
  await assert.rejects(f.call('qq_delete_friend', { userId: '200' }), { code: 'PERMISSION_DENIED' });
  f.scenes.setPermission('v2');
  assert.equal((await f.call('qq_delete_friend', { userId: '200' })).status, 'succeeded');
  assert.equal((await f.call('qq_leave_group', { groupId: '123' })).status, 'succeeded');
  assert.equal(f.scenes.current(), null); assert.equal(f.store.account('100').session_id, 'main');
  assert.deepEqual(f.requests.filter(r => r.action !== 'get_login_info').map(r => r.action), ['delete_friend', 'set_group_leave']);
});

test('friend requests are account-bound, deduplicated and opaque to model flags', async t => {
  const f = fixture(t), first = f.add(); assert.deepEqual(f.add(), first);
  assert.throws(() => f.relationships.ingest({ self_id: 999 }), { code: 'IDENTITY_CHANGED' });
  const list = await f.call('qq_list_friend_requests'); assert.equal(list.total, 1);
  assert.equal(list.requests[0].id, first.id); assert.ok(!JSON.stringify(list).includes('opaque-flag'));
  const args = { requestId: first.id };
  assert.equal((await f.call('qq_accept_friend_request', args, 'accept')).status, 'succeeded');
  assert.equal((await f.call('qq_accept_friend_request', args, 'accept')).status, 'succeeded');
  assert.equal(f.requests.filter(r => r.action === 'set_friend_add_request').length, 1);
  assert.equal((await f.call('qq_list_friend_requests')).total, 0);
  await assert.rejects(f.call('qq_reject_friend_request', args, 'different'), { code: 'REQUEST_UNAVAILABLE' });
});

test('lost request result reserves unknown before dispatch and cannot be resent under a new call ID', async t => {
  const f = fixture(t), requestId = f.add().id;
  f.hook(action => { if (action === 'set_friend_add_request') throw Error('lost'); });
  assert.equal((await f.call('qq_accept_friend_request', { requestId }, 'lost')).status, 'unknown');
  await assert.rejects(f.call('qq_accept_friend_request', { requestId }, 'new'), { code: 'REQUEST_UNAVAILABLE' });
  assert.equal(f.store.db.prepare('SELECT status FROM friend_requests').get().status, 'unknown');
});

test('permission downgrade, pause and host policy changes during account lookup prevent external writes', async t => {
  for (const mutate of [f => f.scenes.setPermission('v1'), f => f.ctx.paused = true, f => f.disable(), f => f.tools.revoke()]) {
    const f = fixture(t); f.hook(() => mutate(f));
    assert.equal((await f.call('qq_delete_friend', { userId: '200' })).status, 'unknown');
    assert.deepEqual(f.requests.map(r => r.action), ['get_login_info']);
  }
});

test('live gateway account mismatch cannot send an operation', async t => {
  const f = fixture(t); f.relationships.request = async () => ({ status: 'ok', retcode: 0, data: { user_id: 999 } });
  assert.equal((await f.call('qq_delete_friend', { userId: '200' })).status, 'unknown');
  assert.equal(f.requests.length, 0);
});

test('native request operation identity comes from stable host call ID, not model arguments', async t => {
  const f = fixture(t), args = { userId: '201', groupId: '300', answer: 'hello' };
  assert.equal((await f.call('qq_request_friend', args, 'native')).status, 'succeeded');
  await f.call('qq_request_friend', args, 'native'); assert.equal(f.native.length, 1);
  assert.match(f.native[0].input.operationId, /^[a-f0-9]{64}$/);
  await assert.rejects(f.call('qq_request_friend', { ...args, operationId: 'model-id' }), { code: 'INVALID_ARGUMENTS' });
});

test('native grants bind exact operation fields and recheck permissions, expiration and revocation', () => {
  let now = 0, allowed = true;
  const grants = new UnifiedNativeGrants(() => now);
  const input = { key: 'unified:100', userId: '200', groupId: '300', answer: 'hello', operationId: 'operation' };
  const grant = grants.issue(input, () => { if (!allowed) throw Error('revoked'); });
  assert.equal(grants.authorize(input, grant.token), true);
  for (const field of Object.keys(input)) assert.equal(grants.authorize({ ...input, [field]: 'changed' }, grant.token), false);
  allowed = false; assert.equal(grants.authorize(input, grant.token), false); allowed = true;
  now = 120000; assert.equal(grants.authorize(input, grant.token), false);
  const next = grants.issue(input, () => {}); next.revoke(); assert.equal(grants.authorize(input, next.token), false);
});
