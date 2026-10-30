import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { startUnifiedHost } from '../src/unified/host.js';
import { createUnifiedBridgeDriver, assertLegacySessionsIdle } from '../src/unified/bridge-driver.js';
import { invokeMainTool } from '../plugins/qq-agent-presets/qq-unified-client.mjs';

const ok = value => ({ result: { ok: true, value } });
async function fixture(t, options = {}, globals = {}) {
  let sid;
  const sessionPresets = new Map();
  const h = await bridgeHarness({ config: { socialV2: { unified: { enabled: true, workspaceId: 'fixture-workspace' }, sharedMemory: { enabled: false }, ...options } },
    files: { 'dsh/agent-presets/qq-chat-v2-files/agent.cordis.yml': '[]' },
    globals: { startUnifiedHost: input => startUnifiedHost({ ...input,
      bindingOptions: { verify: () => true, harden: () => ({ ok: true }) },
      runtimeOptions: { ...input.runtimeOptions, readWorkspaces: async () => ({ items: [{ workspaceId: 'fixture-workspace', sessionIds: [...sessionPresets.keys()] }], archivedSessionIds: [] }) },
    }), ...globals },
  });
  t.after(() => h.close());
  h.setPresets(['qq-unified']); h.setMode('reserved2'); h.setSelfIdentity('fixture', '100'); h.setConnected(true);
  h.api.sessions.list = async () => ok({ items: [...sessionPresets.keys()].map(sessionId => ({ sessionId, formatStatus: 'current', running: false })) });
  const create = h.api.sessions.create;
  h.api.sessions.create = async input => {
    const result = await create(input), created = result.result.value.sessionId;
    sessionPresets.set(created, input.agentPreset);
    if (input.agentPreset === 'qq-unified') sid = created;
    return result;
  };
  h.api.sessions.prompt = async input => { h.calls.prompts.push(input); return ok({ accepted: true }); };
  h.api.callUnary = async (_method, input) => ok(sessionPresets.has(input.sessionId) ? { kind: 'sequenced', asOfSeq: 0, values: { agentPreset: sessionPresets.get(input.sessionId), inbox: { 'next-step': [], 'next-turn': [] } } } : null);
  const file = path.join(h.temp, 'state/unified-mcp.json');
  return Object.assign(h, {
    receive: (key = 'private:123', id = 1, message = 'hello') => {
      const [kind, peer] = key.split(':');
      return h.handleIncoming(kind, peer, { post_type: 'message', message_type: kind, self_id: 100,
        user_id: kind === 'private' ? Number(peer) : 999, group_id: kind === 'group' ? Number(peer) : undefined,
        message_id: id, time: 1000, message: [{ type: 'text', data: { text: message } }] }, h.cfg);
    },
    call: (name, args = {}, callId = 'call-1') => invokeMainTool(name, args,
      { agent: { session: { id: sid } }, callId, signal: new AbortController().signal }, async sessionId => {
        const value = JSON.parse(fs.readFileSync(file)); assert.equal(value.sessionId, sessionId); return value;
      }),
  });
}

test('real bridge inbox, main session and shared QQ send queue operate together without real peers', async t => {
  const h = await fixture(t);
  await h.receive(); await h.receive(); // Duplicate gateway delivery.
  assert.equal((await h.unifiedDriver.tick()).status, 'accepted');
  assert.equal(h.calls.created.length, 1);
  const menu = JSON.parse((await h.call('qq_get_main_menu')).text);
  assert.equal(menu.sessions[0].unread, 1);
  const current = JSON.parse((await h.call('qq_join_session', { key: 'private:123' })).text);
  const args = { capability: current.capability, messages: ['reply'] };
  assert.equal(JSON.parse((await h.call('qq_send_message', args)).text).status, 'succeeded');
  await h.call('qq_send_message', args);
  assert.equal(h.calls.http.filter(row => row.url.endsWith('/send_private_msg')).length, 1);
  assert.equal(JSON.parse((await h.call('qq_get_main_menu')).text).sessions[0].unread, 1);
});

