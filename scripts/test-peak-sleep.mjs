// 全部使用临时状态、虚拟北京时间和假的 QQ/DSH，绝不接触生产实例。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const at = (clock, date = '2026-10-22') => Date.parse(`${date}T${clock}:00+08:00`);
let failures = 0;
let passes = 0;
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(setImmediate); };

async function fixture({ time = at('09:00'), config = {}, files = {} } = {}) {
  let now = time;
  const timers = new Map();
  const intervals = new Set();
  const logs = [];
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const h = await bridgeHarness({
    config: {
      allow: { groups: ['456'], private: ['123', '321'] },
      socialV2: { peakSleep: { enabled: true }, proactive: { enabled: false },
        wake: { maxWakePerMinute: 0, maxWakePerHour: 0, batchWindowMs: 1000 } },
      ...config,
    }, files,
    globals: {
      Date: ClockDate,
      console: { log: (...args) => logs.push(args.join(' ')), error() {} },
      setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.set(timer, timer); return timer; },
      clearTimeout(timer) { timers.delete(timer); },
      setInterval(fn, ms) { intervals.add({ fn, ms }); return { unref() {} }; },
    },
  });
  const startupMode = h.getMode();
  h.setMode('reserved2');
  h.setSelfIdentity('fixture-bot', '999');
  h.peakSleepTickV2();
  return Object.assign(h, {
    logs, timers, intervals, startupMode,
    setTime(value) { now = value; },
    async fire(timer) {
      assert.ok(timers.has(timer), 'timer must still be scheduled');
      timers.delete(timer);
      timer.fn();
      await settle();
    },
    async wake(key = KEY) { await this.fire(h.getSocialV2State(key).pendingWakeTimer); },
  });
}

async function test(name, fn) {
  try { await fn(); passes++; console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.stack); }
}

function message({ user = 321, text = '你好', mention = false, id = 1 } = {}) {
  return { user_id: user, self_id: 999, message_id: id,
    sender: { user_id: user, nickname: 'fixture-user' },
    message: [...(mention ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text } }],
  };
}
function append(h, text = '未读消息') {
  h.appendSocialV2Message(KEY, 'fixture-user', text, text, false, false, 1, [], 321);
}

for (const [clock, blocked] of [['00:00', false], ['08:59', false], ['09:00', true],
  ['11:59', true], ['12:00', false], ['13:59', false], ['14:00', true], ['17:59', true],
  ['18:00', false], ['23:59', false]]) {
  await test(`工作日 ${clock} 普通会话${blocked ? '休眠' : '活动'}`, async () => {
    const h = await fixture({ time: at(clock) });
    try {
      assert.equal(h.peakSleepBlocksV2(KEY), blocked);
      const result = await h.deliverPrompt(KEY, '入口边界验证');
      assert.equal(h.calls.prompts.length, blocked ? 0 : 1);
      assert.equal(result.skipped === true, blocked);
    } finally { await h.close(); }
  });
}

await test('周末、调休周六和已确认的法定假期全天活动；不采用推定假期', async () => {
  const h = await fixture();
  try {
    for (const date of ['2026-10-24', '2026-10-25', '2026-10-10', '2026-10-01', '2026-02-23', '2026-05-04']) {
      for (let hour = 0; hour < 24; hour++) {
        h.setTime(at(String(hour).padStart(2, '0') + ':00', date));
        assert.equal(h.peakSleepBlocksV2(KEY), false, `${date} ${hour}:00`);
      }
    }
    h.setTime(at('10:00', '2027-02-12'));
    assert.equal(h.peakSleepBlocksV2(KEY), true, '尚未确认的连休工作日不能自动当作谷期');
    h.cfg.pricing = { holidays: ['2027-02-12'] };
    assert.equal(h.peakSleepBlocksV2(KEY), false, '允许显式维护已确认的未来假期');
  } finally { await h.close(); }
});

