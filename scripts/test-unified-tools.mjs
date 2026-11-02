import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedTools, createUnifiedMcpServer } from '../src/unified/tools.js';

function fixture(t, prepare) {
  const store = new UnifiedStore(); t.after(() => store.close());
  const ctx = { account: '100', ownerQQ: '200', identityEpoch: 1, enabled: true, peakEnabled: false };
  store.account('100');
  store.db.prepare('UPDATE accounts SET session_id=? WHERE account=?').run('main-1', '100');
  const scenes = new UnifiedScenes({ store, getContext: () => ctx, isAllowed: () => true, prepare,
    now: () => Date.parse('2026-10-28T10:00:00+08:00') });
  const tools = new UnifiedTools({ scenes }); const token = tools.issueMainCredential();
  return { store, ctx, scenes, tools, token, call: (name, args) => tools.call(token, name, args) };
}
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }

test('only issued main bearer can access tools; identity claims in arguments cannot authenticate', async t => {
  const f = fixture(t);
  for (const token of ['', null, 'old-scene-token', '0'.repeat(64)]) {
    await assert.rejects(f.tools.call(token, 'qq_get_main_menu', { ownerQQ: '200', sessionId: 'main-1' }), { code: 'UNAUTHORIZED' });
  }
  await assert.rejects(f.call('qq_get_main_menu', { ownerQQ: '200' }), { code: 'INVALID_ARGUMENTS' });
  for (const name of ['setPermission', 'setPaused', 'saveSummary', 'confirm', '__proto__']) {
    await assert.rejects(f.call(name), { code: 'TOOL_DENIED' });
  }
});

test('rotation, runtime epoch, owner and main session replacement revoke old credentials', async t => {
  const f = fixture(t);
  const newer = f.tools.issueMainCredential();
  await assert.rejects(f.call('qq_get_main_menu'), { code: 'UNAUTHORIZED' });
  assert.deepEqual(await f.tools.call(newer, 'qq_get_main_menu'), { sessions: [], hasMore: false });
  for (const mutate of [() => f.ctx.identityEpoch++, () => f.ctx.ownerQQ = '201',
    () => f.store.db.prepare("UPDATE accounts SET session_id='main-2'").run()]) {
    const token = f.tools.issueMainCredential(); mutate();
    await assert.rejects(f.tools.call(token, 'qq_get_main_menu'), { code: 'UNAUTHORIZED' });
  }
});

test('revocation during asynchronous join blocks mutation and queued calls', async t => {
  const gate = deferred(), entered = deferred();
  const f = fixture(t, async () => { entered.resolve(); await gate.promise; });
  const join = f.call('qq_join_session', { key: 'group:1' });
  const menu = f.call('qq_get_main_menu');
  const rejectedJoin = assert.rejects(join, { code: 'UNAUTHORIZED' });
  const rejectedMenu = assert.rejects(menu, { code: 'UNAUTHORIZED' });
  await entered.promise; f.tools.revoke(); gate.resolve();
  await Promise.all([rejectedJoin, rejectedMenu]);
  assert.equal(f.store.account('100').current_scene, null);
});

test('host tool switches are rechecked after a call has waited in the queue', async t => {
  const gate = deferred(), entered = deferred();
  const f = fixture(t, async () => { entered.resolve(); await gate.promise; });
  let enabled = true; f.tools.toolAllowed = flag => flag !== 'getUnread' || enabled;
  const join = f.call('qq_join_session', { key: 'group:1' });
  const queued = f.call('qq_get_unread_msg', { capability: 'invalid' });
  const rejection = assert.rejects(queued, { code: 'TOOL_DENIED' });
  await entered.promise; enabled = false; gate.resolve(); await join; await rejection;
});

test('MCP facade preserves snapshot unread, scene capability and pause rules', async t => {
  const f = fixture(t);
  const append = id => f.store.append({ account: '100', scene: 'group:1', sourceId: id, payload: { text: id }, at: 1 });
  append('a');
  const joined = await f.call('qq_join_session', { key: 'group:1' });
  const page = await f.call('qq_get_unread_msg', { capability: joined.capability });
  append('b');
  assert.equal((await f.call('qq_mark_read', { receipt: page.receipt })).marked, 1);
  assert.equal((await f.call('qq_get_main_menu')).sessions[0].unread, 1);
  await f.call('qq_quit_session');
  await assert.rejects(f.call('qq_get_unread_msg', { capability: joined.capability }), { code: 'STALE_SCENE' });
  f.scenes.setPaused(true);
  await assert.rejects(f.call('qq_get_main_menu'), { code: 'PAUSED' });
});