test('real bridge captures account-bound requests and global relationship actions work from menu', async t => {
  const h = await fixture(t, { relationships: { enabled: true }, tools: { relationships: true } });
  const calls = [];
  h.bot.request = async (action, params) => {
    calls.push({ action, params });
    return { status: 'ok', retcode: 0, data: action === 'get_login_info' ? { user_id: 100 } : {} };
  };
  await h.receive(); await h.unifiedDriver.tick();
  const event = { self_id: 100, post_type: 'request', request_type: 'friend', user_id: 201, flag: 'fixture-flag', comment: 'hello' };
  await h.bot.emitRequest('friend', event);
  await h.bot.emitRequest('friend', event);
  await h.bot.emitRequest('friend', { ...event, self_id: 999, flag: 'other-account' });
  const list = JSON.parse((await h.call('qq_list_friend_requests')).text);
  assert.equal(list.total, 1);
  assert.equal(JSON.stringify(list).includes('fixture-flag'), false);
  const args = { requestId: list.requests[0].id };
  assert.equal(JSON.parse((await h.call('qq_accept_friend_request', args, 'accept-1')).text).status, 'succeeded');
  await h.call('qq_accept_friend_request', args, 'accept-1');
  assert.equal(calls.filter(x => x.action === 'set_friend_add_request').length, 1);
  assert.equal(JSON.parse((await h.call('qq_get_current_session')).text), null);
  assert.equal(JSON.stringify(h.cfg.allow).includes('201'), false);
  await h.receive('private:123', 2, '/permission v1');
  assert.equal((await h.call('qq_delete_friend', { userId: '201' }, 'delete-1')).error, true);
  assert.equal(calls.some(x => x.action === 'delete_friend'), false);
});

test('bridge native callback authorizes only the active scoped grant and never the main token', async t => {
  let endpoint, captured, calls = 0, callbackError;
  const authorize = async (input, token) => {
    const response = await fetch(`${endpoint}/api/unified/relationships/native-authorize`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-unified-native-grant': token },
      body: JSON.stringify(input) });
    return response.status;
  };
  const h = await fixture(t, { relationships: { enabled: true, actions: { nativeFriendRequest: true } }, tools: { relationships: true } }, {
    nativeFriendRequest: async options => {
      try {
      calls++; options.assertAllowed();
      assert.equal(options.expectedAccount, '100');
      captured = { input: { ...options.input, key: options.key }, token: options.agentToken };
      assert.equal(await authorize(captured.input, captured.token), 200);
      assert.equal(await authorize({ ...captured.input, userId: '999' }, captured.token), 403);
      assert.equal(await authorize(null, captured.token), 400);
      h.cfg.socialV2.relationships.actions.nativeFriendRequest = false;
      assert.equal(await authorize(captured.input, captured.token), 403);
      h.cfg.socialV2.relationships.actions.nativeFriendRequest = true;
      return { status: 'succeeded' };
      } catch (error) { callbackError = error; throw error; }
    },
  });
  const server = h.startConsoleServer(h.cfg);
  h.bot.request = async () => ({ status: 'ok', retcode: 0, data: { user_id: 100 } });
  if (!server.listening) await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  await h.receive(); await h.unifiedDriver.tick();
  const result = JSON.parse((await h.call('qq_request_friend', { userId: '201', groupId: '456', answer: 'hello' }, 'native-1')).text);
  if (callbackError) throw callbackError;
  assert.equal(result.status, 'succeeded'); assert.equal(calls, 1);
  assert.equal(await authorize(captured.input, captured.token), 403);
  const main = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/unified-mcp.json')));
  assert.notEqual(main.token, captured.token);
  assert.equal(await authorize(captured.input, main.token), 403);
});

test('real bridge exposes workspace tools only through global v3 and honors silent mode', async t => {
  const h = await fixture(t, {}, { workspaceServer: () => ({ command: 'fixture-node', script: 'fixture-server', roots: [h.temp] }) });
  await h.receive(); await h.unifiedDriver.tick();
  const args = { operation: 'list_allowed_directories' };
  assert.equal(JSON.parse((await h.call('qq_workspace_file', args, 'roots-1')).text).status, 'succeeded');
  await h.receive('private:123', 2, '/permission v2');
  assert.equal((await h.call('qq_workspace_file', args, 'roots-2')).error, true);
  await h.receive('private:123', 3, '/permission v3');
  // The role state is a trusted host file, never supplied by a tool caller.
  const roleFile = path.join(h.temp, 'state', 'current-role.json');
  fs.writeFileSync(roleFile, JSON.stringify({ mode: 'silent' }));
  assert.equal((await h.call('qq_workspace_file', args, 'roots-3')).error, true);
});

