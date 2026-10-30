import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { renderPatch, patchFileFor } from './build-agent-preset-patches.mjs';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedSummary } from '../src/unified/summary.js';
import { summaryWorkerAdapter } from '../src/unified/summary-dsh.js';
import { UnifiedTools } from '../src/unified/tools.js';
import { apply as noTools } from '../plugins/qq-agent-presets/qq-memory-no-tools.mjs';

const ok = value => ({ result: { ok: true, value } });
function fixture(t, count = 35) {
  const store = new UnifiedStore(); t.after(() => store.close());
  const ctx = { account: '100', ownerQQ: '200', enabled: true, peakEnabled: false };
  store.account('100'); store.db.prepare("UPDATE accounts SET session_id='main'").run();
  let now = Date.parse('2026-10-27T02:00:00Z'), enabled = true, hook = async () => {}, response = ok({ accepted: true });
  const scenes = new UnifiedScenes({ store, getContext: () => ctx, isAllowed: () => true, now: () => now });
  for (let i = 0; i < count; i++) store.append({ account: '100', scene: 'group:300', sourceId: String(i), payload: { text: `消息${i}` } });
  const prompts = [], follows = [];
  const options = { scenes, policy: () => { if (!enabled) throw Error('disabled'); }, now: () => now,
    ensureWorker: async (job, check) => { await hook(job); check(); },
    prompt: async input => { prompts.push(input); if (response instanceof Error) throw response; return response; },
    follow: sid => follows.push(sid) };
  const summary = new UnifiedSummary(options), tools = new UnifiedTools({ scenes, summaries: summary }), token = tools.issueMainCredential();
  const start = (key = 'group:300', callId = 'one') => tools.call(token, 'qq_summarize_unread', { key }, { sessionId: 'main', callId });
  return { store, scenes, ctx, summary, options, tools, prompts, follows, start,
    job: id => store.db.prepare('SELECT * FROM summary_jobs WHERE id=?').get(id),
    response: x => response = x, hook: fn => hook = fn, disable: () => enabled = false, advance: () => now += 60001 };
}
function events(job, covered, text, requestId = job.id) {
  return [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: text ?? JSON.stringify({ summary: '核心话题与待答问题', coveredSeqs: covered }) }] } } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}
const feed = (summary, job, records) => records.forEach(e => summary.event(job.worker_session, e));

test('menu summary snapshots at most 30 exact messages, deduplicates calls and never acknowledges automatically', async t => {
  const f = fixture(t, 85), request = await f.start(), job = f.job(request.jobId);
  assert.equal(request.count, 30); assert.equal((await f.start()).jobId, job.id);
  await assert.rejects(f.start('private:200'), { code: 'ACTION_ID_CONFLICT' });
  assert.equal(f.scenes.current(), null); await f.summary.tick();
  assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].requestId, job.id);
  assert.throws(() => f.scenes.markRead(job.id), { code: 'RECEIPT_NOT_DELIVERED' });
  const covered = JSON.parse(job.input).messages.map(x => x.seq);
  feed(f.summary, job, events(job, covered));
  assert.equal(f.store.counts('100')[0].unread, 85);
  const result = f.summary.get(job.id); assert.equal(result.status, 'ready');
  assert.equal(f.scenes.markRead(result.receipt).marked, 30);
  assert.equal(f.store.counts('100')[0].unread, 55);
  assert.equal(f.summary.get(job.id).status, 'acknowledged');
  await f.summary.tick(); await f.summary.tick();
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='summary-result'").get().n, 1);
});

test('late peak or pause defers dispatch and result delivery, completed computation is retained', async t => {
  const f = fixture(t), request = await f.start(), job = f.job(request.jobId);
  f.hook(() => { f.ctx.peakEnabled = true; }); await f.summary.tick();
  assert.equal(f.prompts.length, 0); assert.equal(f.job(job.id).phase, 'queued');
  f.ctx.peakEnabled = false; f.hook(() => {}); f.advance(); await f.summary.tick();
  f.ctx.peakEnabled = true; feed(f.summary, job, events(job, [1]));
  assert.equal(f.job(job.id).phase, 'ready');
  assert.throws(() => f.summary.get(job.id), { code: 'PEAK_SCENE_ENTRY_BLOCKED' });
  f.ctx.peakEnabled = false; f.ctx.paused = true;
  assert.throws(() => f.summary.get(job.id), { code: 'PAUSED' });
  f.ctx.paused = false; assert.equal(f.scenes.markRead(f.summary.get(job.id).receipt).marked, 1);
});

test('unknown submission and restart never resubmit; only contiguous request-correlated completion is accepted', async t => {
  const f = fixture(t), request = await f.start(), job = f.job(request.jobId);
  f.response(Error('lost response')); await f.summary.tick();
  assert.equal(f.job(job.id).phase, 'unknown');
  const resumed = new UnifiedSummary(f.options); await resumed.tick(); await resumed.tick();
  assert.equal(f.prompts.length, 1);
  feed(resumed, job, events(job, [1], undefined, 'other-request')); assert.equal(f.job(job.id).phase, 'unknown');
  resumed.snapshot(job.worker_session, { records: events(job, [1]).filter(e => e.seq !== 1).map(event => ({ type: 'event', event })) });
  assert.equal(f.job(job.id).phase, 'unknown');
  resumed.snapshot(job.worker_session, { records: events(job, [1]).map(event => ({ type: 'event', event })) });
  assert.equal(f.job(job.id).phase, 'ready'); assert.equal(f.prompts.length, 1);
});

