// 只用临时数据库和假 QQ/DSH，不读取生产记忆或发送消息。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSharedMemory } from '../src/shared-memory.js';
import { recordQzoneMemory } from '../src/shared-memory-qzone.js';
import * as roleCard from '../src/role-card.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-test-'));
  const options = { file: path.join(dir, 'memory.sqlite'), now: () => 1800000000000, sanitize: (s) => s.replaceAll('known-token', '[filtered]') };
  const store = createSharedMemory(options);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const record = (extra = {}) => store.record({ accountQQ: '9', source: 'group:1', actorQQ: '123', name: '甲', externalId: 'one', text: '明天考试，今晚复习', ...extra });
  return { store, record, options };
}

test('global recent recall, original text beyond 200 chars, QQ identity and restart persistence', (t) => {
  const { store, record, options } = fixture(t);
  const id = record({ text: '长消息'.repeat(100) + '最后说周末旅行' });
  assert.equal(record({ text: '重复消息不能覆盖' }), id);
  assert.match(store.recall('9', { people: ['123'] }).events[0].text, /周末旅行/);
  store.close();
  const restored = createSharedMemory(options);
  try {
    const result = restored.recall('9', { query: '旅行', strictQuery: true });
    assert.equal(result.events.length, 1); assert.equal(result.events[0].id, id);
    assert.equal(restored.recall('10').events.length, 0);
  } finally { restored.close(); }
});

test('evidence-backed notes, subjective impressions, completion and global mention cooldown', (t) => {
  const { store, record } = fixture(t); const event = record();
  const base = { kind: 'openLoop', personQQ: '123', text: '下次问考试结果', evidenceIds: [event] };
  const id = store.remember('9', base);
  assert.equal(store.recall('9', { people: ['123'], automatic: true }).notes.length, 1);
  store.remember('9', { ...base, id, mentioned: true });
  assert.equal(store.recall('9', { people: ['123'], automatic: true }).notes.length, 0);
  store.remember('9', { ...base, id, status: 'done' });
  assert.equal(store.recall('9').notes.length, 0);
  assert.throws(() => store.remember('9', { ...base, personQQ: '999' }), /人物/);
  assert.throws(() => store.remember('9', { ...base, evidenceIds: ['fake'] }), /依据/);
  assert.throws(() => store.remember('10', base), /依据/);
});

test('forget removes dependent notes and prevents stale batches or repeated source events from resurrecting them', (t) => {
  const { store, record } = fixture(t); const event = record();
  const note = { kind: 'fact', personQQ: '123', text: '说明天考试', evidenceIds: [event] };
  const id = store.remember('9', note), batch = store.batch('9');
  store.forget('9', [id]);
  assert.equal(record(), null);
  store.applyBatch('9', batch, [note]);
  assert.equal(store.recall('9').events.length, 0);
  assert.equal(store.recall('9').notes.length, 0);
});

test('batch writes are atomic and unknown receipts are not factual evidence', (t) => {
  const { store, record } = fixture(t);
  const unknown = record({ externalId: 'unknown', status: 'uncertain' });
  const event = record(); const batch = store.batch('9');
  assert.equal(batch.events.length, 1);
  assert.throws(() => store.remember('9', { kind: 'episode', text: '发过了', evidenceIds: [unknown] }), /未确认/);
  assert.throws(() => store.applyBatch('9', batch, [
    { kind: 'fact', text: '说明天考试', evidenceIds: [event] }, { kind: 'fact', text: '假的', evidenceIds: ['fake'] },
  ]), /批次/);
  assert.equal(store.recall('9').notes.length, 0);
  assert.equal(store.batch('9').through, batch.through);
  store.applyBatch('9', batch, []);
  assert.equal(store.batch('9').events.length, 0);
  record({ externalId: 'unknown', status: 'sent' });
  assert.ok(store.batch('9').events.some((e) => e.id === unknown && e.status === 'sent'));
});

test('QQ Space observes posts and comments, separates unknown writes and confirmed participation, deduplicates polling', (t) => {
  const { store } = fixture(t);
  const data = { ownPosts: [], pendingFeeds: [{ authorQQ: '123', tid: 'a', content: '旅行照片', time: 1800000000 }],
    comments: { c: { ownerQQ: '123', authorQQ: '456', tid: 'a', commentId: 'c', content: '好看', time: 1800000000000 } },
    writes: [{ id: 'w', ownerQQ: '123', tid: 'a', kind: 'comment', content: '这是哪里', status: 'uncertain', at: 1800000000000 }] };
  recordQzoneMemory(store, '9', data); recordQzoneMemory(store, '9', data);
  assert.equal(store.recall('9').events.length, 3);
  data.writes[0].status = 'sent'; recordQzoneMemory(store, '9', data);
  assert.equal(store.recall('9', { people: ['123'] }).events.find((e) => e.kind === 'qzoneAction').status, 'sent');
});

test('output and stored credentials are bounded and filtered; corrupt database is preserved', (t) => {
  const { store, record, options } = fixture(t);
  for (let i = 0; i < 30; i++) record({ externalId: String(i), text: '文本'.repeat(8000) + 'known-token' });
  record({ externalId: 'secret', text: '密码=secret123 known-token' });
  const result = JSON.stringify(store.recall('9', { maxChars: 2000 }));
  assert.ok(result.length <= 2000); assert.ok(!result.includes('secret123')); assert.ok(!result.includes('known-token'));
  store.close(); fs.writeFileSync(options.file, 'broken database');
  assert.throws(() => store.recall('9'));
  assert.equal(fs.readFileSync(options.file, 'utf8'), 'broken database');
});