test('unified bridge recall and remember reuse incoming evidence without a worker session', async t => {
  const h = await fixture(t, { sharedMemory: { enabled: true }, tools: { memory: true } });
  await h.receive('private:123', 1, '周末看电影'); await h.unifiedDriver.tick();
  const recalled = JSON.parse((await h.call('qq_recall', { query: '电影' })).text);
  assert.equal(recalled.events.length, 1);
  const note = { kind: 'openLoop', text: '周末电影', evidenceIds: [recalled.events[0].id] };
  const saved = JSON.parse((await h.call('qq_remember', { note }, 'remember-1')).text);
  assert.equal(saved.status, 'succeeded');
  assert.equal(JSON.parse((await h.call('qq_recall')).text).notes.length, 1);
  assert.equal(h.calls.created.length, 1);
  assert.equal(JSON.parse((await h.call('qq_get_main_menu')).text).sessions[0].unread, 1);
  h.cfg.socialV2.sharedMemory.enabled = false;
  assert.equal((await h.call('qq_recall')).error, true);
});

test('bridge summary worker uses shared workspace, keeps main identity and exposes only delivered coverage', async t => {
  const h = await fixture(t); h.setPresets(['qq-unified', 'qq-summary']);
  await h.receive('private:123', 1, '待总结'); await h.unifiedDriver.tick();
  const started = JSON.parse((await h.call('qq_summarize_unread', { key: 'private:123' }, 'summary-call')).text);
  assert.equal(started.status, 'queued'); await h.unifiedDriver.tick();
  const request = h.calls.prompts.find(x => x.requestId === started.jobId);
  assert.ok(request); assert.notEqual(request.sessionId, h.calls.created[0].sessionId);
  assert.equal(h.calls.created.length, 2);
  assert.equal(h.calls.created[1].workspaceId, h.calls.created[0].workspaceId);
  assert.equal(h.calls.created[1].agentPreset, 'qq-summary');
  const db = new DatabaseSync(path.join(h.temp, 'state/unified.sqlite'), { readOnly: true });
  let row;
  try { row = db.prepare('SELECT * FROM summary_jobs WHERE id=?').get(started.jobId); } finally { db.close(); }
  const coveredSeqs = JSON.parse(row.input).messages.map(x => x.seq);
  const records = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user', rpcId: started.jobId } } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify({ summary: '用户有待总结的消息', coveredSeqs }) }] } } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  for (const event of records) await h.unifiedDriver.onDshFrame({ type: 'session/event', sessionId: request.sessionId, event });
  const result = JSON.parse((await h.call('qq_get_summary', { jobId: started.jobId })).text);
  assert.equal(result.status, 'ready');
  assert.equal(JSON.parse((await h.call('qq_mark_read', { receipt: result.receipt })).text).marked, 1);
  assert.equal(JSON.parse((await h.call('qq_get_current_session')).text), null);
});

test('pause/offline retain input and do not create or prompt a model', async t => {
  const h = await fixture(t); h.socialV2.paused = true;
  await h.receive(); assert.equal((await h.unifiedDriver.tick()).status, 'paused');
  assert.equal(h.calls.created.length, 0);
  h.socialV2.paused = false; h.setReady(false);
  await h.receive('private:123', 2); await h.unifiedDriver.tick(); assert.equal(h.calls.created.length, 0);
  h.setReady(true); await h.unifiedDriver.tick();
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(JSON.parse((await h.call('qq_get_main_menu')).text).sessions[0].unread, 2);
});

