import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSharedMemory, sharedMemoryConfig } from '../src/shared-memory.js';
import { createMemoryWorker } from '../src/shared-memory-worker.js';
import * as denyTools from '../plugins/qq-agent-presets/qq-memory-no-tools.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-worker-'));
  let clock = 1800000000000, blocked = false, account = '9', mode = 'success', during = null;
  const memory = createSharedMemory({ file: path.join(dir, 'memory.sqlite'), now: () => clock });
  t.after(() => { memory.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  memory.record({ accountQQ: '9', actorQQ: '123', source: 'group:456', externalId: 'a', text: '明天考试' });
  const calls = { created: [], prompts: [], follows: [], forgotten: [], archived: [] }, logs = [];
  const config = sharedMemoryConfig({ intervalMs: 60000 });
  const ok = (value) => ({ result: { ok: true, value } });
  let worker;
  const end = (sid, text = '{"notes":[]}', kind = 'completed') => {
    worker.onEvent(sid, { type: 'turn/start', data: { turn: 1 } });
    worker.onEvent(sid, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text }] } } });
    worker.onEvent(sid, { type: 'turn/end', data: { turn: 1, reason: { kind } } });
  };
  const api = { workspace: { archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return ok({}); } },
    events: { follow: (sid) => calls.follows.push(sid), forget: (sid) => calls.forgotten.push(sid) },
    sessions: {
      create: async (params) => { calls.created.push(params); return ok({ sessionId: 's-' + calls.created.length }); },
      prompt: async (params) => {
        calls.prompts.push(params);
        if (mode === 'reject') return { result: { ok: false, error: { code: 'rejected', message: 'fixture' } } };
        if (mode === 'unknown') throw Error('connection lost');
        if (mode === 'pending') return ok({});
        end(params.sessionId, mode === 'invalid' ? '{"notes":[{"kind":"fact","text":"错误","evidenceIds":["fake"]}]}' : '{"notes":[]}');
        return ok({});
      },
    } };
  const opts = { api, memory, getConfig: () => config, getAccount: () => account,
    ensureWorkspace: async () => { if (during === 'workspace') blocked = true; return 'QQ-workspace'; },
    resolvePreset: () => 'qq-memory', ensureModel: async () => { if (during === 'model') blocked = true; if (during === 'identity') account = '10'; return 'applied'; },
    assertAllowed: () => { if (blocked) throw Error('paused/peak'); }, now: () => clock, log: (s) => logs.push(s) };
  const restart = () => { worker = createMemoryWorker(opts); return worker; };
  restart();
  return { memory, calls, config, end, logs, opts, worker, restart,
    tick: (ms = 60000) => { clock += ms; }, block: (v) => { blocked = v; }, mode: (v) => { mode = v; }, during: (v) => { during = v; } };
}

test('bounded fresh sessions share QQ workspace, archive after success, no batch replay after restart', async (t) => {
  const f = fixture(t);
  await f.worker.tick();
  assert.deepEqual(f.calls.created, [{ workspaceId: 'QQ-workspace', agentPreset: 'qq-memory' }]);
  assert.equal(f.calls.prompts.length, 1); assert.ok(f.calls.prompts[0].content[0].text.length < 23000);
  assert.equal(f.calls.archived.length, 1);
  assert.deepEqual(f.calls.forgotten, ['s-1']);
  f.tick(); await f.restart().tick(); assert.equal(f.calls.prompts.length, 1);
  f.memory.record({ accountQQ: '9', actorQQ: '123', source: 'private:123', externalId: 'b', text: '考完了' });
  f.tick(); await f.restart().tick();
  assert.equal(f.calls.prompts.length, 2); assert.notEqual(f.calls.prompts[0].sessionId, f.calls.prompts[1].sessionId);
});

test('pause/peak, disabled, disabled consolidation, and async identity/guard changes prevent dispatch', async (t) => {
  for (const stage of ['before', 'workspace', 'model', 'identity', 'enabled', 'consolidate']) {
    const f = fixture(t);
    if (stage === 'before') f.block(true);
    else if (['enabled', 'consolidate'].includes(stage)) f.config[stage] = false;
    else f.during(stage);
    await f.worker.tick(); assert.equal(f.calls.prompts.length, 0, stage);
  }
});

