// 完全离线：所有空间内容、发送回执、模型输出和时间均为夹具。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { createQzoneService, qzoneConfig, qzoneMentions, parseQzoneDecision } from '../src/qzone.js';
import { createQzoneAgent } from '../src/qzone-agent.js';
import * as roleCard from '../src/role-card.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createSharedMemory } from '../src/shared-memory.js';
import { recordQzoneMemory } from '../src/shared-memory-qzone.js';

function fixture(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-qzone-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-23T00:00:00Z');
  let blocked = false, login = '1', model = () => ({ post: null, comments: [], replies: [] });
  const cfg = { enabled: true, ...config };
  const calls = [], decisions = [], logs = [];
  const own = [{ tid: 'own', content: '我的说说', time: clock / 1000, comment_num: 0 }];
  const feeds = [{ uin: 2, nickname: '好友', time: clock / 1000, appid: 311, key: 'friend', html: '<b>好天气</b>' }];
  const comments = new Map([['own', []], ['friend', []]]);
  let override = null;
  const request = async (action, params) => {
    calls.push({ action, params });
    if (override) { const value = await override(action, params); if (value !== undefined) return value; }
    let data;
    if (action === 'get_login_info') data = { user_id: login };
    else if (action === 'get_qzone_feeds') data = { feeds, has_more: false };
    else if (action === 'get_qzone_msg_list') data = { msglist: String(params.target_uin) === login ? own : [{ tid: 'friend', content: '好天气', time: clock / 1000, comment_num: 0 }], total: 1 };
    else if (action === 'get_qzone_msg_detail') { const list = comments.get(params.tid) || []; data = { tid: params.tid, content: '正文', comment_num: list.length, comments: list.slice(params.pos, params.pos + params.num) }; }
    else if (action === 'send_qzone_msg') { data = { tid: 'published-' + calls.length }; own.unshift({ tid: data.tid, content: params.content, time: clock / 1000, comment_num: 0 }); }
    else if (action === 'comment_qzone') data = { comment_id: 'comment-' + calls.length };
    else assert.fail('unexpected action ' + action);
    return { status: 'ok', retcode: 0, data };
  };
  const opts = { file: path.join(dir, 'qzone.json'), getConfig: () => cfg, request,
    now: () => clock, log: (s) => logs.push(s), audit: (text) => { if (text.includes('secret')) throw Error('audit blocked'); },
    assertAllowed: () => { if (blocked) throw Object.assign(Error('paused'), { statusCode: 403 }); },
    decide: async (input) => { decisions.push(input); return JSON.stringify(await model(input)); },
  };
  return { dir, opts, cfg, calls, decisions, own, feeds, comments, logs, service: createQzoneService(opts),
    tick(ms = 60000) { clock += ms; }, now: () => clock,
    block(v) { blocked = v; }, login(v) { login = v; }, model(fn) { model = fn; }, override(fn) { override = fn; },
    addComment(key, { author = 2, content = '你好', time = clock / 1000, replies = [] } = {}) {
      comments.get('own').push({ comment_id: key, uin: author, name: '评论者', content, time, replies }); own.find((p) => p.tid === 'own').comment_num++;
    },
  };
}

test('default disabled; selected publishing defaults and valid decision formats', () => {
  assert.equal(qzoneConfig().enabled, false);
  assert.equal(qzoneConfig().dailyPostLimit, 3);
  assert.equal(qzoneConfig().minPostIntervalMs, 10800000);
  assert.equal(qzoneConfig().visibility, 'friends');
  assert.throws(() => parseQzoneDecision('do something'));
  assert.throws(() => parseQzoneDecision('{"post":null,"replies":[{}]}'));
});