test('old wake/session/model paths stay fenced and old state mappings survive', async t => {
  const h = await fixture(t); h.state.sessions['group:456'] = 'old-sid';
  await h.scheduleWakeV2('group:456', 'bootstrap'); await h.sendWakePromptV2('group:456', 'bootstrap');
  await assert.rejects(h.ensureSession('group:456'), /统一模式/);
  assert.throws(h.assertMemoryModelAllowed, /统一模式/);
  assert.throws(() => h.assertQzoneAllowed(null, 'model'), /统一模式/);
  assert.equal(h.calls.prompts.length, 0); assert.equal(h.calls.created.length, 0);
  assert.equal(h.state.sessions['group:456'], 'old-sid'); assert.equal(h.calls.archived.length, 0);
});

test('owner private permission command works during pause; group claim does not modify permissions', async t => {
  const h = await fixture(t); h.socialV2.paused = true;
  await h.receive('private:123', 1, '/permission v1');
  assert.ok(h.calls.sent.some(row => JSON.stringify(row).includes('v1')));
  h.socialV2.paused = false;
  await h.receive('private:123', 2, 'hello'); await h.unifiedDriver.tick();
  const before = h.calls.prompts.length;
  await h.receive('group:456', 3, '/permission v3');
  assert.ok(h.calls.sent.some(row => JSON.stringify(row).includes('只有管理员私聊')));
  await h.receive('private:123', 4, '/permission');
  assert.ok(JSON.stringify(h.calls.sent.at(-1)).includes('v1'));
  assert.equal(h.calls.prompts.length, before);
});

test('revoking whitelist or silent mode blocks a queued unified send through real bridge policy', async t => {
  const h = await fixture(t); await h.receive(); await h.unifiedDriver.tick();
  const current = JSON.parse((await h.call('qq_join_session', { key: 'private:123' })).text);
  h.cfg.deny.private = ['123'];
  const result = await h.call('qq_send_message', { capability: current.capability, messages: ['not sent'] });
  assert.equal(result.error, true);
  assert.equal(h.calls.http.filter(row => row.url.endsWith('/send_private_msg')).length, 0);
});

test('legacy preflight refuses busy, queued or unverifiable work without cancelling it', async () => {
  const api = { sessions: { list: async () => ok({ items: [{ sessionId: 'old', running: true }] }) }, callUnary: async () => ok(null) };
  await assert.rejects(assertLegacySessionsIdle(api, ['old']), { code: 'LEGACY_SESSION_BUSY' });
  api.sessions.list = async () => ok({ items: [{ sessionId: 'old', running: false }] });
  await assert.rejects(assertLegacySessionsIdle(api, ['old']), { code: 'LEGACY_PREFLIGHT_UNAVAILABLE' });
  api.callUnary = async () => ok({ kind: 'sequenced', values: { inbox: { 'next-step': [], 'next-turn': [{}] } } });
  await assert.rejects(assertLegacySessionsIdle(api, ['old']), { code: 'LEGACY_SESSION_BUSY' });
  api.callUnary = async () => ok({ kind: 'sequenced', values: { inbox: { 'next-step': [], 'next-turn': [] } } });
  await assertLegacySessionsIdle(api, ['old']);
});

test('driver coalesces ticks and closes a host that was still opening', async () => {
  let release, opens = 0, closed = 0;
  const gate = new Promise(resolve => release = resolve);
  const driver = createUnifiedBridgeDriver({ ready: () => true, createHost: async () => { opens++; await gate; return { restore() { throw new Error('should not restore after close'); }, close() { closed++; } }; } });
  const a = driver.tick(), b = driver.tick();
  assert.equal(a, b); await Promise.resolve();
  const close = driver.close(); release(); await Promise.all([a, close]);
  assert.equal(opens, 1); assert.equal(closed, 1);
});