test('real bridge records across groups/private while paused, preserves unread watermarks and honors feature switch', async () => {
  const h = await bridgeHarness({ config: { allow: { groups: ['456', '789'], private: ['123'] }, socialV2: { peakSleep: { enabled: false } } }, globals: roleCard });
  h.setMode('reserved2'); h.setSelfIdentity('小鲸鱼', '9'); h.socialV2.paused = true;
  const message = (id, content) => ({ user_id: 123, self_id: 9, message_id: id, sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: content } }] });
  try {
    await h.handleIncoming('group', '456', message(1, '我刚说了周末去旅行'), h.cfg);
    await h.handleIncoming('private', '123', message(2, '我喜欢海边'), h.cfg);
    await h.handleIncoming('group', '789', message(3, '记得我刚才说什么吗'), h.cfg);
    const before = JSON.stringify(h.getSocialV2State('group:456').unread);
    const memory = h.recallForConversation('group:789');
    assert.ok(memory.events.some((e) => e.source === 'group:456'));
    assert.ok(memory.events.some((e) => e.source === 'private:123'));
    const wake = h.buildWakePromptV2('group:789', '提问');
    assert.match(wake, /共同记忆/); assert.match(wake, /周末去旅行/); assert.match(wake, /我喜欢海边/);
    assert.equal(JSON.stringify(h.getSocialV2State('group:456').unread), before);
    assert.equal(h.calls.prompts.length, 0); assert.equal(h.socialV2.paused, true);
    await h.handleIncoming('group', '999', message(4, '不应入库'), h.cfg);
    assert.equal(h.sharedMemory.recall('9').events.length, 3);
    h.cfg.socialV2.sharedMemory = { enabled: false };
    await h.handleIncoming('group', '456', message(5, '已关闭'), h.cfg);
    assert.equal(h.recallForConversation('group:789'), null);
    assert.equal(h.sharedMemory.recall('9').events.length, 3);
  } finally { await h.close(); }
});

test('older notes remain searchable, other accounts cannot crowd out results or erase their index', (t) => {
  const { store, record } = fixture(t);
  const event = record({ text: '古老约定去北极旅行' });
  const old = store.remember('9', { kind: 'fact', text: '古老约定', evidenceIds: [event] });
  for (let i = 0; i < 510; i++) {
    store.remember('9', { kind: 'fact', text: '其他认识' + i, evidenceIds: [event] });
    record({ accountQQ: '10', externalId: 'foreign-' + i, text: '古老约定' });
  }
  assert.ok(store.recall('9', { query: '古老约定', strictQuery: true }).notes.some((n) => n.id === old));
  assert.equal(store.forget('10', [event, old]), 0);
  assert.ok(store.recall('9', { query: '古老约定', strictQuery: true }).events.some((e) => e.id === event));
});

test('concurrent correction wins over a stale worker; history and completed job dedup survive restart', (t) => {
  const { store, record, options } = fixture(t);
  const event = record();
  const base = { kind: 'openLoop', personQQ: '123', text: '考试后再问结果', evidenceIds: [event] };
  const id = store.remember('9', base), stale = store.batch('9');
  const before = stale.notes.find((n) => n.id === id);
  store.remember('9', { ...base, id, text: '对方说暂时不想谈考试', status: 'dismissed', updatedAt: before.updatedAt });
  assert.throws(() => store.remember('9', { ...base, id, updatedAt: before.updatedAt }), /已更新/);
  stale.jobId = 'stale'; store.applyBatch('9', stale, [{ ...base, id }]);
  assert.equal(store.recall('9', { includeClosed: true }).notes[0].status, 'dismissed');
  assert.equal(store.history('9', id)[0].text, base.text);
  assert.equal(store.history('10', id).length, 0);
  store.close();
  const restored = createSharedMemory(options);
  try {
    restored.applyBatch('9', stale, [{ ...base, id }]);
    assert.equal(restored.history('9', id).length, 1);
    restored.forget('9', [id]); assert.equal(restored.history('9', id).length, 0);
  } finally { restored.close(); }
});

test('long-message hits return a bounded relevant excerpt and QQ identity survives nickname changes', (t) => {
  const { store, record } = fixture(t);
  const target = record({ text: '开头'.repeat(800) + '樱花树下的约定' + '后文'.repeat(800) });
  record({ externalId: 'alias', name: '新的群名片', text: '我换了名字' });
  record({ externalId: 'other', actorQQ: '456', name: '甲', text: '同名是另一个人' });
  const result = store.recall('9', { people: ['123'], query: '樱花树下的约定', strictQuery: true, maxChars: 1500 });
  assert.equal(result.events[0].id, target); assert.match(result.events[0].text, /樱花树下的约定/);
  assert.equal(result.events[0].excerpt, true); assert.ok(JSON.stringify(result).length <= 1500);
  assert.equal(store.recall('9', { people: ['123'] }).events.length, 2);
});

test('incoming raw evidence is available before asynchronous mention resolution completes', async () => {
  const h = await bridgeHarness({ globals: roleCard });
  h.setMode('reserved2'); h.setSelfIdentity('鲸鱼', '9'); h.socialV2.paused = true;
  let release, entered = false;
  h.bot.request = async () => { entered = true; return await new Promise((resolve) => { release = resolve; }); };
  const pending = h.handleIncoming('group', '456', { user_id: 123, self_id: 9, group_id: 456, message_id: 77,
    sender: { nickname: '甲' }, message: [{ type: 'at', data: { qq: '456' } }, { type: 'text', data: { text: '刚刚约好一起吃火锅' } }] }, h.cfg);
  try {
    assert.ok(h.sharedMemory.recall('9', { people: ['123'] }).events.some((e) => e.text.includes('吃火锅')));
    if (entered) release({ status: 'ok', retcode: 0, data: { nickname: '乙' } });
    await pending;
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});
