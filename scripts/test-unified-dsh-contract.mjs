// P1 protocol evidence only: execute installed DSH command code with in-memory
// host services. No live DSH, QQ, credentials, model calls or production files.
// This does not test the future unified scheduler or an end-to-end DSH runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { dshModulesDir } from './dsh-modules.mjs';
import { NodeApiClient } from '../src/dsh-client.js';
import { apply as ordinaryGuard } from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';
import { apply as filesGuard } from '../plugins/qq-agent-presets/qq-tool-restrict-files.mjs';

const modules = dshModulesDir();
const packageDir = path.join(modules, '@deepseek-ai/dsh-api-session-controller');
const { SessionCommandController } = await import(pathToFileURL(path.join(packageDir, 'lib/types/commands.js')));
console.log('Installed DSH command package:', JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version);

function fixture() {
  const history = [], calls = [];
  const agent = {
    id: 'session-p1-fixture',
    inbox: { nextTurn: [], nextStep: [] },
    session: { header: {}, snapshotEvents: () => history },
    followup(message) { calls.push('followup'); this.inbox.nextTurn.push(message); },
    steer(message) { calls.push('steer'); this.inbox.nextStep.push(message); },
    cancel(reason, options) { calls.push({ reason, options }); },
  };
  const ctx = {
    agents: { get: () => agent },
    attachments: { admitPromptContent: async (content) => content },
    fileUploads: { bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) },
  };
  const controller = new SessionCommandController(ctx, { resolveAgent: async () => ({ agent }) }, 'fixture');
  const request = (id = 'wake-1', mode = 'queue') => ({
    sessionId: agent.id, requestId: id, mode, content: [{ type: 'text', text: 'fixture only' }],
  });
  const submit = (id, mode) => controller.prompt(request(id, mode), { kind: 'user', rpcId: id ?? 'wake-1' });
  return { agent, ctx, history, calls, controller, request, submit };
}

test('queue admission invokes followup, not steer, and is only an acceptance receipt', async () => {
  const f = fixture();
  assert.deepEqual(await f.submit(), { accepted: true });
  assert.deepEqual(f.calls, ['followup']);
  assert.equal(f.agent.inbox.nextTurn.length, 1);
  assert.equal(f.history.length, 0); // Not a completed turn or a QQ send receipt.
});

test('same requestId sequential retry deduplicates pending next-turn input', async () => {
  const f = fixture();
  await f.submit(); await f.submit();
  assert.deepEqual(f.calls, ['followup']);
});

test('steer uses next-step; retry recognizes that boundary too', async () => {
  const f = fixture();
  await f.submit('wake-1', 'steer'); await f.submit('wake-1', 'steer');
  assert.deepEqual(f.calls, ['steer']);
  assert.equal(f.agent.inbox.nextStep.length, 1);
});

test('history rpcId deduplicates after message has left the inbox', async () => {
  const f = fixture(); await f.submit();
  const message = f.agent.inbox.nextTurn.shift();
  f.history.push({ type: 'user/message', data: { source: message.source } });
  await f.submit();
  assert.deepEqual(f.calls, ['followup']);
});

test('new requestId is a new prompt, even with identical text', async () => {
  const f = fixture(); await f.submit('wake-1'); await f.submit('wake-2');
  assert.equal(f.calls.length, 2);
});

test('overlapping text admissions are not atomic dedup: caller must serialize', { timeout: 2000 }, async () => {
  const f = fixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered = 0, bothEntered;
  const ready = new Promise((resolve) => { bothEntered = resolve; });
  f.ctx.attachments.admitPromptContent = async (content) => {
    if (++entered === 2) bothEntered();
    await gate;
    return content;
  };
  const pending = [f.submit(), f.submit()];
  await ready; release(); await Promise.all(pending);
  assert.equal(f.calls.length, 2); // Observed limitation, not desired unified behavior.
});

