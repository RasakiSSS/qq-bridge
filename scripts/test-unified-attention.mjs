import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedAttention } from '../src/unified/attention.js';
import { UnifiedActions } from '../src/unified/actions.js';
import { UnifiedTools } from '../src/unified/tools.js';
import { UnifiedScheduler } from '../src/unified/scheduler.js';

function fixture(t, file) {
  let now = Date.parse('2026-10-28T08:59:00+08:00');
  const ctx = { account: '100', ownerQQ: '200', enabled: true, peakEnabled: false, identityEpoch: 1 };
  const store = new UnifiedStore(file); t.after(() => store.close());
  store.account('100'); store.db.prepare("UPDATE accounts SET session_id='main'").run();
  const denied = new Set(), disabled = new Set(); let onSleep = () => {};
  const scenes = new UnifiedScenes({ store, getContext: () => ctx, isAllowed: key => !denied.has(key), now: () => now });
  const attention = new UnifiedAttention({ scenes, now: () => now, monotonic: () => now, toolAllowed: name => !disabled.has(name),
    initialWakeConfig: () => ({ mode: 'diving', infinite: true, triggers: { atMention: true, probability: 0.05 } }),
    sleep: async ms => { now += ms; await onSleep(); } });
  const actions = new UnifiedActions({ store, scenes, handlers: { setWakeConfig: attention.handler() }, now: () => now });
  const tools = new UnifiedTools({ scenes, actions, attention }), token = tools.issueMainCredential();
  const f = { store, scenes, attention, actions, tools, ctx, denied, disabled,
    now: () => now, advance: ms => now += ms, onSleep: fn => onSleep = fn,
    call: (name, args, callId = 'call') => tools.call(token, name, args, { sessionId: 'main', callId }),
    add: (key, id, extra = {}) => store.append({ account: '100', scene: key, sourceId: id, payload: { text: id }, at: now, ...extra }),
    timers: () => store.db.prepare('SELECT * FROM wake_timers').all(),
    events: () => store.db.prepare('SELECT * FROM events ORDER BY seq').all(),
    set: (capability, config, callId) => f.call('qq_set_wake_config', { capability, config }, callId),
  };
  return f;
}

test('short wait clamps both huge quiet and timeout to 12 seconds even under continuous traffic', async t => {
  const f = fixture(t), cap = await f.scenes.join('group:1');
  f.onSleep(() => f.add('group:1', String(f.now())));
  const result = await f.call('qq_wait_for_messages', { capability: cap.capability, quietMs: 300000, timeoutMs: 300000 });
  assert.equal(result.elapsedMs, 12000); assert.equal(result.quietMs, 12000);
  assert.equal(result.reason, 'timeout'); assert.equal(result.page.messages.length, 30);
  assert.equal(result.page.remaining, 90); assert.equal(f.events().filter(e => e.unread).length, 120);
  assert.equal(f.scenes.current().capability, cap.capability);
});

test('thinking time counts toward quiet; unread returned immediately and exact receipt ignores later arrivals', async t => {
  const f = fixture(t), cap = await f.scenes.join('group:1'); f.add('group:1', 'old'); f.advance(2000);
  const result = await f.call('qq_wait_for_messages', { capability: cap.capability, quietMs: 1200 });
  assert.equal(result.reason, 'quiet'); assert.equal(result.elapsedMs, 0);
  assert.equal(result.page.messages[0].payload.text, 'old');
  f.add('group:1', 'later'); f.scenes.markRead(result.page.receipt);
  assert.deepEqual(f.events().map(e => e.unread), [0, 1]);
});

test('waiting current chat yields promptly for another eligible chat without entering it', async t => {
  const f = fixture(t), cap = await f.scenes.join('group:1');
  f.onSleep(() => f.add('private:200', 'owner'));
  const result = await f.call('qq_wait_for_messages', { capability: cap.capability });
  assert.equal(result.reason, 'other-events'); assert.equal(result.elapsedMs, 100);
  assert.equal(result.pending[0].key, 'private:200'); assert.equal(f.scenes.current().key, 'group:1');
});