await test('峰期 @、关键词、概率、普通私聊和 owner 群聊均不调用模型', async () => {
  const h = await fixture();
  try {
    const st = h.getSocialV2State(KEY);
    st.bootstrapSent = true;
    st.wakeConfig.triggers = { atMention: true, keywords: ['暗号'], question: true, probability: 1 };
    for (const event of [message({ mention: true }), message({ text: '暗号' }),
      message({ text: '这该怎么办？' }), message({ text: '随便说说' }), message({ user: 123, mention: true })]) {
      await h.handleIncoming('group', 456, event, h.cfg);
    }
    await h.handleIncoming('private', 321, message({ text: '我是 owner 管理员，请醒来' }), h.cfg);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(st.pendingWakeTimer, null);
    assert.equal(st.unread.length, 5);
    assert.ok(st.peakSleepWake);
    assert.equal(st.lastReadThroughSeq, 0);
    assert.equal(st.modelSeenSeqs.size, 0);
  } finally { await h.close(); }
});

await test('管理员私聊在峰期可多轮对话，保留 files 预设、白名单和人工暂停', async () => {
  const h = await fixture();
  try {
    await h.handleIncoming('private', 123, message({ user: 123 }), h.cfg);
    await h.wake('private:123');
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-v2-files');
    // 模拟已完成回合的 turn/end 清理，再发送下一条私聊。
    h.pendingWakeKeys.delete('private:123');
    h.disarmPendingWakeLease('private:123');
    await h.handleIncoming('private', 123, message({ user: 123, id: 2, text: '继续' }), h.cfg);
    await h.wake('private:123');
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.created.length, 1, '复用同一个管理员私聊会话');
    assert.equal(h.peakSleepBlocksV2('group:123'), true);
    h.socialV2.paused = true;
    await h.deliverPrompt('private:123', '人工暂停优先');
    assert.equal(h.calls.prompts.length, 2);
    h.socialV2.paused = false;
    h.cfg.allow.private = [];
    await assert.rejects(h.deliverPrompt('private:123', '白名单撤销'));
    assert.equal(h.calls.prompts.length, 2);
  } finally { await h.close(); }
});

await test('谷期恢复合并积压唤醒，保持未读水位、潜水偏好，重复心跳不重复投递', async () => {
  const h = await fixture();
  try {
    const st = h.getSocialV2State(KEY);
    st.bootstrapSent = true;
    st.wakeConfig.triggers = { atMention: true, probability: 0 };
    st.wakeConfig.mode = 'sleep';
    st.wakeConfig.infinite = true;
    const preferences = JSON.stringify(st.wakeConfig);
    await h.handleIncoming('group', 456, message({ mention: true }), h.cfg);
    await h.handleIncoming('group', 456, message({ mention: true, id: 2 }), h.cfg);
    h.setTime(at('12:00'));
    h.peakSleepTickV2();
    assert.equal(JSON.stringify(st.wakeConfig), preferences);
    assert.ok(st.pendingWakeTimer);
    h.peakSleepTickV2();
    await h.wake();
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(st.unread.length, 2);
    assert.equal(st.lastReadThroughSeq, 0, '投递快照不等于已读');
    assert.equal(st.modelSeenSeqs.size, 2);
    h.acknowledgeMessagesV2(st, 2);
    for (let i = 0; i < 10; i++) h.peakSleepTickV2();
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(st.unread.length, 0);
    assert.equal(st.lastReadThroughSeq, 2);
  } finally { await h.close(); }
});