test('space and chats share evidence; memory failure cannot turn successful publication into a retry', async (t) => {
  const f = fixture(t);
  const memory = createSharedMemory({ file: path.join(f.dir, 'memory.sqlite'), now: f.now });
  try {
    memory.record({ accountQQ: '1', source: 'group:456', actorQQ: '2', text: '明天去海边', externalId: 'chat' });
    f.opts.observeMemory = (qq, data) => recordQzoneMemory(memory, qq, data);
    f.opts.decide = async () => {
      const recall = memory.recall('1', { people: ['2'] });
      assert.ok(recall.events.some((e) => e.source === 'group:456'));
      assert.ok(recall.events.some((e) => e.source === 'qzone:2'));
      return JSON.stringify({ post: '期待明天的海边', replies: [], comments: [] });
    };
    const service = createQzoneService(f.opts);
    await service.run();
    assert.ok(memory.recall('1').events.some((e) => e.kind === 'qzoneAction' && e.status === 'sent'));
    f.tick(10800000);
    f.opts.observeMemory = () => { throw Error('fixture memory unavailable'); };
    const impaired = createQzoneService(f.opts);
    await impaired.publish('新的说说', null);
    assert.equal((await impaired.status(null)).budget.uncertain, false);
    const repeat = await impaired.publish('新的说说', null); assert.equal(repeat.duplicate, true);
    assert.equal(f.calls.filter((c) => c.action === 'send_qzone_msg').length, 2);
  } finally { memory.close(); }
});
test('browse friends, configured QQ and own posts; strip HTML without executing it', async (t) => {
  const f = fixture(t, { watchQQ: ['2'] });
  f.feeds[0].html = '<script>bad()</script><b>好天气</b>';
  const s = await f.service.browse(null);
  assert.equal(s.pendingFeeds[0].content, '好天气');
  assert.equal(f.calls.filter((c) => c.action === 'get_qzone_msg_list').length, 2);
  assert.equal(f.calls.filter((c) => c.action.startsWith('send')).length, 0);
});

test('own feeds are read after publish and polling, while comments and mentions remain new', async t => {
  const f = fixture(t, { watchQQ: ['1'] });
  const published = await f.service.publish('我自己发的', null);
  let state = JSON.parse(fs.readFileSync(f.opts.file, 'utf8')).accounts['1'];
  assert.ok(state.seenFeeds.includes(`post:1:${published.tid}`));
  f.feeds.push({ uin: 1, key: published.tid, appid: 311, html: '我自己发的', time: f.now() / 1000 });
  f.feeds.push({ uin: 1, key: 'own', appid: 311, html: '我自己的旧动态', time: f.now() / 1000 });
  f.addComment('fresh', { content: '@{uin:1,nick:bot,who:1} 新评论' });
  const result = await f.service.browse(null);
  assert.deepEqual(result.pendingFeeds.map(p => p.authorQQ), ['2']);
  assert.equal(result.comments.length, 1); assert.equal(result.comments[0].status, 'new');
  assert.equal(result.comments[0].mentioned, true);
  state = JSON.parse(fs.readFileSync(f.opts.file, 'utf8')).accounts['1'];
  assert.ok(state.seenFeeds.includes('post:1:own'));
  const restored = createQzoneService(f.opts);
  assert.equal((await restored.browse(null)).comments.length, 1);
  assert.equal((await restored.status(null)).pendingFeeds.some(p => p.authorQQ === '1'), false);
});

