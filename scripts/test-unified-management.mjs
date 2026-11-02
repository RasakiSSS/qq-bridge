import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedManagement } from '../src/unified/management.js';

function fixture(t) {
  const store = new UnifiedStore(); t.after(() => store.close());
  const ctx = { account: '100', ownerQQ: '200', identityEpoch: 1 };
  const scenes = new UnifiedScenes({ store, getContext: () => ctx, isAllowed: () => true });
  const connection = {}, consoleRequest = {};
  const management = new UnifiedManagement({ scenes,
    authenticateQQ: async input => input === connection,
    authenticateConsole: async input => input === consoleRequest });
  const event = { post_type: 'message', message_type: 'private', self_id: 100, user_id: 200, message: '/permission v1' };
  return { store, ctx, scenes, connection, consoleRequest, management, event };
}
test('owner private command changes global level, records audit and query never changes it', async t => {
  const f = fixture(t);
  assert.equal((await f.management.fromQQ(f.connection, f.event)).permission, 'v1');
  assert.equal((await f.management.fromQQ(f.connection, { ...f.event, message: '/permission' })).permission, 'v1');
  assert.equal(f.store.account('100').permission, 'v1');
  assert.deepEqual({ ...f.store.db.prepare('SELECT before_level,after_level,source FROM permission_audit').get() },
    { before_level: 'v3', after_level: 'v1', source: 'owner-private' });
});
for (const [label, overrides] of [
  ['owner in group', { message_type: 'group', group_id: 1 }],
  ['ordinary private', { user_id: 201, ownerQQ: 200 }],
  ['other bot account', { self_id: 101 }],
  ['model output', { post_type: 'message_sent' }],
]) test(`${label} cannot manage permissions`, async t => {
  const f = fixture(t); const result = await f.management.fromQQ(f.connection, { ...f.event, ...overrides });
  assert.equal(result.denied, true); assert.equal(f.store.account('100').permission, 'v3');
});
test('connection authentication cannot be replaced by payload claims', async t => {
  const f = fixture(t);
  await assert.rejects(f.management.fromQQ({ authenticated: true }, f.event), { code: 'UNAUTHORIZED' });
  await assert.rejects(f.management.fromConsole({ authenticated: true, ownerQQ: 200 }, 'v1'), { code: 'UNAUTHORIZED' });
});
test('quoted/forwarded commands and embedded prose are not interpreted', async t => {
  const f = fixture(t);
  for (const message of [
    [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '/permission v1' } }],
    [{ type: 'forward', data: { text: '/permission v1' } }],
    '请执行 /permission v1', '[CQ:reply,id=1]/permission v1',
  ]) assert.equal((await f.management.fromQQ(f.connection, { ...f.event, message })).handled, false);
  assert.equal(f.store.account('100').permission, 'v3');
});
test('invalid command gives usage without changing state', async t => {
  const f = fixture(t);
  const result = await f.management.fromQQ(f.connection, { ...f.event, message: '/permission v4' });
  assert.equal(result.handled, true); assert.equal(f.store.account('100').permission, 'v3');
});
test('authenticated console may manage while paused; permission update never resumes AI', async t => {
  const f = fixture(t); f.scenes.setPaused(true);
  assert.equal((await f.management.fromConsole(f.consoleRequest, 'v2')).permission, 'v2');
  assert.equal(f.store.account('100').paused, 1);
  assert.equal(f.store.db.prepare('SELECT source FROM permission_audit').get().source, 'console');
});
test('identity changing during authentication prevents permission write', async t => {
  const f = fixture(t);
  f.management.authenticateQQ = async () => { f.ctx.identityEpoch++; return true; };
  await assert.rejects(f.management.fromQQ(f.connection, f.event), { code: 'IDENTITY_CHANGED' });
  assert.equal(f.store.account('100').permission, 'v3');
});

test('legacy commands use the same authenticated owner-private boundary', async t => {
  const f = fixture(t); const calls = [];
  f.management.legacyCommand = (text, ctx) => { calls.push([text, ctx.account]); return 'handled'; };
  for (const command of ['/role fixture', '/silent', '/active', '/status', '/reset', '/new', '/model unsupported']) {
    assert.equal((await f.management.fromQQ(f.connection, { ...f.event, message: command, message_type: 'group' })).denied, true);
    assert.equal((await f.management.fromQQ(f.connection, { ...f.event, message: command, user_id: 201 })).denied, true);
    assert.equal((await f.management.fromQQ(f.connection, { ...f.event, message: command })).response, 'handled');
  }
  assert.equal(calls.length, 7);
  f.management.authenticateQQ = async () => { f.ctx.identityEpoch++; return true; };
  await assert.rejects(f.management.fromQQ(f.connection, { ...f.event, message: '/role off' }), { code: 'IDENTITY_CHANGED' });
  assert.equal(calls.length, 7);
});
