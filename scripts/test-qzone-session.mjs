import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createQzoneAgent } from '../src/qzone-agent.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.json'), rows = [], archived = [], prompts = [];
  let worker, created = 0, mode = 'complete', model = 'applied', listFailure = false, allowed = true, loseCreate = false;
  const ok = (value) => ({ result: { ok: true, value } });
  const api = {
    workspace: { archiveSession: async ({ sessionId }) => { archived.push(sessionId); return ok({}); } },
    events: { follow() {}, forget() {} },
    sessions: {
      list: async () => { if (listFailure) throw Error('offline'); return ok({ items: rows }); },
      create: async ({ sessionId }) => {
        if (!rows.some((x) => x.sessionId === sessionId)) {
          created++;
          rows.push({ sessionId, agentPreset: 'qq-qzone', running: false });
        }
        if (loseCreate) throw Error('create response lost');
        return ok({ sessionId });
      },
      prompt: async ({ sessionId }) => {
        prompts.push(sessionId);
        if (mode === 'unknown') throw Error('socket reset');
        if (mode === 'reject') return { result: { ok: false, error: { message: 'rejected' } } };
        worker.onEvent(sessionId, { type: 'turn/start', data: { turn: 1 } });
        worker.onEvent(sessionId, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '{"post":null}' }] } } });
        worker.onEvent(sessionId, { type: 'turn/end', time: 1100, data: { turn: 1, reason: { kind: 'completed' } } });
        return ok({});
      },
    },
  };
  const restart = () => worker = createQzoneAgent({ api, file, now: () => 1000,
    ensureWorkspace: async () => 'ws', resolvePreset: () => 'qq-qzone', ensureModel: async () => model,
    assertAllowed() { if (!allowed) throw Error('paused'); }, role: () => '' });
  restart();
  return { file, rows, archived, prompts, restart, run: (qq = '1') => worker.decide({ accountQQ: qq }),
    count: () => created, mode: (v) => mode = v, model: (v) => model = v,
    failList: (v) => listFailure = v, allow: (v) => allowed = v,
    loseCreate: (v) => loseCreate = v,
    snapshot: (time) => worker.onSnapshot(rows[0].sessionId, { records: [{ type: 'event', event: { type: 'turn/end', time } }] }),
  };
}

test('completed space session survives restart, account switching and repeated decisions', async (t) => {
  const f = fixture(t);
  await f.run(); f.restart(); await f.run(); await f.run('2'); await f.run('1');
  assert.equal(f.count(), 2);
  assert.deepEqual(f.prompts, [f.rows[0].sessionId, f.rows[0].sessionId, f.rows[1].sessionId, f.rows[0].sessionId]);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).sessions.length, 2);
});
test('offline validation retains mapping and never creates replacement', async (t) => {
  const f = fixture(t); await f.run(); f.restart(); f.failList(true);
  await assert.rejects(f.run(), /offline/); assert.equal(f.count(), 1);
  f.failList(false); await f.run(); assert.equal(f.count(), 1);
});
test('only confirmed missing session is replaced', async (t) => {
  const f = fixture(t); await f.run(); f.rows.length = 0; f.restart(); await f.run();
  assert.equal(f.count(), 2); assert.notEqual(f.prompts[0], f.prompts[1]);
});
test('unsafe preset and running old turn both prevent reuse or new creation', async (t) => {
  const f = fixture(t); await f.run(); f.restart(); f.rows[0].agentPreset = 'qq-chat-v2-files';
  await assert.rejects(f.run(), /预设/); assert.equal(f.count(), 1);
  f.rows[0].agentPreset = 'qq-qzone'; f.rows[0].running = true;
  await assert.rejects(f.run(), /尚未结束/); assert.equal(f.prompts.length, 1);
  f.rows[0].running = false; await f.run(); assert.equal(f.count(), 1);
});
test('unknown dispatch survives restart; historical ends cannot unlock it or replay actions', async (t) => {
  const f = fixture(t); f.mode('unknown'); await assert.rejects(f.run(), /socket/);
  f.restart(); await assert.rejects(f.run(), /尚未确认/);
  f.snapshot(999); await assert.rejects(f.run(), /尚未确认/);
  assert.equal(f.count(), 1); assert.equal(f.prompts.length, 1);
  f.snapshot(1100); assert.equal(f.prompts.length, 1);
  f.mode('complete'); await f.run(); assert.equal(f.count(), 1);
});
test('explicit rejection does not leave durable in-flight lock', async (t) => {
  const f = fixture(t); f.mode('reject'); await assert.rejects(f.run());
  assert.equal(JSON.parse(fs.readFileSync(f.file)).sessions[0].inFlightAt, 0);
  f.restart(); f.mode('complete'); await f.run(); assert.equal(f.count(), 1);
});
test('model selection failure retains session; definitive invalidity archives it', async (t) => {
  const f = fixture(t); await f.run(); f.model('failed'); await assert.rejects(f.run(), /配置未成功/);
  assert.equal(f.count(), 1); assert.equal(f.archived.length, 0);
  f.model('not-found'); await assert.rejects(f.run(), /失效/);
  assert.deepEqual(f.archived, [f.rows[0].sessionId]);
  f.model('applied'); await f.run(); assert.equal(f.count(), 2);
});
test('lost create response is retried with the same durable ID after restart', async (t) => {
  const f = fixture(t); f.loseCreate(true); await assert.rejects(f.run(), /response lost/);
  assert.equal(f.count(), 1); assert.equal(f.prompts.length, 0);
  f.restart(); f.loseCreate(false); await f.run();
  assert.equal(f.count(), 1); assert.equal(f.prompts[0], f.rows[0].sessionId);
});
test('corrupt file is preserved; manual pause prevents all creation', async (t) => {
  const f = fixture(t); f.allow(false); await assert.rejects(f.run(), /paused/);
  assert.equal(f.count(), 0); f.allow(true);
  fs.writeFileSync(f.file, '{broken'); f.restart(); await assert.rejects(f.run(), /不可读/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken'); assert.equal(f.count(), 0);
  fs.writeFileSync(f.file, 'null'); f.restart(); await assert.rejects(f.run(), /损坏/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'null'); assert.equal(f.count(), 0);
});