test('old persisted own pending feeds migrate without consuming other feeds or comments', async t => {
  const f = fixture(t); f.addComment('unread'); await f.service.browse(null);
  const data = JSON.parse(fs.readFileSync(f.opts.file, 'utf8'));
  data.accounts['1'].pendingFeeds.push({ key: 'post:1:legacy', authorQQ: '1', tid: 'legacy' });
  fs.writeFileSync(f.opts.file, JSON.stringify(data));
  const restored = createQzoneService(f.opts), result = await restored.status(null);
  assert.equal(result.pendingFeeds.length, 1); assert.equal(result.pendingFeeds[0].authorQQ, '2');
  assert.equal(result.comments.length, 1);
  assert.ok(JSON.parse(fs.readFileSync(f.opts.file, 'utf8')).accounts['1'].seenFeeds.includes('post:1:legacy'));
});
test('post interval, Beijing daily quota, friend visibility and concurrent dedup survive restart', async (t) => {
  const f = fixture(t);
  const pair = await Promise.all([f.service.publish('第一条', null), f.service.publish('第一条', null)]);
  assert.equal(pair[1].duplicate, true);
  assert.equal(f.calls.filter((c) => c.action === 'send_qzone_msg').length, 1);
  assert.deepEqual(f.calls.find((c) => c.action === 'send_qzone_msg').params, { content: '第一条', ugc_right: 4 });
  await assert.rejects(f.service.publish('太快', null), /间隔/);
  f.tick(10800000); await f.service.publish('第二条', null);
  f.tick(10800000); await f.service.publish('第三条', null);
  f.tick(10800000); await assert.rejects(f.service.publish('第四条', null), /额度/);
  const restored = createQzoneService(f.opts);
  assert.equal((await restored.status(null)).budget.today, 3);
  f.tick(8 * 3600000); await restored.publish('跨北京时间午夜', null);
  assert.equal((await restored.status(null)).budget.today, 1);
});
test('unknown publish is never retried after restart; remote readback reconciles it', async (t) => {
  const f = fixture(t);
  f.override((action) => { if (action === 'send_qzone_msg') throw Error('connection lost'); });
  await assert.rejects(f.service.publish('回执丢了', null), /未确认/);
  f.override(null); f.tick(10800000);
  const restored = createQzoneService(f.opts);
  await assert.rejects(restored.publish('换个措辞重发', null), /待核对/);
  f.own.unshift({ tid: 'actual', content: '回执丢了', time: (f.now() - 10800000) / 1000, comment_num: 0 });
  await restored.browse(null);
  assert.equal((await restored.status(null)).budget.uncertain, false);
  assert.equal(f.calls.filter((c) => c.action === 'send_qzone_msg').length, 1);
});
test('corrupt state is retained and no remote access or model call occurs', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.opts.file, '{broken');
  const service = createQzoneService(f.opts);
  await service.run();
  await assert.rejects(service.publish('不能发', null), /状态/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(f.opts.file, 'utf8'), '{broken');
});
test('pause and disabled switch stop calls; activity resumes without replaying processed feeds', async (t) => {
  const f = fixture(t);
  f.block(true); await f.service.run(); assert.equal(f.calls.length, 0);
  f.block(false); await f.service.run(); assert.equal(f.decisions.length, 1);
  f.tick(); await f.service.run(); assert.equal(f.decisions.length, 1);
  f.cfg.enabled = false; f.tick(1800000); await f.service.run(); assert.equal(f.decisions.length, 1);
  f.cfg.enabled = true; await f.service.run(); assert.equal(f.decisions.length, 2);
  assert.equal(f.decisions[1].pendingFeeds.length, 0);
});

test('first startup during peak retains visible comments arriving before the first permitted poll', async (t) => {
  const f = fixture(t); f.block(true); await f.service.run();
  f.tick(); f.addComment('during-peak');
  f.tick(3 * 3600000); f.block(false); await f.service.run();
  assert.deepEqual(f.decisions[0].comments.map((c) => c.commentId), ['during-peak']);
  f.tick(); await f.service.run(); assert.equal(f.decisions.length, 1);
});
test('pause or account switch while awaiting read prevents the actual write', async (t) => {
  for (const change of ['pause', 'account']) {
    const f = fixture(t);
    let logins = 0;
    f.override((action) => { if (action === 'get_login_info' && ++logins === 2) { if (change === 'pause') f.block(true); else f.login('9'); } });
    await assert.rejects(f.service.publish('不能发', null));
    assert.equal(f.calls.filter((c) => c.action === 'send_qzone_msg').length, 0);
  }
});
test('queued operation rechecks authorization; sensitive text never reaches gateway', async (t) => {
  const f = fixture(t);
  f.override((action) => { if (action === 'send_qzone_msg') { f.block(true); return { status: 'ok', retcode: 0, data: { tid: 'one' } }; } });
  const r = await Promise.allSettled([f.service.publish('正常', null), f.service.publish('排队', null)]);
  assert.equal(r[1].status, 'rejected');
  f.block(false); await assert.rejects(f.service.publish('secret', null));
  assert.equal(f.calls.filter((c) => c.action === 'send_qzone_msg').length, 1);
});