test('unknown transport survives restart and timeout; snapshot terminal unlocks without duplicate model calls', async (t) => {
  const f = fixture(t); f.mode('unknown'); await f.worker.tick();
  f.tick(900000); const restored = f.restart(); await restored.tick(); await restored.tick();
  assert.equal(f.calls.prompts.length, 1); assert.equal(restored.status().waitingForEnd, true);
  restored.onSnapshot('s-1', { records: [
    { type: 'event', event: { type: 'turn/start', data: { turn: 1 } } },
    { type: 'event', event: { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '{"notes":[]}' }] } } } },
    { type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
  ] });
  assert.equal(restored.status().running, false); assert.equal(f.memory.batch('9').events.length, 0);
});

test('explicit rejection and invalid output retain batch and back off instead of looping', async (t) => {
  for (const mode of ['reject', 'invalid']) {
    const f = fixture(t); f.mode(mode); await f.worker.tick();
    assert.equal(f.memory.batch('9').events.length, 1);
    await f.worker.tick(); assert.equal(f.calls.prompts.length, 1);
    f.mode('success'); f.tick(); await f.worker.tick(); assert.equal(f.calls.prompts.length, 2);
    assert.equal(f.memory.batch('9').events.length, 0);
  }
});

test('completed in-flight job may finish during peak and ordinary duplicate events do not rewrite it', async (t) => {
  const f = fixture(t); f.mode('pending'); await f.worker.tick(); f.block(true);
  const event = f.memory.batch('9').events[0];
  f.end('s-1', JSON.stringify({ notes: [{ kind: 'fact', personQQ: '123', text: '说明天考试', evidenceIds: [event.id] }] }));
  assert.equal(f.memory.recall('9').notes.length, 1);
  f.end('s-1', '{"notes":[]}');
  assert.equal(f.memory.recall('9').notes.length, 1);
  await f.worker.tick(); assert.equal(f.calls.prompts.length, 1);
});

test('memory preset execution guard denies all tools, including QQ and admin filesystem', () => {
  let guard; denyTools.apply({ tools: { guard: (fn) => { guard = fn; } } });
  for (const name of ['mcp__snowluma__qq_send_message', 'mcp__filesystem__read_file', 'bash', 'compress', 'ask_user_question', 'unknown']) assert.equal(typeof guard({ name }), 'string');
});

test('real bridge consolidation guard uses ordinary peak policy and preserves manual pause', async () => {
  let clock = Date.parse('2026-10-23T09:00:00+08:00');
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const h = await bridgeHarness({ config: { socialV2: { peakSleep: { enabled: true } } }, globals: { Date: Clock } });
  h.setMode('reserved2'); h.setSelfIdentity('鲸鱼', '9');
  try {
    assert.throws(h.assertMemoryModelAllowed);
    clock = Date.parse('2026-10-23T12:00:00+08:00'); assert.doesNotThrow(h.assertMemoryModelAllowed);
    h.socialV2.paused = true; assert.throws(h.assertMemoryModelAllowed); assert.equal(h.socialV2.paused, true);
    h.socialV2.paused = false; h.setMode('chat'); assert.throws(h.assertMemoryModelAllowed);
    h.setMode('reserved2'); h.cfg.socialV2.tools.memory = false; assert.throws(h.assertMemoryModelAllowed);
  } finally { await h.close(); }
});

test('missing restricted preset and failed model selection never dispatch', async (t) => {
  for (const failure of ['preset', 'model']) {
    const f = fixture(t);
    if (failure === 'preset') f.opts.resolvePreset = () => 'qq-chat-v2';
    else f.opts.ensureModel = async () => 'unavailable';
    await f.restart().tick();
    assert.equal(f.calls.prompts.length, 0);
    assert.equal(f.memory.batch('9').events.length, 1);
  }
});
