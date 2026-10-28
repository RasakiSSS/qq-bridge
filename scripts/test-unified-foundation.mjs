// New foundation only. All DSH/QQ calls are in-memory fakes; no production state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedScheduler } from '../src/unified/scheduler.js';

const time = (clock, day = '2026-10-28') => Date.parse(`${day}T${clock}:00+08:00`);
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const cfg = { account: '100', ownerQQ: '200', enabled: true, peakEnabled: true, identityEpoch: 1 };
  let now = time('08:59');
  const denied = new Set();
  let store = new UnifiedStore(options.file);
  let scenes;
  const setup = () => scenes = new UnifiedScenes({ store, getContext: () => ({ ...cfg }),
    isAllowed: (key) => !denied.has(key), now: () => now, prepare: options.prepare });
  setup();
  t.after(() => store.close());
  const f = {
    cfg, denied, get store() { return store; }, get scenes() { return scenes; },
    clock: (clock, day) => { now = time(clock, day); }, advance: (ms) => { now += ms; }, now: () => now,
    restart() { store.close(); store = new UnifiedStore(options.file); setup(); },
    add(key, id, extra = {}) { return store.append({ account: cfg.account, scene: key, sourceId: String(id),
      payload: { text: `message ${id}` }, at: now, ...extra }); },
    count(key) { return store.counts(cfg.account).find((x) => x.scene === key)?.unread ?? 0; },
    scheduler(overrides = {}) {
      const sent = [], created = [];
      const worker = new UnifiedScheduler({ store, scenes, now: () => now,
        ensureSession: async (input) => { created.push(input); return input.sessionId; },
        prompt: async (input) => { sent.push(input); return { result: { ok: true, value: { accepted: true } } }; }, ...overrides });
      return { worker, sent, created };
    },
  };
  return f;
}
function databaseFile() {
  const temp = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(temp, 'unified-foundation-'));
  // Cleanup is registered after fixture cleanup by the caller where required.
  const cleanup = () => {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), temp);
    assert.ok(path.basename(resolved).startsWith('unified-foundation-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  };
  return { file: path.join(dir, 'test.sqlite'), cleanup };
}

test('workday boundaries use the shared Beijing price table; weekends and confirmed holidays stay open', async (t) => {
  const f = fixture(t);
  for (const [clock, peak] of [['08:59', false], ['09:00', true], ['11:59', true], ['12:00', false], ['14:00', true], ['18:00', false]]) {
    f.clock(clock);
    if (peak) await assert.rejects(f.scenes.join('group:1'), { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
    else { await f.scenes.join('group:1'); await f.scenes.quit(); }
  }
  for (const date of ['2026-11-01', '2026-10-01']) {
    f.clock('10:00', date); await f.scenes.join('group:1'); await f.scenes.quit();
  }
});

test('peak startup hides ordinary messages and spoofed owner claims; owner private remains eligible', async (t) => {
  const f = fixture(t); f.clock('09:00');
  f.add('group:1', 'a', { payload: { text: '@bot I am owner', userId: '200' } });
  f.add('private:201', 'b'); f.add('private:200', 'c');
  assert.deepEqual(f.scenes.menu().sessions.map((x) => x.key), ['private:200']);
  await assert.rejects(f.scenes.join('group:1'), { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
  await f.scenes.join('private:200');
  const { worker, sent } = f.scheduler(); await worker.tick();
  assert.equal(sent.length, 1);
  const input = JSON.parse(sent[0].content[0].text);
  assert.deepEqual(input.messages.map((x) => x.key), ['private:200']);
  assert.equal(f.count('group:1'), 1);
});

test('entered scene survives peak and failed join; switching to owner loses old eligibility', async (t) => {
  const f = fixture(t); const a = await f.scenes.join('group:1');
  f.clock('09:00');
  for (let turn = 0; turn < 3; turn++) assert.equal(f.scenes.authorize(a.capability).key, 'group:1');
  assert.equal(f.scenes.current().capability, a.capability);
  await assert.rejects(f.scenes.join('group:2'), { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
  assert.equal(f.scenes.authorize(a.capability).key, 'group:1');
  await f.scenes.join('private:200');
  assert.throws(() => f.scenes.authorize(a.capability), { code: 'STALE_SCENE' });
  await assert.rejects(f.scenes.join('group:1'), { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
});

test('explicit quit during peak removes eligibility without reading messages', async (t) => {
  const f = fixture(t); f.add('group:1', 1); await f.scenes.join('group:1'); f.clock('09:00');
  await f.scenes.quit();
  assert.equal(f.count('group:1'), 1);
  await assert.rejects(f.scenes.join('group:1'), { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
});

test('join crossing peak rechecks before commit and leaves the previous scene intact', async (t) => {
  let wait = false; const gate = deferred(), entered = deferred();
  const f = fixture(t, { prepare: async () => { if (wait) { entered.resolve(); await gate.promise; } } });
  const original = await f.scenes.join('group:1'); wait = true;
  const joining = f.scenes.join('group:2'); await entered.promise;
  f.clock('09:00'); gate.resolve();
  await assert.rejects(joining, { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
  assert.equal(f.scenes.authorize(original.capability).key, 'group:1');
});

test('concurrent joins serialize; only the final scene capability can send', async (t) => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.scenes.join('group:1'), f.scenes.join('group:2')]);
  assert.throws(() => f.scenes.authorize(a.capability), { code: 'STALE_SCENE' });
  assert.equal(f.scenes.authorize(b.capability).key, 'group:2');
});

test('scene change during a batch stops remaining pieces and never redirects the first', async (t) => {
  const f = fixture(t); const cap = await f.scenes.join('group:1'); const actual = [];
  const result = await f.scenes.send(cap.capability, ['one', 'two'], async (input) => {
    actual.push(input); await f.scenes.join('group:2'); return 'sent';
  });
  assert.deepEqual(actual.map((x) => x.key), ['group:1']);
  assert.equal(result.results.length, 1); assert.equal(result.error, 'STALE_SCENE');
});

test('pause and ACL revocation stop actual dispatch, including already entered peak scenes', async (t) => {
  const f = fixture(t); const cap = await f.scenes.join('group:1'); f.clock('09:00');
  f.scenes.setPaused(true); f.clock('12:00');
  assert.throws(() => f.scenes.authorize(cap.capability), { code: 'PAUSED' });
  const { worker, sent } = f.scheduler(); f.add('private:200', 1);
  assert.equal((await worker.tick()).status, 'paused'); assert.equal(sent.length, 0);
  f.scenes.setPaused(false); f.denied.add('group:1');
  assert.throws(() => f.scenes.authorize(cap.capability), { code: 'STALE_SCENE' });
  f.denied.clear(); f.clock('14:00');
  await assert.rejects(f.scenes.join('group:1'), { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
});

test('disabled peak schedule restores ordinary admission and global levels apply without recreating scenes', async (t) => {
  const f = fixture(t); f.clock('09:00'); f.cfg.peakEnabled = false;
  const cap = await f.scenes.join('group:1');
  assert.equal(f.scenes.active().permission, 'v3');
  f.scenes.setPermission('v1');
  assert.equal(f.scenes.authorize(cap.capability).key, 'group:1');
  assert.throws(() => f.scenes.authorize(cap.capability, 'v2'), { code: 'PERMISSION_DENIED' });
  assert.throws(() => f.scenes.active(undefined, 'v3'), { code: 'PERMISSION_DENIED' });
  f.scenes.setPermission('v2'); assert.equal(f.scenes.active(undefined, 'v2').permission, 'v2');
  assert.throws(() => f.scenes.setPermission('__proto__'), { code: 'INVALID_PERMISSION' });
});

test('identity changes revoke old capabilities, including account round trips', async (t) => {
  const f = fixture(t); const first = await f.scenes.join('group:1');
  f.cfg.ownerQQ = '201'; assert.throws(() => f.scenes.authorize(first.capability), { code: 'STALE_SCENE' });
  const second = f.scenes.current();
  f.cfg.account = '101'; f.scenes.state(); f.cfg.account = '100';
  assert.throws(() => f.scenes.authorize(second.capability), { code: 'STALE_SCENE' });
});

test('85 unread messages are durable data, not a 30-item queue; receipts only mark selected batches', async (t) => {
  const f = fixture(t); for (let i = 1; i <= 85; i++) f.add('group:1', i);
  assert.equal(f.scenes.menu().sessions[0].unread, 85);
  const cap = await f.scenes.join('group:1');
  for (const [size, remaining] of [[30, 55], [30, 25], [25, 0]]) {
    const batch = f.scenes.read(cap.capability);
    assert.equal(batch.messages.length, size);
    assert.equal(f.scenes.markRead(batch.receipt).marked, size);
    assert.equal(f.scenes.markRead(batch.receipt).marked, 0);
    assert.equal(f.count('group:1'), remaining);
  }
});

test('menu skip affects its exact snapshot and scene; arrivals after snapshot stay unread', (t) => {
  const f = fixture(t); for (let i = 0; i < 30; i++) f.add('group:1', i);
  f.add('group:2', 1);
  const snap = f.scenes.menu().sessions.find((x) => x.key === 'group:1');
  for (let i = 30; i < 35; i++) f.add('group:1', i);
  assert.deepEqual(f.scenes.markRead(snap.skipReceipt), { marked: 30, reason: 'intentional-skip' });
  assert.equal(f.count('group:1'), 5); assert.equal(f.count('group:2'), 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 36);
});

test('menu summary keeps current scene and cannot mark unread before result delivery', async (t) => {
  const f = fixture(t); const cap = await f.scenes.join('group:2');
  for (let i = 0; i < 85; i++) f.add('group:1', i);
  const task = f.scenes.summary('group:1');
  assert.equal(task.messages.length, 30);
  assert.throws(() => f.scenes.markRead(task.job), { code: 'RECEIPT_NOT_DELIVERED' });
  f.scenes.saveSummary(task.job, { result: { text: 'summary of exact batch' }, coveredSeqs: task.messages.map((x) => x.seq) });
  assert.throws(() => f.scenes.markRead(task.job), { code: 'RECEIPT_NOT_DELIVERED' });
  f.scenes.takeSummary(task.job); f.scenes.markRead(task.job);
  assert.equal(f.count('group:1'), 55); assert.equal(f.scenes.authorize(cap.capability).key, 'group:2');
  assert.throws(() => f.scenes.authorize(task.job), { code: 'STALE_SCENE' });
});

test('late summary and old menu snapshot cannot reveal or consume hidden peak messages', (t) => {
  const f = fixture(t); f.add('group:1', 1);
  const snap = f.scenes.menu().sessions[0], task = f.scenes.summary('group:1');
  f.clock('09:00'); f.scenes.saveSummary(task.job, { result: { text: 'done' }, coveredSeqs: task.messages.map((x) => x.seq) });
  assert.throws(() => f.scenes.takeSummary(task.job), { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
  assert.throws(() => f.scenes.markRead(snap.skipReceipt), { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
  assert.deepEqual(f.scenes.menu().sessions, []); assert.equal(f.count('group:1'), 1);
  f.clock('12:00'); f.scenes.takeSummary(task.job); f.scenes.markRead(task.job); assert.equal(f.count('group:1'), 0);
});

test('out-of-order receipt confirmation never jumps over an unread gap', (t) => {
  const f = fixture(t);
  const a = f.add('group:1', 'a').event, b = f.add('group:1', 'b').event, c = f.add('group:1', 'c').event;
  const receipt = f.store.transaction(() => f.store.receipt('100', 'group:1', 'read', [c], f.now()));
  f.scenes.markRead(receipt);
  assert.deepEqual(f.store.unread('100', 'group:1').map((x) => x.seq), [a.seq, b.seq]);
});

test('event identity includes account, scene, source id and kind; repeated arrival does not revive read events', (t) => {
  const f = fixture(t); f.add('group:1', 1);
  f.scenes.markRead(f.scenes.menu().sessions[0].skipReceipt);
  assert.equal(f.add('group:1', 1).inserted, false); assert.equal(f.count('group:1'), 0);
  assert.equal(f.add('group:1', 1, { kind: 'comment' }).inserted, true);
  assert.equal(f.add('group:2', 1).inserted, true);
  f.cfg.account = '101'; assert.equal(f.add('group:1', 1).inserted, true);
});

test('restart preserves paused state, level, scene, unread and preferences while replacing bearer credentials', async (t) => {
  const disk = databaseFile(t);
  const f = fixture(t, disk); t.after(disk.cleanup);
  f.add('group:1', 1); const cap = await f.scenes.join('group:1');
  f.scenes.preferences('group:1', { sleep: 'forever' }); f.scenes.setPermission('v1'); f.scenes.setPaused(true);
  f.restart(); f.clock('12:00'); assert.throws(() => f.scenes.current(), { code: 'PAUSED' });
  f.scenes.setPaused(false); f.clock('14:00'); const restored = f.scenes.current();
  assert.equal(restored.key, 'group:1'); assert.notEqual(restored.capability, cap.capability);
  assert.equal(f.scenes.active().permission, 'v1'); assert.equal(f.count('group:1'), 1);
  assert.deepEqual(f.scenes.preferences('group:1'), { sleep: 'forever' });
  await f.scenes.quit(); f.restart(); assert.equal(f.scenes.current(), null);
  await assert.rejects(f.scenes.join('group:1'), { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
});

test('foreign/corrupt/newer databases fail closed without resetting them', (t) => {
  const disk = databaseFile(t); t.after(disk.cleanup);
  fs.writeFileSync(disk.file, 'not sqlite'); const before = fs.readFileSync(disk.file);
  assert.throws(() => new UnifiedStore(disk.file)); assert.deepEqual(fs.readFileSync(disk.file), before);
  const foreign = path.join(path.dirname(disk.file), 'foreign.sqlite');
  const db = new DatabaseSync(foreign); db.exec('CREATE TABLE important(data TEXT);'); db.close();
  assert.throws(() => new UnifiedStore(foreign), { code: 'INVALID_STORE' });
  const newer = path.join(path.dirname(disk.file), 'newer.sqlite'); const s = new UnifiedStore(newer);
  s.db.exec('PRAGMA user_version=2'); s.close();
  assert.throws(() => new UnifiedStore(newer), { code: 'INVALID_STORE' });
});

test('concurrent scheduler ticks yield one prompt and cannot start a second main turn before terminal evidence', async (t) => {
  const f = fixture(t); f.add('group:1', 1);
  const { worker, sent } = f.scheduler();
  const results = await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
  assert.equal(sent.length, 1); assert.ok(results.some((x) => x.status === 'accepted'));
  f.add('group:2', 2); await worker.tick(); assert.equal(sent.length, 1);
  assert.throws(() => worker.confirm({ requestId: 'old-event', sessionId: sent[0].sessionId, outcome: 'completed' }), { code: 'INVALID_CONFIRMATION' });
  worker.confirm({ requestId: sent[0].requestId, sessionId: sent[0].sessionId, outcome: 'completed' });
  await worker.tick(); assert.equal(sent.length, 2); assert.equal(sent[0].sessionId, sent[1].sessionId);
  assert.equal(f.count('group:1'), 1); // Delivery is not read acknowledgement.
});

test('separate scheduler objects sharing the ledger still claim only one active request', async (t) => {
  const f = fixture(t); f.add('group:1', 1);
  const a = f.scheduler(), b = f.scheduler(); await Promise.all([a.worker.tick(), b.worker.tick()]);
  assert.equal(a.sent.length + b.sent.length, 1);
});

test('peak backlog stays unnotified until valley; manual pause remains in force', async (t) => {
  const f = fixture(t); f.clock('09:00'); f.add('group:1', 1);
  const { worker, sent } = f.scheduler(); await worker.tick(); assert.equal(sent.length, 0);
  f.scenes.setPaused(true); f.clock('12:00'); await worker.tick(); assert.equal(sent.length, 0);
  f.scenes.setPaused(false); await worker.tick(); assert.equal(sent.length, 1);
  worker.confirm({ requestId: sent[0].requestId, sessionId: sent[0].sessionId, outcome: 'completed' });
  await worker.tick(); assert.equal(sent.length, 1); assert.equal(f.count('group:1'), 1);
});

test('async session preparation crossing peak or changing owner cancels admission without advancing unread', async (t) => {
  for (const change of ['peak', 'owner', 'account', 'epoch', 'pause']) {
    const f = fixture(t); f.add('group:1', 1); const sent = [];
    const { worker } = f.scheduler({ ensureSession: async (input) => {
      if (change === 'peak') f.clock('09:00');
      if (change === 'owner') f.cfg.ownerQQ = '201';
      if (change === 'account') f.cfg.account = '101';
      if (change === 'epoch') f.cfg.identityEpoch++;
      if (change === 'pause') f.scenes.setPaused(true);
      return input.sessionId;
    }, prompt: async (input) => sent.push(input) });
    assert.equal((await worker.tick()).status, 'deferred'); assert.equal(sent.length, 0);
    assert.equal(f.store.unread('100', 'group:1').length, 1);
  }
});

test('unknown submission blocks after restart; matching evidence unlocks without replaying the old prompt', async (t) => {
  const disk = databaseFile(t); const f = fixture(t, disk); t.after(disk.cleanup);
  f.add('group:1', 1); let input;
  const first = f.scheduler({ prompt: async (value) => { input = value; throw Error('socket reset'); } });
  assert.equal((await first.worker.tick()).status, 'unknown');
  f.restart(); const second = f.scheduler();
  assert.equal((await second.worker.tick()).status, 'unknown'); assert.equal(second.sent.length, 0);
  second.worker.confirm({ requestId: input.requestId, sessionId: input.sessionId, outcome: 'completed' });
  await second.worker.tick(); assert.equal(second.sent.length, 0);
  f.add('group:1', 2); await second.worker.tick();
  assert.equal(second.sent.length, 1); assert.equal(second.sent[0].sessionId, input.sessionId);
});

test('lost create response keeps the same stored session identity and applies backoff', async (t) => {
  const f = fixture(t); f.clock('08:00'); f.add('group:1', 1); const ids = []; let fail = true;
  const { worker, sent } = f.scheduler({ ensureSession: async (input) => {
    ids.push(input.sessionId); if (fail) throw Error('create response lost'); return input.sessionId;
  } });
  assert.equal((await worker.tick()).status, 'deferred'); await worker.tick(); assert.equal(ids.length, 1);
  fail = false; f.advance(60001); await worker.tick(); assert.equal(sent.length, 1);
  assert.equal(ids[0], ids[1]);
});

test('explicit prompt rejection backs off without marking unread or notified', async (t) => {
  const f = fixture(t); f.clock('08:00'); f.add('group:1', 1); let calls = 0;
  const { worker } = f.scheduler({ prompt: async () => { calls++; return { result: { ok: false, error: { code: 'busy' } } }; } });
  assert.equal((await worker.tick()).status, 'rejected'); await worker.tick(); assert.equal(calls, 1);
  assert.equal(f.count('group:1'), 1); assert.equal(f.store.unread('100', 'group:1')[0].notified, 0);
  f.advance(60001); await worker.tick(); assert.equal(calls, 2);
});

test('terminal event arriving before prompt response is never downgraded to accepted', async (t) => {
  const f = fixture(t); f.add('group:1', 1); let worker;
  ({ worker } = f.scheduler({ prompt: async (input) => {
    worker.confirm({ requestId: input.requestId, sessionId: input.sessionId, outcome: 'completed' });
    return { result: { ok: true, value: { accepted: true } } };
  } }));
  assert.equal((await worker.tick()).status, 'completed'); await worker.tick();
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM dispatches').get().n, 1);
});

test('preview receipt cannot mark a truncated or media-bearing message as read', async (t) => {
  const f = fixture(t); f.add('group:1', 1); f.add('group:1', 2, { payload: { text: 'x'.repeat(1000) } });
  f.add('group:1', 3, { payload: { text: 'photo', media: ['fixture'] } });
  const { worker, sent } = f.scheduler(); await worker.tick();
  const input = JSON.parse(sent[0].content[0].text);
  assert.deepEqual(input.messages.map((x) => x.partial), [false, true, true]);
  assert.equal(f.scenes.markRead(input.receipts[0].receipt).marked, 1);
  assert.equal(f.count('group:1'), 2);
});

test('stale/read wake candidates after async prepare do not generate another prompt', async (t) => {
  const f = fixture(t); f.add('group:1', 1);
  const { worker, sent } = f.scheduler({ ensureSession: async (input) => {
    f.scenes.markRead(f.scenes.menu().sessions[0].skipReceipt); return input.sessionId;
  } });
  assert.equal((await worker.tick()).status, 'deferred'); assert.equal(sent.length, 0);
});

test('transaction failure rolls back receipt and account mutations', (t) => {
  const f = fixture(t); f.add('group:1', 1);
  assert.throws(() => f.store.transaction(() => {
    f.store.db.prepare("UPDATE accounts SET permission='v1' WHERE account='100'").run();
    f.store.receipt('100', 'group:1', 'read', [{ seq: 999 }], f.now());
  }), { code: 'INVALID_RECEIPT_RANGE' });
  assert.equal(f.store.account('100').permission, 'v3');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n, 0);
});

test('partial summary confirms only its covered messages, rejects foreign ranges and remains idempotent', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) f.add('group:1', i);
  const other = f.add('group:2', 1).event;
  const job = f.scenes.summary('group:1');
  assert.throws(() => f.scenes.saveSummary(job.job, { result: {}, coveredSeqs: [job.messages[0].seq, other.seq] }), { code: 'INVALID_SUMMARY_RANGE' });
  assert.equal(f.store.db.prepare('SELECT SUM(covered) AS n FROM receipt_events WHERE receipt=?').get(job.job).n, 0);
  assert.equal(f.scenes.saveSummary(job.job, { result: { text: 'only last message' }, coveredSeqs: [job.messages[2].seq] }), true);
  assert.equal(f.scenes.saveSummary(job.job, { result: {}, coveredSeqs: job.messages.map((x) => x.seq) }), false);
  f.scenes.takeSummary(job.job); assert.equal(f.scenes.markRead(job.job).marked, 1);
  assert.deepEqual(f.store.unread('100', 'group:1').map((x) => x.seq), job.messages.slice(0, 2).map((x) => x.seq));
  assert.equal(f.scenes.markRead(job.job).marked, 0); assert.equal(f.count('group:2'), 1);
});

test('summary result ready before a restart is not read until delivered and explicitly acknowledged', (t) => {
  const disk = databaseFile(); const f = fixture(t, disk); t.after(disk.cleanup);
  f.add('group:1', 1); const job = f.scenes.summary('group:1');
  f.scenes.saveSummary(job.job, { result: { text: 'saved' }, coveredSeqs: job.messages.map((x) => x.seq) });
  f.restart(); assert.equal(f.count('group:1'), 1);
  assert.throws(() => f.scenes.markRead(job.job), { code: 'RECEIPT_NOT_DELIVERED' });
  assert.deepEqual(f.scenes.takeSummary(job.job).result, { text: 'saved' });
  f.scenes.markRead(job.job); assert.equal(f.count('group:1'), 0);
});

test('capabilities, menu receipts and worker receipts cannot be interchanged or used by another account', async (t) => {
  const f = fixture(t); f.add('group:1', 1); const cap = await f.scenes.join('group:1');
  const receipt = f.scenes.menu().sessions[0].skipReceipt;
  assert.throws(() => f.scenes.authorize(receipt), { code: 'STALE_SCENE' });
  assert.throws(() => f.scenes.markRead(cap.capability), { code: 'INVALID_RECEIPT' });
  f.cfg.account = '101';
  assert.throws(() => f.scenes.markRead(receipt), { code: 'INVALID_RECEIPT' });
});

test('each scene batch piece rechecks pause and reports the already sent portion', async (t) => {
  const f = fixture(t); const cap = await f.scenes.join('qzone');
  let calls = 0;
  const result = await f.scenes.send(cap.capability, ['one', 'two'], async () => {
    calls++; f.scenes.setPaused(true); return { id: 'already-sent' };
  });
  assert.equal(calls, 1); assert.equal(result.results[0].key, 'qzone');
  assert.equal(result.error, 'PAUSED');
});

test('peak current-scene wake runs multiple main turns without re-entering', async (t) => {
  const f = fixture(t); const cap = await f.scenes.join('group:1'); f.clock('09:00');
  const { worker, sent } = f.scheduler();
  for (let i = 0; i < 3; i++) {
    f.add('group:1', i); f.add('group:2', i);
    await worker.tick(); assert.equal(sent.length, i + 1);
    const last = sent.at(-1);
    assert.equal(JSON.parse(last.content[0].text).messages.every((m) => m.key === 'group:1'), true);
    worker.confirm({ requestId: last.requestId, sessionId: last.sessionId, outcome: 'completed' });
    assert.equal(f.scenes.authorize(cap.capability).key, 'group:1');
  }
  assert.equal(f.count('group:2'), 3);
});

test('no wake preference means inbox retention without an automatic prompt', async (t) => {
  const f = fixture(t); f.add('group:1', 1, { wake: false });
  const { worker, sent } = f.scheduler(); await worker.tick();
  assert.equal(sent.length, 0); assert.equal(f.scenes.menu().sessions[0].unread, 1);
});

test('preparing recovery is explicit; dispatching and accepted requests remain blocked after crash', (t) => {
  const f = fixture(t); f.add('group:1', 1); const { worker } = f.scheduler();
  const row = worker.claim(f.scenes.context()); assert.equal(f.store.active('100').status, 'preparing');
  assert.equal(worker.recoverPreparing('100'), 1);
  assert.equal(f.store.dispatch(row.id).status, 'deferred'); assert.equal(f.count('group:1'), 1);
  const retry = worker.claim(f.scenes.context()); assert.equal(retry.session_id, row.session_id);
  f.store.db.prepare("UPDATE dispatches SET status='dispatching' WHERE id=?").run(retry.id);
  assert.equal(worker.recoverPreparing('100'), 0); assert.equal(f.store.active('100').status, 'dispatching');
});

test('malformed acceptance response is uncertain and cannot auto-replay', async (t) => {
  const f = fixture(t); f.add('group:1', 1); let calls = 0;
  const { worker } = f.scheduler({ prompt: async () => { calls++; return { result: { ok: true, value: {} } }; } });
  assert.equal((await worker.tick()).status, 'unknown'); await worker.tick(); assert.equal(calls, 1);
});

test('local confirmation failure after accepted submission is uncertain, not a new retry', async (t) => {
  const f = fixture(t); f.add('group:1', 1); const { worker, sent } = f.scheduler();
  f.store.confirm = () => { throw Error('fixture receipt failure'); };
  assert.equal((await worker.tick()).status, 'unknown'); await worker.tick(); assert.equal(sent.length, 1);
});

test('completed evidence wins even if the eventual response is lost or rejected', async (t) => {
  for (const mode of ['throw', 'reject']) {
    const f = fixture(t); f.add('group:1', 1); let worker;
    ({ worker } = f.scheduler({ prompt: async (input) => {
      worker.confirm({ requestId: input.requestId, sessionId: input.sessionId, outcome: 'completed' });
      if (mode === 'throw') throw Error('lost');
      return { result: { ok: false, error: { code: 'late' } } };
    } }));
    assert.equal((await worker.tick()).status, 'completed');
    assert.equal(f.store.account('100').retry_at, 0);
  }
});

test('large multibyte and escaped message batches fit the model budget without consuming truncated originals', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) f.add('group:1', i, { payload: { text: (i % 2 ? '鲸' : '\u0001').repeat(400) } });
  const { worker, sent } = f.scheduler(); assert.equal((await worker.tick()).status, 'accepted');
  assert.ok(Buffer.byteLength(sent[0].content[0].text) <= 32768);
  const input = JSON.parse(sent[0].content[0].text);
  assert.ok(input.messages.some((x) => x.partial));
  for (const receipt of input.receipts) f.scenes.markRead(receipt.receipt);
  assert.equal(f.count('group:1'), input.messages.filter((x) => x.partial).length);
  for (const e of f.store.unread('100', 'group:1')) assert.equal(JSON.parse(e.payload).text.length, 400);
});

test('two SQLite connections share the active-dispatch exclusion constraint', async (t) => {
  const disk = databaseFile(); const a = fixture(t, disk), b = fixture(t, disk); t.after(disk.cleanup);
  a.add('group:1', 1); const x = a.scheduler(), y = b.scheduler();
  await Promise.all([x.worker.tick(), y.worker.tick()]);
  assert.equal(x.sent.length + y.sent.length, 1);
});

test('large inbox events page by bytes without losing their full payload or acknowledging the next page', async (t) => {
  const f = fixture(t); const text = '鲸'.repeat(40000);
  f.add('group:1', 1, { payload: { text } }); f.add('group:1', 2, { payload: { text } });
  const cap = await f.scenes.join('group:1'); const page = f.scenes.read(cap.capability);
  assert.equal(page.messages.length, 1); assert.equal(page.messages[0].payload.text, text); assert.equal(page.remaining, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 196608);
  f.scenes.markRead(page.receipt); assert.equal(f.count('group:1'), 1);
  const next = f.scenes.read(cap.capability); assert.equal(next.messages[0].payload.text, text); assert.equal(next.remaining, 0);
});

test('identity epoch catches a transient owner/account change during join preparation', async (t) => {
  const gate = deferred(), entered = deferred();
  const f = fixture(t, { prepare: async () => { entered.resolve(); await gate.promise; } });
  const joining = f.scenes.join('group:1'); await entered.promise;
  f.cfg.identityEpoch++; gate.resolve();
  await assert.rejects(joining, { code: 'IDENTITY_CHANGED' }); assert.equal(f.scenes.current(), null);
});

test('retry becoming due at peak does not bypass the entry policy', async (t) => {
  const f = fixture(t); f.add('group:1', 1); let calls = 0;
  const { worker } = f.scheduler({ prompt: async () => { calls++; return { result: { ok: false } }; } });
  await worker.tick(); assert.equal(calls, 1);
  f.advance(60001); await worker.tick(); assert.equal(calls, 1);
  f.clock('12:00'); await worker.tick(); assert.equal(calls, 2);
});

test('current wake preferences are rechecked after preparation, not fixed forever at message arrival', async (t) => {
  const f = fixture(t); f.add('group:1', 1); let eligible = true;
  const { worker, sent } = f.scheduler({ isWakeAllowed: () => eligible, ensureSession: async (input) => {
    eligible = false; return input.sessionId;
  } });
  assert.equal((await worker.tick()).status, 'deferred'); await worker.tick();
  assert.equal(sent.length, 0); assert.equal(f.count('group:1'), 1);
});

test('a dispatch callback throwing after invocation reports uncertain action instead of claiming no send', async (t) => {
  const f = fixture(t); const cap = await f.scenes.join('group:1'); let calls = 0;
  const result = await f.scenes.send(cap.capability, ['one', 'two'], async () => { calls++; throw Error('transport lost'); });
  assert.equal(result.uncertain, true); assert.equal(result.stopped, true); assert.equal(calls, 1);
  const denied = await f.scenes.send('invalid', ['one'], async () => { calls++; });
  assert.equal(denied.uncertain, false); assert.equal(calls, 1);
});