test('a block after intent persistence but before dispatch does not consume quota', async (t) => {
  const f = fixture(t); let checks = 0;
  const service = createQzoneService({ ...f.opts, assertAllowed: (_context, action) => {
    if (action === 'publish' && ++checks === 2) throw Error('peak boundary');
  } });
  await assert.rejects(service.publish('边界时刻', null), /peak boundary/);
  assert.equal(f.calls.filter((c) => c.action === 'send_qzone_msg').length, 0);
  assert.equal((await service.status(null)).budget.allowed, true);
  await service.publish('边界时刻', null);
  assert.equal(f.calls.filter((c) => c.action === 'send_qzone_msg').length, 1);
});
test('new comments wake independently, no reply quota, historical and self comments skipped', async (t) => {
  const f = fixture(t);
  await f.service.run();
  f.addComment('historical', { time: f.now() / 1000 - 100 });
  f.addComment('self', { author: 1 });
  for (let i = 0; i < 7; i++) f.addComment('new-' + i);
  f.model((input) => ({ post: null, replies: input.comments.map((c) => ({ commentKey: c.key, content: '回应 ' + c.commentId })) }));
  f.tick(); await f.service.run();
  assert.equal(f.decisions.length, 2);
  assert.equal(f.calls.filter((c) => c.action === 'comment_qzone').length, 7);
  f.tick(); await f.service.run(); assert.equal(f.decisions.length, 2);
  const restored = createQzoneService(f.opts); f.tick(); await restored.run();
  assert.equal(f.calls.filter((c) => c.action === 'comment_qzone').length, 7);
});
test('friend commenting and structured mentions; arbitrary targets and raw mention markup rejected', async (t) => {
  const f = fixture(t);
  const s = await f.service.browse(null);
  const key = s.pendingFeeds[0].key;
  await f.service.comment(key, '天气不错', null, ['2']);
  assert.deepEqual(f.calls.find((c) => c.action === 'comment_qzone').params,
    { tid: 'friend', content: '@{uin:2,nick:好友,who:1} 天气不错', target_uin: 2 });
  await f.service.comment(key, '重复', null);
  assert.equal(f.calls.filter((c) => c.action === 'comment_qzone').length, 1);
  await assert.rejects(f.service.comment('fake', '越界', null), /已读取/);
  await assert.rejects(f.service.publish('正文', null, ['999']), /只能 @/);
  await assert.rejects(f.service.publish('@{uin:999,nick:冒充,who:1}', null), /mentions/);
});
test('structured inbound @ wakes on event poll, plain name/profile link is not an @', async (t) => {
  assert.deepEqual(qzoneMentions('小鲸鱼 1 <a href="https://user.qzone.qq.com/1">作者</a>'), []);
  assert.deepEqual(qzoneMentions('@{uin:1,nick:鲸鱼,who:1}'), ['1']);
  assert.deepEqual(qzoneMentions('<a link="nameCard_1">@鲸鱼</a>'), ['1']);
  const f = fixture(t); await f.service.run();
  f.tick(); f.feeds.push({ uin: 2, nickname: '好友', key: 'mention', appid: 311, time: f.now() / 1000, html: '@{uin:1,nick:鲸鱼,who:1} 看这里' });
  await f.service.run(); assert.equal(f.decisions.length, 2);
  assert.equal(f.decisions[1].wakeReason, '新评论或空间 @');
  f.tick(); await f.service.run(); assert.equal(f.decisions.length, 2);
});
test('model cannot choose unknown comment/post; a pause after inference prevents writes', async (t) => {
  const f = fixture(t);
  f.model(() => ({ post: null, replies: [], comments: [{ postKey: 'fake', content: 'no' }] }));
  await f.service.run(); assert.equal(f.calls.filter((c) => c.action === 'comment_qzone').length, 0);
  f.tick(1800000); f.model(() => { f.block(true); return { post: 'no', replies: [] }; });
  await f.service.run(); assert.equal(f.calls.filter((c) => c.action === 'send_qzone_msg').length, 0);
});
test('missing comments API degrades honestly without breaking browsing', async (t) => {
  const f = fixture(t); f.addComment('new');
  f.override((action) => action === 'get_qzone_msg_detail' ? { status: 'failed', retcode: 1404 } : undefined);
  const s = await f.service.browse(null);
  assert.equal(s.commentSupport, 'unavailable'); assert.ok(s.pendingFeeds.length);
});