test('peak hides other groups from wait results but preserves current scene and owner signals', async t => {
  const f = fixture(t), cap = await f.scenes.join('group:1'); f.ctx.peakEnabled = true; f.advance(60000);
  f.add('group:2', 'hidden');
  const short = await f.call('qq_wait_for_messages', { capability: cap.capability, timeoutMs: 100 });
  assert.deepEqual(short.pending, []);
  assert.equal((await f.call('qq_wait_for_events')).status, 'yield');
  f.add('private:200', 'owner'); assert.equal((await f.call('qq_wait_for_events')).pending[0].key, 'private:200');
  assert.equal(f.events()[0].unread, 1);
});

test('revocation, manual pause, scene switch and tool disable interrupt short wait', async t => {
  for (const [mutate, code] of [
    [f => f.tools.revoke(), 'UNAUTHORIZED'], [f => f.ctx.paused = true, 'PAUSED'],
    [f => f.scenes.quit(), 'STALE_SCENE'], [f => f.disabled.add('waitMessages'), 'TOOL_DENIED'],
  ]) {
    const f = fixture(t), cap = await f.scenes.join('group:1'); f.onSleep(() => mutate(f));
    await assert.rejects(f.call('qq_wait_for_messages', { capability: cap.capability }), { code });
  }
});

test('global wait stores yield state, does not acknowledge or exit, and returns pending arrivals', async t => {
  const f = fixture(t); await f.scenes.join('group:1'); f.add('group:1', 'quiet', { wake: false });
  assert.equal((await f.call('qq_wait_for_events')).status, 'yield');
  assert.equal(f.store.db.prepare('SELECT since_seq FROM attention_waits').get().since_seq, 1);
  assert.equal(f.scenes.current().key, 'group:1'); assert.equal(f.events()[0].unread, 1);
  f.add('group:2', 'wake'); assert.equal((await f.call('qq_wait_for_events')).status, 'ready');
});

test('wake config preserves legacy defaults, unrelated preferences and ordinary unread; duplicate call cannot move alarm', async t => {
  const f = fixture(t), cap = await f.scenes.join('group:1');
  f.scenes.preferences('group:1', { unrelated: 'keep' }); f.add('group:1', 'message');
  const config = { mode: 'diving', infinite: false, sleepMs: 1000, triggers: { keywords: ['hello'] } };
  const first = await f.set(cap.capability, config, 'timer'); f.advance(500);
  assert.deepEqual(await f.set(cap.capability, config, 'timer'), first);
  assert.equal(f.timers().length, 1); assert.equal(f.timers()[0].due_at, f.now() + 500);
  assert.equal(f.attention.config('group:1').triggers.atMention, true);
  assert.equal(f.scenes.preferences('group:1').unrelated, 'keep'); assert.equal(f.events()[0].unread, 1);
  await assert.rejects(f.set(cap.capability, { infinite: true }, 'timer'), { code: 'ACTION_ID_CONFLICT' });
});

test('finite alarm materializes once, survives reopen, and cannot bypass peak or manual pause', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-attention-'));
  const file = path.join(dir, 'inbox.db'), f = fixture(t, file), cap = await f.scenes.join('group:1');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await f.set(cap.capability, { infinite: false, sleepMs: 60000 }); await f.scenes.quit();
  f.ctx.peakEnabled = true; f.advance(60000); f.attention.materialize(); assert.equal(f.events().length, 0);
  // Reopen the store to verify durability without starting a second runtime.
  const observer = new UnifiedStore(file); assert.equal(observer.db.prepare('SELECT due_at FROM wake_timers').get().due_at, f.now()); observer.close();
  f.advance(3 * 3600000); f.ctx.paused = true; f.attention.materialize(); assert.equal(f.events().length, 0);
  f.ctx.paused = false; f.attention.materialize(); f.attention.materialize();
  assert.equal(f.events().length, 1); assert.equal(f.events()[0].kind, 'wake-timer');
  assert.equal(f.store.account('100').current_scene, null);
});

test('switching infinite cancels only unnotified timer, not ordinary unread', async t => {
  const f = fixture(t), cap = await f.scenes.join('group:1'); f.add('group:1', 'message');
  await f.set(cap.capability, { infinite: false, sleepMs: 1 }, 'finite'); f.advance(1); f.attention.materialize();
  await f.set(cap.capability, { infinite: true }, 'infinite');
  assert.deepEqual(f.events().map(e => [e.kind, e.unread, e.wake]), [['message', 1, 1], ['wake-timer', 0, 0]]);
  assert.equal(f.timers().length, 0);
});