test('malformed or out-of-range summaries fail without an acknowledgeable receipt', async t => {
  for (const output of ['not JSON', JSON.stringify({ summary: 'bad', coveredSeqs: [999] }), JSON.stringify({ summary: 'bad', coveredSeqs: [1, 1] })]) {
    const f = fixture(t), request = await f.start(), job = f.job(request.jobId); await f.summary.tick();
    feed(f.summary, job, events(job, [], output));
    assert.equal(f.summary.get(job.id).status, 'failed');
    assert.throws(() => f.scenes.markRead(job.id), { code: 'RECEIPT_NOT_DELIVERED' });
    assert.equal(f.store.counts('100')[0].unread, 35);
  }
});

test('single oversized message requires direct reading instead of a truncated acknowledgeable summary', async t => {
  const f = fixture(t, 0);
  f.store.append({ account: '100', scene: 'group:300', sourceId: 'large', payload: { text: '大'.repeat(20000) } });
  await assert.rejects(f.start(), { code: 'SUMMARY_INPUT_TOO_LARGE' });
  assert.equal(f.prompts.length, 0);
});

test('retry of an empty summary call cannot capture newly arrived messages', async t => {
  const f = fixture(t, 0), first = await f.start(); assert.equal(first.status, 'empty');
  f.store.append({ account: '100', scene: 'group:300', sourceId: 'later', payload: { text: '后来' } });
  const retried = await f.start(); assert.equal(retried.status, 'empty'); assert.equal(retried.jobId, first.jobId);
  await f.summary.tick(); assert.equal(f.prompts.length, 0);
});

test('worker adapter verifies preset/workspace and reconciles a lost creation without creating again', async t => {
  const f = fixture(t), request = await f.start(), job = f.job(request.jobId);
  let exists = false, creates = 0, preset = 'qq-summary';
  const api = { sessions: { list: async () => ok({ items: exists ? [{ sessionId: job.worker_session, formatStatus: 'current', running: false }] : [] }),
    create: async () => { creates++; exists = true; throw Error('response lost'); } },
    callUnary: async () => ok(exists ? { kind: 'sequenced', asOfSeq: 0, values: { agentPreset: preset, inbox: { 'next-step': [], 'next-turn': [] } } } : null) };
  const adapter = summaryWorkerAdapter({ store: f.store, api, workspaceId: 'shared', configureModel: async () => true,
    readWorkspaces: async () => ({ items: [{ workspaceId: 'shared', sessionIds: exists ? [job.worker_session] : [] }], archivedSessionIds: [] }) });
  await assert.rejects(adapter(job, () => {})); await adapter(job, () => {});
  assert.equal(creates, 1);
  preset = 'qq-unified'; await assert.rejects(adapter(job, () => {}), { code: 'UNSAFE_SUMMARY_SESSION' });
  exists = false; await assert.rejects(adapter(job, () => {}), { code: 'SUMMARY_CREATION_UNCERTAIN' }); assert.equal(creates, 1);
});

test('summary preset execution guard denies every inherited tool', () => {
  let guard; noTools({ tools: { guard: fn => guard = fn } });
  for (const name of ['qq_send_message', 'qq_workspace_file', 'qq_get_main_menu', 'bash', 'subagent', 'compress']) assert.equal(typeof guard({ name }), 'string');
});

test('summary preset bundle matches source and installs no bridge credential or action clients', () => {
  const rows = yaml.load(fs.readFileSync(new URL('../dsh/agent-presets/qq-summary/agent.cordis.yml', import.meta.url), 'utf8'));
  assert.deepEqual(rows.map(x => x.name), ['@deepseek-ai/dsh-persona', 'qq-agent-presets/qq-memory-no-tools.mjs']);
  assert.equal(fs.readFileSync(patchFileFor('qq-summary'), 'utf8').replaceAll('\r\n', '\n'), renderPatch('qq-summary').replaceAll('\r\n', '\n'));
});

test('cold recovery reads fixed-cut pages without resubmission and retires only completed owned workers', async t => {
  const f = fixture(t), request = await f.start(), job = f.job(request.jobId);
  f.response(Error('response lost')); await f.summary.tick();
  const archived = [], calls = [], resumed = new UnifiedSummary({ ...f.options, retire: async sid => archived.push(sid) });
  await resumed.tick(); assert.equal(archived.length, 0);
  const history = events(job, [1]);
  await resumed.recover(job.worker_session, { cursor: 3, records: [{ type: 'event', event: history[3] }], hasMore: true }, async args => {
    calls.push(args); return { records: history.slice(0, 3).map(event => ({ type: 'event', event })), hasMore: false };
  });
  assert.deepEqual(calls, [{ address: { kind: 'session', sessionId: job.worker_session }, throughSeq: 3, beforeSeq: 3, maxMessages: 50 }]);
  await resumed.tick(); await resumed.tick();
  assert.deepEqual(archived, [job.worker_session]); assert.equal(f.prompts.length, 1);
  assert.equal(resumed.get(job.id).status, 'ready');
});
