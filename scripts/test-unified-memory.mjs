import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedMemory } from '../src/shared-memory.js';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedActions } from '../src/unified/actions.js';
import { UnifiedTools } from '../src/unified/tools.js';
import { UnifiedMemory } from '../src/unified/memory.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-memory-'));
  const memory = createSharedMemory({ file: path.join(dir, 'memory.sqlite') });
  const store = new UnifiedStore();
  t.after(() => { store.close(); memory.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ctx = { account: '100', ownerQQ: '200', enabled: true, peakEnabled: false };
  let allowed = true, denied = '';
  const scenes = new UnifiedScenes({ store, getContext: () => ctx, isAllowed: key => key !== denied,
    now: () => Date.parse('2026-10-27T02:00:00Z') });
  store.account('100'); store.db.prepare("UPDATE accounts SET session_id='main'").run();
  const adapter = new UnifiedMemory({ scenes, memory, policy: () => { if (!allowed) throw Object.assign(Error(), { code: 'ACTION_DENIED' }); } });
  const actions = new UnifiedActions({ store, scenes, handlers: { remember: adapter.handler() } });
  const tools = new UnifiedTools({ scenes, actions, memory: adapter }), token = tools.issueMainCredential();
  return { memory, store, ctx, scenes, tools, disable: () => allowed = false, deny: key => denied = key,
    record: (source, externalId, text, accountQQ = '100') => memory.record({ accountQQ, source, externalId, actorQQ: '300', text, kind: 'message' }),
    call: (name, args = {}, callId = name) => tools.call(token, name, args, { sessionId: 'main', callId }),
  };
}

test('global memory reuses account-scoped evidence and exact-call ledger, without changing unread or scene', async t => {
  const f = fixture(t);
  const id = f.record('group:400', 'one', '约好周末看电影');
  f.record('private:200', 'two', '约好吃饭', '999');
  f.store.append({ account: '100', scene: 'group:400', sourceId: 'one', kind: 'message', payload: { text: '约好周末看电影' } });
  const recalled = await f.call('qq_recall', { query: '约好' });
  assert.deepEqual(recalled.events.map(x => x.id), [id]);
  const args = { note: { kind: 'openLoop', text: '周末电影约定', evidenceIds: [id] } };
  const result = await f.call('qq_remember', args);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(await f.call('qq_remember', args), result);
  assert.equal(f.memory.history('100', result.result.id).length, 0);
  assert.equal(f.store.counts('100')[0].unread, 1); assert.equal(f.scenes.current(), null);
  assert.equal((await f.call('qq_recall')).notes.length, 1);
});

test('hidden QQ unread and dependent notes cannot leak through peak recall, historical memory remains', async t => {
  const f = fixture(t);
  const old = f.record('group:400', 'old', '以前一起看电影');
  const fresh = f.record('group:400', 'new', '刚刚发来的新消息');
  f.store.append({ account: '100', scene: 'group:400', sourceId: 'new', kind: 'message', payload: { text: '刚刚发来的新消息' } });
  const note = { kind: 'fact', text: '最新消息', evidenceIds: [fresh] };
  f.memory.remember('100', note);
  f.ctx.peakEnabled = true;
  let result = await f.call('qq_recall');
  assert.deepEqual(result.events.map(x => x.id), [old]); assert.equal(result.notes.length, 0);
  assert.equal((await f.call('qq_remember', { note }, 'hidden')).status, 'rejected');
  f.ctx.peakEnabled = false;
  assert.equal((await f.call('qq_recall')).events.length, 2);
  await f.scenes.join('group:400'); f.ctx.peakEnabled = true;
  assert.equal((await f.call('qq_recall')).events.length, 2);
  f.deny('group:400'); assert.equal((await f.call('qq_recall')).events.length, 0);
});

test('Qzone observations require a visible scene or acknowledged evidence at peak', async t => {
  const f = fixture(t);
  const id = f.memory.record({ accountQQ: '100', source: 'qzone:300', externalId: 'post:post1', actorQQ: '300', text: '空间正文' });
  f.store.append({ account: '100', scene: 'qzone', sourceId: 'hashed-source', kind: 'qzone-feed', payload: { authorQQ: '300', tid: 'post1', text: '空间正文' } });
  f.ctx.peakEnabled = true; assert.equal((await f.call('qq_recall')).events.length, 0);
  f.ctx.peakEnabled = false; const cap = await f.scenes.join('qzone');
  const page = f.scenes.read(cap.capability); f.scenes.markRead(page.receipt); f.scenes.quit();
  f.ctx.peakEnabled = true; assert.deepEqual((await f.call('qq_recall')).events.map(x => x.id), [id]);
});

test('memory disabled, pause, stale evidence, identity and optimistic updates keep prior data', async t => {
  const f = fixture(t), id = f.record('private:200', 'one', '记忆依据');
  const args = { note: { kind: 'fact', text: '记忆', evidenceIds: [id] } };
  const saved = await f.call('qq_remember', args);
  const old = f.memory.recall('100').notes[0];
  f.memory.remember('100', { ...args.note, id: saved.result.id, text: '控制台更新', updatedAt: old.updatedAt });
  assert.equal((await f.call('qq_remember', { note: { ...args.note, id: saved.result.id, updatedAt: old.updatedAt } }, 'stale')).status, 'rejected');
  f.ctx.paused = true; await assert.rejects(f.call('qq_recall'), { code: 'PAUSED' }); f.ctx.paused = false;
  f.disable(); await assert.rejects(f.call('qq_recall'), { code: 'ACTION_DENIED' });
  assert.equal(f.memory.recall('100').notes[0].text, '控制台更新');
});