test('ordinary comments on other posts do not wake; an exact @ in a comment does', async (t) => {
  const f = fixture(t); await f.service.run();
  f.tick(); f.comments.get('friend').push({ comment_id: 'not-for-me', uin: 3, name: '人', time: f.now() / 1000, content: '路过' });
  await f.service.run(); assert.equal(f.decisions.length, 1);
  f.tick(); f.comments.get('friend').push({ comment_id: 'for-me', uin: 3, name: '人', time: f.now() / 1000, content: '@{uin:1,nick:鲸鱼,who:1} 在吗' });
  await f.service.run(); assert.equal(f.decisions.length, 2);
  assert.deepEqual(f.decisions[1].comments.map((c) => c.commentId), ['for-me']);
});

test('validate every model target before sending any part of a batch', async (t) => {
  const f = fixture(t);
  f.model((input) => ({ post: null, replies: [], comments: [
    { postKey: input.pendingFeeds[0].key, content: '合法' }, { postKey: 'fake', content: '非法' },
  ] }));
  await f.service.run(); assert.equal(f.calls.filter((c) => c.action === 'comment_qzone').length, 0);
});
test('DSH worker registers waiter before prompt; explicit guard after async model selection', async () => {
  let allowed = true, prompts = 0, worker;
  const ok = (value) => ({ result: { ok: true, value } });
  const api = { events: { follow() {} }, sessions: {
      create: async () => ok({ sessionId: 'space' }),
      prompt: async () => { prompts++; worker.onEvent('space', { type: 'turn/start', data: { turn: 1 } });
        worker.onEvent('space', { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '{"post":null,"replies":[]}' }] } } });
        worker.onEvent('space', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }); return ok({}); },
    } };
  worker = createQzoneAgent({ api, ensureWorkspace: async () => 'ws', resolvePreset: () => 'qq-qzone',
    ensureModel: async () => {}, assertAllowed: () => { if (!allowed) throw Error('peak'); }, role: () => '小鲸鱼' });
  assert.equal(JSON.parse(await worker.decide({ accountQQ: '1' })).post, null); assert.equal(prompts, 1);
  worker = createQzoneAgent({ api, ensureWorkspace: async () => 'ws', resolvePreset: () => 'qq-qzone',
    ensureModel: async () => { allowed = false; }, assertAllowed: () => { if (!allowed) throw Error('peak'); }, role: () => '' });
  await assert.rejects(worker.decide({ accountQQ: '1' }), /peak/); assert.equal(prompts, 1);
});

test('DSH explicit queue rejection allows retry; transport uncertainty does not enqueue again', async () => {
  let prompts = 0, uncertain = false;
  const ok = (value) => ({ result: { ok: true, value } });
  const api = { events: { follow() {} }, sessions: {
    create: async () => ok({ sessionId: 'space' }), prompt: async () => {
      prompts++; if (uncertain) throw Error('connection lost');
      return { result: { ok: false, error: { code: 'rejected', message: 'fixture' } } };
    },
  } };
  const worker = createQzoneAgent({ api, ensureWorkspace: async () => 'ws', resolvePreset: () => 'qq-qzone', ensureModel: async () => {}, assertAllowed() {}, role: () => '' });
  await assert.rejects(worker.decide({ accountQQ: '1' }), /rejected/);
  await assert.rejects(worker.decide({ accountQQ: '1' }), /rejected/); assert.equal(prompts, 2);
  uncertain = true; await assert.rejects(worker.decide({ accountQQ: '1' }), /connection lost/);
  await assert.rejects(worker.decide({ accountQQ: '1' }), /尚未结束/); assert.equal(prompts, 3);
});

test('DSH account switch isolates sessions within the shared workspace; failed model selection sends no prompt', async () => {
  const created = [], prompts = []; let worker, selected = 'applied';
  const ok = (value) => ({ result: { ok: true, value } });
  const api = { events: { follow() {} }, sessions: {
      create: async (params) => { created.push(params); return ok({ sessionId: 's-' + created.length }); },
      prompt: async ({ sessionId }) => {
        prompts.push(sessionId);
        worker.onEvent(sessionId, { type: 'turn/start', data: { turn: 1 } });
        worker.onEvent(sessionId, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '{"post":null,"replies":[]}' }] } } });
        worker.onEvent(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }); return ok({});
      },
    } };
  worker = createQzoneAgent({ api, ensureWorkspace: async () => 'shared-workspace', resolvePreset: () => 'qq-qzone',
    ensureModel: async () => selected, assertAllowed() {}, role: () => '' });
  await worker.decide({ accountQQ: '1' }); await worker.decide({ accountQQ: '2' });
  assert.deepEqual(created, [
    { workspaceId: 'shared-workspace', agentPreset: 'qq-qzone' },
    { workspaceId: 'shared-workspace', agentPreset: 'qq-qzone' },
  ]);
  assert.deepEqual(prompts, ['s-1', 's-2']);
  selected = 'failed'; await assert.rejects(worker.decide({ accountQQ: '2' }), /配置未成功/); assert.equal(prompts.length, 2);
  selected = 'not-found'; await assert.rejects(worker.decide({ accountQQ: '2' }), /失效/);
  selected = 'applied'; await worker.decide({ accountQQ: '2' }); assert.equal(prompts.at(-1), 's-3');
});