test('real console authentication gates permission API, rejects old MCP and protects legacy resets', async t => {
  const h = await fixture(t), server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    const request = (url, headers = {}, body = {}) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers } }, response => {
        let text = ''; response.on('data', chunk => text += chunk); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      }); req.on('error', reject); req.end(JSON.stringify(body));
    });
    assert.equal((await request('/api/unified/permission', { 'x-console-token': '' }, { permission: 'v1' })).status, 401);
    assert.equal((await request('/api/unified/permission', { 'x-agent-call': '1' }, { permission: 'v1' })).status, 403);
    assert.equal((await request('/api/unified/permission', {}, { permission: 'v1' })).body.permission, 'v1');
    for (const url of ['/api/session/reset', '/api/workspace/reset', '/api/socialV2/reset']) assert.equal((await request(url)).status, 409);
    assert.equal(h.calls.archived.length, 0); assert.equal(h.calls.cancelled.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('unified MCP wake preferences feed actual bridge trigger evaluation without mutating legacy preferences', async t => {
  const h = await fixture(t); await h.receive(); await h.unifiedDriver.tick();
  const current = JSON.parse((await h.call('qq_join_session', { key: 'group:456' })).text);
  const config = { mode: 'diving', infinite: true, triggers: { anyMessage: false, probability: 0,
    atMention: false, nameMention: false, question: false, keywords: ['unified-trigger'], speakerIds: [] } };
  const changed = JSON.parse((await h.call('qq_set_wake_config', { capability: current.capability, config }, 'configure')).text);
  assert.equal(changed.status, 'succeeded');
  await h.receive('group:456', 2, 'ordinary conversation');
  await h.receive('group:456', 3, 'unified-trigger');
  const db = new DatabaseSync(path.join(h.temp, 'state/unified.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare("SELECT payload,wake,unread FROM events WHERE scene='group:456' ORDER BY seq").all();
    assert.deepEqual(rows.map(row => [row.wake, row.unread]), [[0, 1], [1, 1]]);
    assert.equal(JSON.parse(rows[1].payload).reason, 'keyword:unified-trigger');
  } finally { db.close(); }
  const read = JSON.parse((await h.call('qq_wait_for_messages', { capability: current.capability, quietMs: 0 })).text);
  assert.equal(read.page.messages.length, 2);
  assert.equal(read.page.remaining, 0);
  // Updating unified preferences does not overwrite the old fallback state.
  assert.ok(!JSON.stringify(h.getSocialV2State('group:456').wakeConfig).includes('unified-trigger'));
});

test('unified Qzone collection enters durable main inbox without standalone session or empty-poll prompts', async t => {
  const h = await fixture(t, { qzone: { enabled: true } });
  let mentioned = false;
  h.bot.request = async action => {
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 100 } };
    if (action === 'get_qzone_feeds') return { status: 'ok', retcode: 0, data: { feeds: [
      { uin: 999, key: 'post', appid: 311, html: mentioned ? '@{uin:100,nick:bot}' : 'ordinary post', time: Math.floor(Date.now() / 1000) },
    ] } };
    if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { msglist: [] } };
    if (action === 'get_qzone_msg_detail') return { status: 'ok', retcode: 0, data: { tid: 'post', comments: [], comment_num: 0 } };
    assert.fail('unexpected QQ write or request ' + action);
  };
  assert.equal(h.qzoneAgent, null);
  h.setReady(false); // Collection is independent of DSH availability.
  assert.equal((await h.pollUnifiedQzone()).status, 'collected');
  h.setReady(true); assert.equal((await h.unifiedDriver.tick()).status, 'idle');
  assert.equal(h.calls.created.length, 0);
  // Ordinary feeds are available when the main session is woken elsewhere.
  await h.receive(); await h.unifiedDriver.tick();
  const cap = JSON.parse((await h.call('qq_join_session', { key: 'qzone' })).text);
  const page = JSON.parse((await h.call('qq_get_unread_msg', { capability: cap.capability })).text);
  assert.equal(page.messages[0].payload.text, 'ordinary post');
  assert.equal(h.calls.created.length, 1);
  await assert.rejects(Promise.resolve().then(() => h.assertQzoneAllowed(null, 'model')), /统一模式/);
});