test('peak entry and hidden menu apply equally through authenticated tools', async t => {
  const f = fixture(t); f.ctx.peakEnabled = true;
  f.store.append({ account: '100', scene: 'group:1', sourceId: 'a', payload: { text: 'hidden' }, at: 1 });
  await assert.rejects(f.call('qq_join_session', { key: 'group:1' }), { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
  assert.equal((await f.call('qq_get_main_menu')).sessions.length, 0);
  assert.equal((await f.call('qq_join_session', { key: 'private:200' })).key, 'private:200');
});

test('real MCP list/call transport exposes only registered tools, keeps credentials out of schemas and errors', async t => {
  const f = fixture(t);
  const server = createUnifiedMcpServer({ dispatch: (name, args) => f.call(name, args) });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(a); await client.connect(b);
  const list = await client.listTools();
  assert.equal(list.tools.length, 34);
  assert.ok(!JSON.stringify(list).includes(f.token));
  assert.ok(!JSON.stringify(list).includes('ownerQQ'));
  const joined = await client.callTool({ name: 'qq_join_session', arguments: { key: 'group:1' } });
  assert.equal(JSON.parse(joined.content[0].text).key, 'group:1');
  f.tools.revoke();
  const denied = await client.callTool({ name: 'qq_get_main_menu', arguments: {} });
  assert.equal(denied.isError, true); assert.equal(denied.content[0].text, 'UNAUTHORIZED');
});

test('MCP errors never echo arbitrary upstream exception messages or codes', async t => {
  const server = createUnifiedMcpServer({ dispatch: () => { throw Object.assign(new Error('secret endpoint'), { code: 'secret token' }); } });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(a); await client.connect(b);
  const result = await client.callTool({ name: 'qq_get_main_menu', arguments: {} });
  assert.equal(result.content[0].text, 'UNIFIED_TOOL_FAILED');
});

test('mark_read completes while another tool is waiting and only acknowledges its receipt', async t => {
  const f = fixture(t), started = deferred(), release = deferred();
  const add = id => f.store.append({ account: '100', scene: 'group:1', sourceId: id, payload: {text:id} });
  add('first');
  const cap = await f.call('qq_join_session', { key:'group:1' });
  const page = await f.call('qq_get_unread_msg', {capability:cap.capability});
  f.tools.attention = { waitMessages: async () => { started.resolve(); await release.promise; }, observeBeforeSleep() {} };
  const waiting = f.call('qq_wait_for_messages', {capability:cap.capability});
  await started.promise;
  try {
    add('later');
    assert.equal((await f.call('qq_mark_read', {receipt:page.receipt})).marked,1);
    assert.equal(f.store.counts('100')[0].unread,1);
  } finally { release.resolve(); await waiting; }
});

test('image lookup scopes source and credential to the current chat', async t => {
  const f = fixture(t);
  const {event} = f.store.append({account:'100',scene:'group:1',sourceId:'photo',payload:{media:[{kind:'image',file:'fixture'}]}});
  const fetch = async item => { assert.equal(item.file,'fixture'); return {buffer:Buffer.from('fixture'),mimeType:'image/png'}; };
  f.tools.fetchImage = fetch;
  const join = key => f.call('qq_join_session',{key});
  const get = cap => f.call('qq_get_message_images',{capability:cap.capability,seq:event.seq});
  const other = await join('group:2');
  await assert.rejects(get(other),{code:'IMAGE_UNAVAILABLE'});
  const here = await join('group:1');
  await assert.rejects(get(other),{code:'STALE_SCENE'});
  assert.equal((await get(here)).data,Buffer.from('fixture').toString('base64'));
  f.tools.fetchImage = async item => { f.tools.revoke(); return fetch(item); };
  await assert.rejects(get(here),{code:'UNAUTHORIZED'});
});

test('decimal string wait durations pass MCP validation and reach the timer as numbers', async t => {
  const f = fixture(t);
  f.tools.attention = { waitMessages: args => args };
  const server = createUnifiedMcpServer({dispatch:(name,args)=>f.call(name,args)});
  const client = new Client({name:'test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close(); await server.close();});
  await server.connect(a); await client.connect(b);
  const call = (quietMs,timeoutMs) => client.callTool({name:'qq_wait_for_messages',arguments:{capability:'fixture',quietMs,timeoutMs}});
  for (const values of [['4000','12000'],[4000,12000]]) {
    const result = await call(...values);
    assert.deepEqual(JSON.parse(result.content[0].text),{capability:'fixture',quietMs:4000,timeoutMs:12000});
  }
  for (const invalid of ['',null,'12s','-2','1.5','99999999']) assert.ok((await call(invalid,12000)).isError);
});

test('recent history, details and active speakers stay scene-bound without acknowledging messages', async t => {
  const f = fixture(t);
  for (const [key,id,sender] of [['group:1','-101','201'],['group:1','-102','202'],['group:2','-103','203']])
    f.store.append({account:'100',scene:key,sourceId:id,payload:{senderQQ:sender,text:id},at:1});
  const {capability} = await f.call('qq_join_session',{key:'group:1'});
  const history = await f.call('qq_get_recent_messages',{capability,limit:1,offset:1});
  assert.equal(history[0].payload.text,'-101');
  assert.equal((await f.call('qq_get_message_detail',{capability,messageId:history[0].seq})).payload.text,'-101');
  assert.equal(await f.call('qq_get_message_detail',{capability,messageId:'-103'}),null);
  assert.deepEqual((await f.call('qq_get_active_members',{capability})).map(m=>m.userId),['202','201']);
  assert.equal(f.store.counts('100')[0].unread,2);
});