for (const customDirectory of [false, true]) for (const spaceFirst of [false, true]) {
  test(`QQ chat and space share one workspace and retain separate presets (custom=${customDirectory}, spaceFirst=${spaceFirst})`, async () => {
    const h = await bridgeHarness({ config: { workspaceTitle: '小鲸鱼', socialV2: { qzone: { enabled: true }, peakSleep: { enabled: false } } }, globals: roleCard });
    h.setMode('reserved2');
    const directory = path.join(h.temp, customDirectory ? 'custom-workspace' : 'state/agents');
    if (customDirectory) h.cfg.sessionCwd = directory;
    const paths = [], workspaces = new Map(), renamed = [];
    const ok = (value) => ({ result: { ok: true, value } });
    h.api.workspace.create = async ({ path: dir }) => {
      paths.push(dir);
      const created = !workspaces.has(dir);
      if (created) workspaces.set(dir, 'ws-' + workspaces.size);
      return ok({ created, workspace: { workspaceId: workspaces.get(dir) } });
    };
    h.api.workspace.rename = async (params) => { renamed.push(params); return ok({}); };
    h.api.sessions.prompt = async ({ sessionId }) => {
      assert.equal(h.qzoneAgent.owns(sessionId), true);
      h.qzoneAgent.onEvent(sessionId, { type: 'turn/start', data: { turn: 1 } });
      h.qzoneAgent.onEvent(sessionId, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '{"post":null,"comments":[],"replies":[]}' }] } } });
      h.qzoneAgent.onEvent(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
      return ok({});
    };
    const runSpace = () => h.qzoneAgent.decide({ accountQQ: '1' });
    try {
      if (spaceFirst) await runSpace();
      const group = await h.ensureSession('group:456');
      const owner = await h.ensureSession('private:123');
      if (!spaceFirst) await runSpace();
      await runSpace(); // 同账号重复活动继续使用原空间 session。
      assert.deepEqual(paths, [directory, directory, directory]);
      assert.equal(workspaces.size, 1);
      assert.deepEqual(renamed.map(({ workspaceId, title }) => ({ workspaceId, title })), [{ workspaceId: 'ws-0', title: '小鲸鱼' }]);
      assert.equal(h.calls.created.length, 3);
      assert.ok(h.calls.created.every((params) => params.workspaceId === 'ws-0'));
      assert.deepEqual(h.calls.created.map((params) => params.agentPreset).sort(), ['qq-chat-v2', 'qq-chat-v2-files', 'qq-qzone']);
      assert.equal(new Set(h.calls.follows).size, 3);
      assert.equal(h.qzoneAgent.owns(group), false);
      assert.equal(h.qzoneAgent.owns(owner), false);
      assert.equal(fs.existsSync(path.join(h.temp, 'state/qzone-agent')), false);
      assert.equal(h.calls.archived.length, 0);
      assert.equal(h.calls.sent.length, 0);
    } finally { await h.close(); }
  });
}