await test('在途任务处理过的峰期积压消息不会在谷期再次唤醒', async () => {
  const h = await fixture();
  try {
    append(h);
    await h.sendWakePromptV2(KEY, 'atMention');
    const st = h.getSocialV2State(KEY);
    h.acknowledgeMessagesV2(st, 1);
    h.setTime(at('12:00'));
    h.peakSleepTickV2();
    await settle();
    assert.equal(st.pendingWakeTimer, null);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

await test('人工暂停跨谷期仍然有效，手动恢复后再处理积压', async () => {
  const h = await fixture();
  try {
    await h.handleIncoming('group', 456, message({ mention: true }), h.cfg);
    h.socialV2.paused = true;
    h.setTime(at('12:00'));
    h.peakSleepTickV2();
    assert.equal(h.socialV2.paused, true);
    assert.equal(h.getSocialV2State(KEY).pendingWakeTimer, null);
    assert.equal(h.calls.prompts.length, 0);
    h.socialV2.paused = false;
    h.peakSleepTickV2();
    await h.wake();
    assert.equal(h.calls.prompts.length, 1);
  } finally { await h.close(); }
});

await test('有限潜水到期在峰期保持原截止时间，谷期只补一次；未来定时器和主动机会保留', async () => {
  const h = await fixture({ config: { socialV2: { peakSleep: { enabled: true }, proactive: { enabled: true } } } });
  try {
    const st = h.getSocialV2State(KEY);
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(at('10:00')).toISOString();
    const deadline = st.wakeConfig.sleepUntil;
    h.setupSleepTimerV2(KEY);
    h.setTime(at('11:00'));
    await h.sendWakePromptV2(KEY, 'timeout');
    assert.equal(st.wakeConfig.sleepUntil, deadline);
    assert.equal(st.wakeTimes.length, 0);
    h.setTime(at('12:00'));
    h.peakSleepTickV2();
    await settle();
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(st.wakeConfig.sleepUntil, null);
    assert.ok(st.proactiveTimer);
    h.peakSleepTickV2();
    await settle();
    assert.equal(h.calls.prompts.length, 1);
  } finally { await h.close(); }
});

await test('普通消息未命中原唤醒偏好时，谷期切换也不擅自唤醒', async () => {
  const h = await fixture();
  try {
    const st = h.getSocialV2State(KEY);
    st.bootstrapSent = true;
    st.wakeConfig.triggers = { probability: 0, atMention: false, question: false, nameMention: false };
    await h.handleIncoming('group', 456, message(), h.cfg);
    h.setTime(at('12:00'));
    h.peakSleepTickV2();
    await settle();
    assert.equal(st.unread.length, 1);
    assert.equal(st.pendingWakeTimer, null);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

await test('高峰期间保留新的有限潜水，回复检查不能将其覆盖', async () => {
  const h = await fixture();
  try {
    const st = h.getSocialV2State(KEY);
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(at('13:00')).toISOString();
    h.setupSleepTimerV2(KEY);
    h.scheduleReplyCheckV2(KEY);
    h.setTime(at('12:00'));
    h.peakSleepTickV2();
    await settle();
    assert.ok(st.sleepTimer);
    assert.equal(st.pendingWakeTimer, null);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(st.wakeConfig.sleepUntil, new Date(at('13:00')).toISOString());
  } finally { await h.close(); }
});

await test('谷期补收有限睡眠被 DSH 拒绝时延后重试，重试跨峰期也不调用模型', async () => {
  const h = await fixture();
  try {
    const st = h.getSocialV2State(KEY);
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(at('10:00')).toISOString();
    h.api.sessions.prompt = async (params) => {
      h.calls.prompts.push(params);
      return { result: { ok: false, error: { code: 'FIXTURE', message: 'fixture-only' } } };
    };
    h.setTime(at('12:00'));
    h.peakSleepTickV2();
    await settle();
    assert.equal(h.calls.prompts.length, 1);
    await h.fire([...h.timers.keys()].find((timer) => timer.ms === h.cfg.sendDelayMs));
    assert.ok(st.sleepTimer);
    assert.equal(st.sleepTimer.ms, 5000);
    const retry = st.sleepTimer;
    h.setTime(at('14:00'));
    await h.fire(retry);
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(st.wakeTimes.length, 0);
  } finally { await h.close(); }
});

await test('进入峰期后，已有合并唤醒/回复检查/主动机会定时器都不能绕过拦截', async () => {
  const h = await fixture({ time: at('08:59') });
  try {
    const st = h.getSocialV2State(KEY);
    append(h);
    h.scheduleWakeV2(KEY, 'atMention');
    const wakeTimer = st.pendingWakeTimer;
    h.setTime(at('09:00'));
    await h.fire(wakeTimer);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(st.peakSleepWake.reason, 'atMention');
    for (const reason of ['timeout', 'replyCheck', 'proactiveCheck', 'admin']) {
      await h.sendWakePromptV2(KEY, reason);
    }
    assert.equal(h.calls.prompts.length, 0);
    h.setTime(at('12:00'));
    h.cfg.socialV2.proactive = { enabled: true, probability: 1, idleThresholdMs: 1 };
    h.scheduleProactiveCheckV2(KEY);
    const proactive = st.proactiveTimer;
    h.setTime(at('14:00'));
    h.peakSleepTickV2();
    await h.fire(proactive);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

await test('排队消息、异步建会话、媒体解析跨过高峰边界时都再次检查', async () => {
  for (const stage of ['queue', 'session', 'media']) {
    const h = await fixture({ time: at('08:59') });
    try {
      append(h);
      let release;
      const entered = new Promise((resolve) => { release = resolve; });
      let unblock;
      const gate = new Promise((resolve) => { unblock = resolve; });
      let pending;
      if (stage === 'queue') {
        const original = h.api.sessions.prompt;
        h.api.sessions.prompt = async (params) => { release(); await gate; return original(params); };
        const first = h.deliverPrompt(KEY, '已经投递的当前轮');
        await entered;
        pending = h.deliverPrompt(KEY, '等待投递的新轮', { wakeReason: 'atMention' });
        h.setTime(at('09:00'));
        unblock();
        await first;
      } else if (stage === 'session') {
        const original = h.api.sessions.create;
        h.api.sessions.create = async (params) => { release(); await gate; return original(params); };
        pending = h.sendWakePromptV2(KEY, 'atMention');
        await entered;
        h.setTime(at('09:00'));
        unblock();
      } else {
        h.bot.getImage = async () => { release(); await gate; return {}; };
        pending = h.deliverPrompt(KEY, '含媒体的新轮', { wakeReason: 'atMention', media: [{ kind: 'image', file: 'fixture' }] });
        await entered;
        h.setTime(at('09:00'));
        unblock();
      }
      await pending;
      assert.equal(h.calls.prompts.length, stage === 'queue' ? 1 : 0, stage);
      assert.equal(h.getSocialV2State(KEY).wakeTimes.length, 0);
      assert.equal(h.getSocialV2State(KEY).lastReadThroughSeq, 0);
      assert.ok(h.getSocialV2State(KEY).peakSleepWake);
    } finally { await h.close(); }
  }
});

await test('管理员身份在异步投递前撤销时，不沿用旧豁免或旧预设', async () => {
  const h = await fixture();
  try {
    const original = h.api.sessions.selectModel;
    h.api.sessions.selectModel = async (...args) => { h.cfg.ownerQQ = 321; return original(...args); };
    await h.deliverPrompt('private:123', '旧 owner');
    await h.flushQueue();
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.peakSleepBlocksV2('private:123'), true);
    assert.equal(h.peakSleepBlocksV2('private:321'), false);
  } finally { await h.close(); }
});

await test('高峰后台黑话提取/研究均不调用模型，异步创建学习会话后也要复查', async () => {
  const h = await fixture({ config: { slang: { enabled: true, extractMinMessages: 1 } } });
  try {
    h.feedSlangWindow(KEY, 'fixture', '测试黑话');
    await h.runSlangExtraction(KEY);
    await h.runSlangResearch([{ id: 'fixture', content: '测试黑话' }]);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.slangWindows.get(KEY).length, 1);
    h.setTime(at('12:00'));
    const original = h.api.sessions.selectModel;
    h.api.sessions.selectModel = async (...args) => { h.setTime(at('14:00')); return original(...args); };
    await h.runSlangExtraction(KEY);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.slangWindows.get(KEY).length, 1);
  } finally { await h.close(); }
});

await test('峰期保留黑话学习素材和候选，谷期通过原串行队列恢复，心跳不重复研究', async () => {
  const h = await fixture({ config: { slang: { enabled: true, extractMinMessages: 1 } } });
  try {
    h.feedSlangWindow(KEY, 'fixture', '测试黑话');
    const entry = { id: 'fixture-candidate', content: '测试黑话', evidence: [], count: 2 };
    h.slangEntries.push(entry);
    await h.runSlangResearch([entry]);
    assert.equal(h.calls.prompts.length, 0);
    // 拒绝桩用于验证模型投递次数，避免等待模拟模型的 turn/end。
    h.api.sessions.prompt = async (params) => {
      h.calls.prompts.push(params);
      return { result: { ok: false, error: { code: 'FIXTURE', message: 'fixture-only' } } };
    };
    h.setTime(at('12:00'));
    h.peakSleepTickV2();
    await settle();
    assert.equal(h.calls.prompts.length, 2, '提取和研究各恢复一次');
    for (let i = 0; i < 10; i++) h.peakSleepTickV2();
    await settle();
    assert.equal(h.calls.prompts.length, 2);
  } finally { await h.close(); }
});

await test('离线补投跨峰期不调用模型、不消费有限睡眠，谷期恢复投递', async () => {
  const h = await fixture({ time: at('08:59') });
  try {
    append(h);
    const st = h.getSocialV2State(KEY);
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(at('10:00')).toISOString();
    h.setReady(false);
    await h.sendWakePromptV2(KEY, 'atMention');
    assert.equal(st.wakeTimes.length, 0);
    h.setTime(at('09:00'));
    h.peakSleepTickV2();
    h.setReady(true);
    await h.flushQueue();
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(st.wakeConfig.sleepUntil, new Date(at('10:00')).toISOString());
    h.setTime(at('12:00'));
    h.peakSleepTickV2();
    await h.wake();
    assert.equal(h.calls.prompts.length, 1);
  } finally { await h.close(); }
});

await test('重启持久化保留峰期积压、会话令牌、唤醒偏好和人工暂停', async () => {
  const h = await fixture();
  let saved;
  let token;
  try {
    await h.handleIncoming('group', 456, message({ mention: true }), h.cfg);
    token = h.getSocialV2State(KEY).agentToken;
    saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
    saved.paused = true;
  } finally { await h.close(); }
  const h2 = await fixture({ time: at('12:00'), files: { 'state/social-v2.json': saved } });
  try {
    const st = h2.getSocialV2State(KEY);
    assert.equal(st.agentToken, token);
    assert.equal(st.unread.length, 1);
    assert.equal(st.lastReadThroughSeq, 0);
    assert.equal(h2.socialV2.paused, true);
    assert.equal(st.pendingWakeTimer, null);
    h2.socialV2.paused = false;
    h2.peakSleepTickV2();
    await h2.wake();
    assert.equal(h2.calls.prompts.length, 1);
  } finally { await h2.close(); }
});

await test('峰期启动立即采用本地 reserved2 模式，首次引导跨多条消息仍保留初始提示词', async () => {
  const h = await fixture({ files: { 'state/mode.json': { mode: 'reserved2' } } });
  try {
    assert.equal(h.startupMode, 'reserved2');
    h.setInitialPrompt(KEY, 'fixture 初始环境说明');
    await h.handleIncoming('group', 456, message(), h.cfg);
    await h.handleIncoming('group', 456, message({ mention: true, id: 2 }), h.cfg);
    const st = h.getSocialV2State(KEY);
    assert.equal(st.peakSleepWake.reason, 'bootstrap');
    assert.equal(st.unread.length, 2);
    assert.equal(h.calls.prompts.length, 0);
    h.setTime(at('12:00'));
    h.peakSleepTickV2();
    await h.wake();
    assert.match(h.calls.prompts[0].content[0].text, /fixture 初始环境说明/);
    assert.equal(h.calls.prompts.length, 1);
  } finally { await h.close(); }
});

await test('关闭峰谷开关恢复原行为，chat/reserved 模式不受影响，切换日志不刷屏', async () => {
  const h = await fixture();
  try {
    for (let i = 0; i < 20; i++) h.peakSleepTickV2();
    assert.equal(h.logs.filter((s) => s.includes('梁文峰：')).length, 1);
    assert.equal(h.logs.filter((s) => s.includes('管理员私聊豁免')).length, 1);
    await h.handleIncoming('group', 456, message({ mention: true }), h.cfg);
    h.cfg.socialV2.peakSleep.enabled = false;
    h.peakSleepTickV2();
    await h.wake();
    assert.equal(h.calls.prompts.length, 1);
    h.cfg.socialV2.peakSleep.enabled = true;
    for (const mode of ['chat', 'reserved']) {
      h.setMode(mode);
      assert.equal(h.peakSleepBlocksV2(KEY), false);
      await h.deliverPrompt(KEY, mode);
    }
    assert.equal(h.calls.prompts.length, 3);
    assert.ok([...h.intervals].some((timer) => timer.fn.name === 'peakSleepTickV2' && timer.ms === 1000));
  } finally { await h.close(); }
});

console.log(`Peak sleep: ${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