test('session invalidated during admission rejects without queueing work', async () => {
  const f = fixture();
  f.ctx.attachments.admitPromptContent = async (content) => {
    f.ctx.agents.get = () => undefined;
    return content;
  };
  await assert.rejects(f.submit(), /disposed during prompt admission/);
  assert.equal(f.calls.length, 0);
});

test('cancel explicitly retains inbox; migration must clear queue separately', async () => {
  const f = fixture(); await f.submit();
  await f.controller.cancel({ sessionId: f.agent.id });
  assert.deepEqual(f.calls.at(-1), { reason: { kind: 'user' }, options: { keepInbox: true } });
  assert.equal(f.agent.inbox.nextTurn.length, 1);
});

function clientFixture() {
  const client = new NodeApiClient('http://127.0.0.1:1', 1000, {});
  const envelopes = [];
  // Replace the entire transport before calling any RPC; no auth or sockets.
  client.postJson = async (_url, message) => {
    envelopes.push(message);
    return { json: async () => ({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { accepted: true } } }) };
  };
  return { client, envelopes };
}

test('bridge client preserves supplied persistent requestId across retries', async () => {
  const { client, envelopes } = clientFixture();
  const input = fixture().request('durable-wake-1');
  await client.callUnary('session/prompt', input); await client.callUnary('session/prompt', input);
  assert.deepEqual(envelopes.map((e) => e.payload.args.request.requestId), ['durable-wake-1', 'durable-wake-1']);
});

test('omitting requestId generates different ids: current caller retries cannot rely on dedup', async () => {
  const { client, envelopes } = clientFixture();
  const { requestId, ...input } = fixture().request();
  await client.callUnary('session/prompt', input); await client.callUnary('session/prompt', input);
  assert.notEqual(envelopes[0].payload.args.request.requestId, envelopes[1].payload.args.request.requestId);
});

test('bridge retirement removes both inbox boundaries before cancel', async () => {
  const { client } = clientFixture();
  const calls = [];
  client.callUnary = async (method, request) => {
    calls.push({ method, request });
    const value = method === 'session/projections' ? { values: { inbox: {
      'next-turn': [{ id: 'turn-item' }], 'next-step': [{ id: 'step-item' }],
    } } } : {};
    return { result: { ok: true, value } };
  };
  assert.deepEqual(await client.stopSessionWork('session-fixture'), { removed: 2 });
  assert.deepEqual(calls.map((x) => x.method), [
    'session/projections', 'session/updateQueue', 'session/updateQueue', 'session/cancel',
  ]);
  assert.deepEqual(calls.slice(1, 3).map((x) => x.request.itemId), ['turn-item', 'step-item']);
});

test('failed queue removal still cancels but does not falsely report a safe retirement', async () => {
  const { client } = clientFixture();
  client._readSessionQueue = async () => ['item'];
  let cancelled = false;
  client.callUnary = async (method) => {
    if (method === 'session/updateQueue') throw Error('fixture queue removal failed');
    cancelled = method === 'session/cancel';
    return { result: { ok: true, value: {} } };
  };
  await assert.rejects(client.stopSessionWork('session-fixture'), /queue removal failed/);
  assert.equal(cancelled, true);
});

function installedGuard(apply) {
  let check;
  apply({ tools: { restrict() {}, guard(fn) { check = fn; } } });
  return check;
}

test('existing ordinary guard denies filesystem, shell and raw subagents', () => {
  const check = installedGuard(ordinaryGuard);
  for (const name of ['mcp__qq-workspace-files__write_file', 'pwsh', 'subagent', 'subagent_fork']) assert.equal(typeof check({ name }), 'string');
});

test('existing files guard is static: allowed file tool has no dynamic permission check', () => {
  const check = installedGuard(filesGuard);
  assert.equal(check({ name: 'mcp__qq-workspace-files__write_file' }), undefined);
  for (const name of ['pwsh', 'subagent', 'mcp__qq-workspace-files__move_file']) assert.equal(typeof check({ name }), 'string');
  // New mode needs an enforcing adapter; changing only the persona cannot revoke v3.
});