test('actual bridge endpoints require owner private token, ACL, mode and pause; group cannot spoof owner', async () => {
  const h = await bridgeHarness({ config: { socialV2: { qzone: { enabled: true }, peakSleep: { enabled: false } } } });
  h.setMode('reserved2');
  const token = h.getSocialV2State('private:123').agentToken;
  const groupToken = h.getSocialV2State('group:456').agentToken;
  const calls = [];
  h.bot.request = async (action, params) => { calls.push({ action, params }); return { status: 'ok', retcode: 0, data: action === 'get_login_info' ? { user_id: 1 } : { tid: 'published' } }; };
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  async function send(key, auth = token, more = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/qzone/publish', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', ...(auth === null ? {} : { 'x-agent-token': auth }), ...more } }, (res) => {
        let text = ''; res.on('data', (s) => { text += s; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
      }); req.on('error', reject); req.end(JSON.stringify({ key, content: '夹具说说' }));
    });
  }
  try {
    for (const [key, auth] of [['group:456', groupToken], ['private:123', groupToken], ['private:999', token], ['private:123', null], ['private:123', '']]) assert.equal((await send(key, auth)).status, 403);
    assert.equal(calls.length, 0);
    h.socialV2.paused = true; assert.equal((await send('private:123')).status, 403); h.socialV2.paused = false;
    h.setMode('chat'); assert.equal((await send('private:123')).status, 403); h.setMode('reserved2');
    h.cfg.allow.private = []; assert.equal((await send('private:123')).status, 403); h.cfg.allow.private = ['123'];
    assert.equal((await send('private:123', token, { origin: 'https://external.invalid' })).status, 403);
    const sent = await send('private:123'); assert.equal(sent.status, 200, JSON.stringify(sent));
    assert.equal(calls.filter((c) => c.action === 'send_qzone_msg').length, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

test('real bridge peak guard applies to space model/read/write, owner private only exempt, manual pause wins', async () => {
  let clock = Date.parse('2026-10-23T09:00:00+08:00');
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const h = await bridgeHarness({ config: { socialV2: { qzone: { enabled: true }, peakSleep: { enabled: true } } }, globals: { Date: ClockDate } });
  h.setMode('reserved2'); h.setReady(true);
  const owner = { key: 'private:123', authorize() {} }, group = { key: 'group:456', authorize() {} };
  try {
    for (const action of ['read', 'model', 'publish', 'reply', 'comment']) {
      assert.throws(() => h.assertQzoneAllowed(null, action), /梁文峰/);
      assert.throws(() => h.assertQzoneAllowed(group, action), /梁文峰/);
      assert.doesNotThrow(() => h.assertQzoneAllowed(owner, action));
    }
    clock = Date.parse('2026-10-23T12:00:00+08:00');
    assert.doesNotThrow(() => h.assertQzoneAllowed(null, 'model'));
    h.socialV2.paused = true;
    assert.throws(() => h.assertQzoneAllowed(null, 'model'), /暂停/);
    assert.throws(() => h.assertQzoneAllowed(owner, 'publish'), /暂停/);
    h.socialV2.paused = false;
    const file = path.join(h.temp, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.socialV2.qzone.enabled = false; fs.writeFileSync(file, JSON.stringify(cfg));
    assert.throws(() => h.assertQzoneAllowed(null, 'model'), /已关闭/);
    assert.throws(() => h.assertQzoneAllowed(owner, 'publish'), /已关闭/);
  } finally { await h.close(); }
});

test('space reports the specific blocking setting and never changes manual pause or silent state', async () => {
  const h = await bridgeHarness({ config: { socialV2: { qzone: { enabled: true }, peakSleep: { enabled: false } } },
    files: { 'state/current-role.json': { role: null, mode: 'silent' } } });
  h.setMode('reserved2');
  const owner = { key: 'private:123', authorize() {} };
  const roleFile = path.join(h.temp, 'state/current-role.json');
  const original = fs.readFileSync(roleFile, 'utf8');
  try {
    for (const context of [null, owner]) for (const action of ['read', 'model', 'publish', 'comment', 'reply']) {
      assert.throws(() => h.assertQzoneAllowed(context, action), /角色静默模式.*\/active/);
    }
    h.socialV2.paused = true;
    assert.throws(() => h.assertQzoneAllowed(owner, 'read'), /人工暂停/);
    assert.equal(h.socialV2.paused, true);
    h.socialV2.paused = false; h.setMode('chat');
    assert.throws(() => h.assertQzoneAllowed(owner, 'read'), /仅在二代仿真模式/);
    h.setMode('reserved2'); h.cfg.socialV2.enabled = false;
    assert.throws(() => h.assertQzoneAllowed(owner, 'read'), /socialV2.enabled=false/);
    assert.equal(fs.readFileSync(roleFile, 'utf8'), original);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.calls.sent.length, 0);
  } finally { await h.close(); }
});