test('main Qzone actions preserve friends visibility, limit, mentions, exact call dedupe and scene isolation', async t => {
  const h = await fixture(t, { qzone: { enabled: true, dailyPostLimit: 1, minPostIntervalMs: 0, visibility: 'friends' } });
  const writes = []; let login = 100;
  h.bot.request = async (action, params) => {
    let data;
    if (action === 'get_login_info') data = { user_id: login };
    else if (action === 'get_qzone_feeds') data = { feeds: [{ uin: 999, key: 'post', appid: 311, nickname: 'friend', html: 'post', time: Date.now() / 1000 }] };
    else if (action === 'get_qzone_msg_list') data = { msglist: [{ tid: 'own', content: 'own', time: Date.now() / 1000, comment_num: 1 }] };
    else if (action === 'get_qzone_msg_detail') data = { tid: params.tid, comment_num: 1, comments: [{ comment_id: 'c1', uin: 999, name: 'friend', content: 'hello', time: Date.now() / 1000 }] };
    else if (action === 'send_qzone_msg') { writes.push({ action, params }); data = { tid: 'new' }; }
    else if (action === 'comment_qzone') { writes.push({ action, params }); data = { comment_id: 'sent' }; }
    else assert.fail(action);
    return { status: 'ok', retcode: 0, data };
  };
  await h.pollUnifiedQzone(); await h.unifiedDriver.tick();
  const chat = JSON.parse((await h.call('qq_join_session', { key: 'group:456' })).text);
  assert.equal((await h.call('qq_qzone_publish', { capability: chat.capability, content: 'wrong scene' }, 'wrong')).error, true);
  const cap = JSON.parse((await h.call('qq_join_session', { key: 'qzone' })).text);
  const publish = { capability: cap.capability, content: 'hello', mentions: ['999'] };
  const sent = JSON.parse((await h.call('qq_qzone_publish', publish, 'post')).text);
  assert.equal(sent.status, 'succeeded');
  assert.deepEqual(JSON.parse((await h.call('qq_qzone_publish', publish, 'post')).text), sent);
  assert.equal(writes[0].params.ugc_right, 4); assert.match(writes[0].params.content, /uin:999/);
  assert.equal(JSON.parse((await h.call('qq_qzone_publish', { ...publish, content: 'second' }, 'second')).text).status, 'rejected');
  const page = JSON.parse((await h.call('qq_get_unread_msg', { capability: cap.capability })).text);
  const comment = page.messages.find(row => row.payload.commentId === 'c1' && row.payload.ownerQQ === '100');
  assert.equal(JSON.parse((await h.call('qq_qzone_reply', { capability: cap.capability, content: 'thanks', commentKey: comment.payload.key }, 'reply')).text).status, 'succeeded');
  assert.equal(JSON.parse((await h.call('qq_qzone_comment', { capability: cap.capability, content: 'nice', postKey: 'post:999:post' }, 'comment')).text).status, 'succeeded');
  assert.equal(writes.length, 3);
  login = 101;
  assert.equal(JSON.parse((await h.call('qq_qzone_publish', { ...publish, content: 'changed account' }, 'account')).text).status, 'rejected');
  assert.equal(writes.length, 3);
});

test('on-demand Qzone refresh shares inbox dedupe, keeps reads explicit and requires a live Qzone scene', async t => {
  const h = await fixture(t, { qzone: { enabled: true } });
  let reads = 0;
  h.bot.request = async action => {
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 100 } };
    if (action === 'get_qzone_feeds') { reads++; return { status: 'ok', retcode: 0, data: { feeds: [{ uin: 999, key: 'post', appid: 311, html: 'hello', time: Date.now() / 1000 }] } }; }
    if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { msglist: [] } };
    if (action === 'get_qzone_msg_detail') return { status: 'ok', retcode: 0, data: { tid: 'post', comments: [], comment_num: 0 } };
    assert.fail('No writes allowed: ' + action);
  };
  await h.receive(); await h.unifiedDriver.tick();
  const cap = JSON.parse((await h.call('qq_join_session', { key: 'qzone' })).text);
  const args = { capability: cap.capability };
  const status = JSON.parse((await h.call('qq_qzone_status', args, 'status')).text);
  assert.equal(status.status, 'succeeded'); assert.equal(reads, 0);
  assert.equal(status.result.pendingFeeds, undefined); assert.equal(status.result.lastError, undefined);
  await h.call('qq_qzone_refresh', args, 'refresh'); assert.equal(reads, 1);
  await h.call('qq_qzone_refresh', args, 'refresh'); assert.equal(reads, 1);
  const page = JSON.parse((await h.call('qq_get_unread_msg', args)).text);
  assert.equal(page.messages.length, 1);
  await h.call('qq_mark_read', { receipt: page.receipt });
  await h.call('qq_qzone_refresh', args, 'refresh-again'); assert.equal(reads, 2);
  assert.equal(JSON.parse((await h.call('qq_get_unread_msg', args)).text).messages.length, 0);
  await h.call('qq_quit_session');
  assert.equal((await h.call('qq_qzone_refresh', args, 'stale')).error, true);
  assert.equal(reads, 2); assert.equal(h.calls.created.length, 1);
});