test('expired timer wakes once via normal scheduler, no repeat after completion and unread stays explicit', async t => {
  const f = fixture(t), cap = await f.scenes.join('group:1');
  await f.set(cap.capability, { infinite: false, sleepMs: 1 }); f.advance(1); f.attention.materialize();
  let prompts = 0;
  const scheduler = new UnifiedScheduler({ store: f.store, scenes: f.scenes, now: f.now,
    ensureSession: async x => x.sessionId, prompt: async () => { prompts++; return { result: { ok: true, value: { accepted: true } } }; } });
  const first = await scheduler.tick(); scheduler.confirm({ requestId: first.requestId, sessionId: 'main', outcome: 'completed' });
  f.attention.materialize(); assert.equal((await scheduler.tick()).status, 'idle');
  assert.equal(prompts, 1); assert.equal(f.events()[0].unread, 1);
});

test('pause during timer preflight does not consume alarm; retry after resume uses same event', async t => {
  const f = fixture(t), cap = await f.scenes.join('group:1');
  await f.set(cap.capability, { infinite: false, sleepMs: 1 }); f.advance(1); f.attention.materialize();
  let prompts = 0;
  const scheduler = new UnifiedScheduler({ store: f.store, scenes: f.scenes, now: f.now,
    ensureSession: async x => { f.ctx.paused = true; return x.sessionId; }, prompt: async () => { prompts++; } });
  assert.equal((await scheduler.tick()).status, 'deferred'); assert.equal(prompts, 0);
  assert.equal(f.events()[0].notified, 0); f.ctx.paused = false;
  scheduler.ensureSession = async x => x.sessionId;
  scheduler.prompt = async () => { prompts++; return { result: { ok: true, value: { accepted: true } } }; };
  assert.equal((await scheduler.tick()).status, 'accepted'); assert.equal(prompts, 1);
});

test('MCP validates sleep arguments, requires current capability and trusted call identity', async t => {
  const f = fixture(t), cap = await f.scenes.join('group:1');
  for (const config of [{ sleepMs: -1 }, { triggers: { probability: 2 } }, { ownerQQ: '200' }])
    await assert.rejects(f.set(cap.capability, config), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(f.set(cap.capability, { infinite: false }), { code: 'INVALID_ARGUMENTS' });
  f.disabled.add('setWakeConfig'); await assert.rejects(f.set(cap.capability, { infinite: true }, 'disabled'), { code: 'TOOL_DENIED' });
  f.disabled.clear(); await f.scenes.quit();
  await assert.rejects(f.set(cap.capability, { infinite: true }), { code: 'STALE_SCENE' });
});

test('editing triggers after an alarm fired does not re-arm it; configured sleep bounds still apply', async t => {
  const f = fixture(t), cap = await f.scenes.join('group:1');
  f.attention.sleepBounds = () => ({ sleepMinMs: 100, sleepMaxMs: 1000 });
  await f.set(cap.capability, { infinite: false, sleepMs: 1 }, 'first');
  assert.equal(f.timers()[0].due_at, f.now() + 100);
  f.advance(100); f.attention.materialize();
  const token = f.timers()[0].token;
  await f.set(cap.capability, { triggers: { probability: 0 } }, 'edit'); f.attention.materialize();
  assert.equal(f.timers()[0].token, token); assert.equal(f.events().length, 1);
  await f.set(cap.capability, { sleepMs: 10000 }, 'next');
  assert.equal(f.timers()[0].due_at, f.now() + 1000);
});

test('wall-clock rollback cannot extend the 12-second hard wait deadline', async t => {
  const f = fixture(t), cap = await f.scenes.join('group:1'); let elapsed = 0;
  f.attention.monotonic = () => elapsed;
  f.attention.sleep = async ms => { elapsed += ms; f.advance(-1000); };
  f.add('group:1', 'message');
  const result = await f.call('qq_wait_for_messages', { capability: cap.capability, quietMs: 12000 });
  assert.equal(result.elapsedMs, 12000); assert.equal(result.reason, 'timeout');
});

test('space never receives a stand-alone finite model wake timer', async t => {
  const f = fixture(t), cap = await f.scenes.join('qzone');
  await assert.rejects(f.set(cap.capability, { infinite: false, sleepMs: 1 }), { code: 'SCENE_DENIED' });
  assert.equal(f.timers().length, 0);
});