test('Qzone uncertain network write remains unknown and is never retried under same tool call', async t => {
  const h = await fixture(t, { qzone: { enabled: true } }); await h.receive(); await h.unifiedDriver.tick();
  let writes = 0;
  h.bot.request = async action => {
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 100 } };
    if (action === 'send_qzone_msg') { writes++; throw Error('network lost'); }
    assert.fail(action);
  };
  const cap = JSON.parse((await h.call('qq_join_session', { key: 'qzone' })).text);
  const args = { capability: cap.capability, content: 'one attempt' };
  assert.equal(JSON.parse((await h.call('qq_qzone_publish', args, 'lost')).text).status, 'unknown');
  assert.equal(JSON.parse((await h.call('qq_qzone_publish', args, 'lost')).text).status, 'unknown');
  assert.equal(writes, 1);
});

test('bridge role commands and paginated persona use live trusted role files', async t => {
  const h = await fixture(t);
  const role = '## fixture\n' + '性格资料。'.repeat(1800) + '\n## old〔一代〕\nOLD_ONLY\n## new〔二代〕\nNEW_ONLY';
  fs.mkdirSync(path.join(h.temp, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(h.temp, 'roles/fixture.md'), role);
  await h.receive('private:123', 1, '/role fixture');
  await h.receive('private:123', 2, 'hello');
  await h.unifiedDriver.tick();
  const envelope = JSON.parse(h.calls.prompts[0].content[0].text);
  assert.equal(envelope.persona.name, 'fixture');
  let result = JSON.parse((await h.call('qq_get_prompt')).text), text = result.text;
  assert.equal(result.revision, envelope.persona.revision);
  while (result.nextOffset !== null) {
    result = JSON.parse((await h.call('qq_get_prompt', { offset: result.nextOffset, revision: result.revision })).text);
    text += result.text;
  }
  assert.ok(text.length > 8000);
  assert.ok(text.includes('NEW_ONLY')); assert.ok(!text.includes('OLD_ONLY'));
  await h.receive('private:123', 3, '/role off');
  assert.equal(JSON.parse((await h.call('qq_get_prompt')).text).text, '');
  await h.receive('private:123', 4, '/reset');
  assert.equal(h.calls.created.length, 1);
  assert.equal(JSON.parse((await h.call('qq_get_main_menu')).text).sessions[0].unread, 1);
});

test('status does not lazily open host and console snapshot does not expose main bearer', async t => {
  let opened = 0;
  const driver = createUnifiedBridgeDriver({ createHost: () => { opened++; }, ready: () => false });
  assert.deepEqual(await driver.status(), { ready: false }); assert.equal(opened, 0); await driver.close();
  const h = await fixture(t); await h.receive(); await h.unifiedDriver.tick();
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/status`, { headers: { 'x-console-token': 'fixture-console-token' } });
    const status = await response.json();
    assert.equal(status.unified.enabled, true); assert.equal(status.unified.counts.unread, 1);
    assert.equal(status.unified.dispatch, 'accepted');
    const credential = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/unified-mcp.json')));
    assert.ok(!JSON.stringify(status.unified).includes(credential.token));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('legacy active command never clears manual pause and control messages stay out of model inbox', async t => {
  const h = await fixture(t); h.socialV2.paused = true;
  for (const [i, command] of ['/silent', '/active', '/new', '/model arbitrary'].entries()) await h.receive('private:123', i + 1, command);
  assert.equal(h.socialV2.paused, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/current-role.json'))).mode, 'active');
  assert.equal((await h.unifiedDriver.status()).counts.total, 0);
  assert.equal(h.calls.created.length, 0); assert.equal(h.calls.prompts.length, 0);
});
