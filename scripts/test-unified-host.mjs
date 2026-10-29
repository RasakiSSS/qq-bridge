import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UnifiedMainBinding } from '../src/unified/main-binding.js';
import { startUnifiedHost } from '../src/unified/host.js';
import { invokeMainTool } from '../plugins/qq-agent-presets/qq-unified-client.mjs';
import { createUnifiedSendHandler } from '../src/unified/send-handler.js';

const token = 'a'.repeat(64);
const input = { sessionId: 'main-1', endpoint: 'http://127.0.0.1:12345/mcp', token };
const acl = { verify: () => true, harden: () => ({ ok: true }) }; // No real ACL changes in fixtures.
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-unified-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'unified-mcp.json') };
}
const binding = (file, options = {}) => new UnifiedMainBinding({ file, assertOwner() {}, isExcludedFromModelFiles: () => true, ...acl, ...options });

test('binding is protected before secret write, atomically rotated and cleaned by its publisher', t => {
  const { file, dir } = directory(t); let protectedEmpty = false;
  const publisher = binding(file, { harden(temp) { protectedEmpty = fs.statSync(temp).size === 0; return { ok: true }; } });
  assert.equal(publisher.publish(input), true); assert.equal(protectedEmpty, true);
  assert.equal(JSON.parse(fs.readFileSync(file)).token, token);
  publisher.publish({ ...input, token: 'b'.repeat(64) });
  assert.equal(JSON.parse(fs.readFileSync(file)).token, 'b'.repeat(64));
  assert.deepEqual(fs.readdirSync(dir), ['unified-mcp.json']);
  assert.equal(publisher.clear(), true); assert.equal(publisher.clear(), false);
});

test('older publisher cannot remove a replacement binding', t => {
  const { file } = directory(t); const old = binding(file), next = binding(file);
  old.publish(input); next.publish({ ...input, sessionId: 'main-2' });
  assert.equal(old.clear(), false);
  assert.equal(JSON.parse(fs.readFileSync(file)).sessionId, 'main-2');
  assert.equal(next.clear(), true);
});

test('unsafe ACL, model-visible path and lost owner fail without publishing credentials', t => {
  const { file, dir } = directory(t);
  for (const overrides of [{ verify: () => false }, { isExcludedFromModelFiles: () => false },
    { harden: () => ({ ok: false }) }, { assertOwner() { throw new Error('OWNER_LOST'); } }]) {
    assert.throws(() => binding(file, overrides).publish(input));
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test('binding rejects non-loopback endpoints and identity/credential format changes', t => {
  const { file } = directory(t); const publisher = binding(file);
  for (const delta of [{ endpoint: 'https://example.com/mcp' }, { endpoint: 'http://127.0.0.1:123/a' },
    { endpoint: 'http://user@127.0.0.1:123/mcp' }, { endpoint: input.endpoint + '?token=x' }, { sessionId: '' }, { token: 'bad' }]) {
    assert.throws(() => publisher.publish({ ...input, ...delta }), { code: 'INVALID_MAIN_BINDING' });
    assert.equal(fs.existsSync(file), false);
  }
});

test('hard-linked existing credential path is rejected without touching either link', t => {
  const { file, dir } = directory(t), source = path.join(dir, 'source');
  fs.writeFileSync(source, 'original'); fs.linkSync(source, file);
  assert.throws(() => binding(file).publish(input), { code: 'BINDING_PATH_UNSAFE' });
  assert.equal(fs.readFileSync(source, 'utf8'), 'original');
});

async function hostFixture(t, extra = {}) {
  // Register cleanup in one callback so host drains before deleting SQLite/files.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-unified-live-host-'));
  const file = path.join(dir, 'unified-mcp.json');
  let host, sid, alive = true; const prompts = [];
  t.after(async () => { if (host) await host.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  const ok = value => ({ result: { ok: true, value } });
  host = await startUnifiedHost({ bindingFile: file, bindingOptions: acl,
    assertInstallationOwner: () => { if (!alive) throw new Error('OWNER_LOST'); },
    isExcludedFromModelFiles: () => true,
    runtimeOptions: { file: path.join(dir, 'ledger.sqlite'),
      getContext: () => ({ account: '100', ownerQQ: '200', enabled: true, identityEpoch: 1 }),
      isAllowed: () => true, isWakeAllowed: () => true, configureModel: async () => true,
      authenticateQQ: async () => false, authenticateConsole: async () => false,
      workspaceId: 'shared',
      readWorkspaces: async () => ({ items: [{ workspaceId: 'shared', sessionIds: sid ? [sid] : [] }], archivedSessionIds: [] }),
      api: {
        sessions: {
          list: async () => ok({ items: sid ? [{ sessionId: sid, formatStatus: 'current', running: false }] : [] }),
          create: async input => { sid = input.sessionId; return ok({ sessionId: sid }); },
          prompt: async input => { prompts.push(input); return ok({ accepted: true }); },
        },
        callUnary: async () => ok(sid ? { kind: 'sequenced', asOfSeq: 0, values: { agentPreset: 'qq-unified', inbox: { 'next-step': [], 'next-turn': [] } } } : null),
        events: { follow() {} },
      }, ...extra,
    },
  });
  return { host, file, prompts, loseOwner: () => alive = false,
    add: () => host.ingest({ key: 'group:1', sourceId: 'a', payload: { text: 'hello' }, at: 1 }),
    call: (name, args = {}) => invokeMainTool(name, args, { agent: { session: { id: sid } }, callId: 'host-call-1', signal: new AbortController().signal }, async sessionId => {
      const result = JSON.parse(fs.readFileSync(file)); assert.equal(result.sessionId, sessionId); return result;
    }),
  };
}

test('host publishes binding only after verified main setup, MCP reaches runtime, shutdown removes it', async t => {
  const f = await hostFixture(t);
  assert.equal(fs.existsSync(f.file), false); assert.equal(f.prompts.length, 0);
  f.add(); const tick = await f.host.tick(); assert.equal(tick.status, 'accepted', JSON.stringify(tick));
  const menu = await f.call('qq_get_main_menu'); assert.equal(menu.error, false);
  assert.equal(JSON.parse(menu.text).sessions[0].unread, 1);
  assert.ok(!JSON.stringify(f.prompts).includes(JSON.parse(fs.readFileSync(f.file)).token));
  await f.host.close(); await f.host.close();
  assert.equal(fs.existsSync(f.file), false);
  await assert.rejects(f.host.tick(), { code: 'RUNTIME_CLOSED' });
});

test('host close drains asynchronous preparation before releasing ownership and refuses new work', async t => {
  let release, entered;
  const gate = new Promise(resolve => release = resolve), entry = new Promise(resolve => entered = resolve);
  const f = await hostFixture(t, { configureModel: async () => { entered(); await gate; return true; } });
  f.add(); const tick = f.host.tick(); await entry;
  let closed = false; const closing = f.host.close().then(() => closed = true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  await assert.rejects(f.host.tick(), { code: 'RUNTIME_CLOSED' });
  release(); await tick; await closing;
  assert.equal(f.prompts.length, 0); assert.equal(fs.existsSync(f.file), false);
});

test('lost installation ownership fences host ingestion and future tool calls', async t => {
  const f = await hostFixture(t); f.add(); await f.host.tick(); f.loseOwner();
  assert.throws(f.add, /OWNER_LOST/);
  await assert.rejects(f.host.tick(), /OWNER_LOST/);
  await assert.rejects(f.call('qq_get_main_menu'), /UNIFIED_CONNECTION_FAILED/);
  await assert.rejects(f.host.close(), /OWNER_LOST/); // Never delete a successor's credentials.
});

test('MCP sending uses scene authority and durable DSH call ID; a duplicate returns its receipt', async t => {
  const sent = [];
  const f = await hostFixture(t, { handlers: { sendMessage: createUnifiedSendHandler({
    prepare: async input => input.payload,
    send: async input => { input.assertCurrent(); sent.push(input); return { status: 'succeeded', result: { messageId: '123' } }; },
  }) } });
  f.add(); await f.host.tick();
  const joined = JSON.parse((await f.call('qq_join_session', { key: 'group:1' })).text);
  const args = { capability: joined.capability, messages: ['hello'] };
  for (let i = 0; i < 2; i++) {
    const response = await f.call('qq_send_message', args);
    assert.deepEqual(JSON.parse(response.text), { status: 'succeeded', result: { messageId: '123' } });
  }
  assert.equal(sent.length, 1); assert.equal(sent[0].callId, 'host-call-1'); assert.equal(sent[0].target, 'group:1');
  const conflict = await f.call('qq_send_message', { ...args, messages: ['different'] });
  assert.equal(conflict.text, 'ACTION_ID_CONFLICT');
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse((await f.call('qq_get_main_menu')).text).sessions[0].unread, 1);
});

test('uncertain send is never automatically repeated and never leaks raw upstream errors', async t => {
  let sends = 0;
  const f = await hostFixture(t, { handlers: { sendMessage: createUnifiedSendHandler({
    prepare: async input => input.payload,
    send: async () => { sends++; throw new Error('private upstream token'); },
  }) } });
  f.add(); await f.host.tick();
  const scene = JSON.parse((await f.call('qq_join_session', { key: 'group:1' })).text);
  const args = { capability: scene.capability, messages: ['hello'] };
  for (let i = 0; i < 2; i++) assert.deepEqual(JSON.parse((await f.call('qq_send_message', args)).text), { status: 'unknown' });
  assert.equal(sends, 1);
});

test('sending refuses menu/retired capability and Qzone target', async t => {
  let sends = 0;
  const f = await hostFixture(t, { handlers: { sendMessage: createUnifiedSendHandler({
    prepare: async input => input.payload,
    send: async () => { sends++; return { status: 'succeeded' }; },
  }) } });
  f.add(); await f.host.tick();
  const scene = JSON.parse((await f.call('qq_join_session', { key: 'group:1' })).text);
  await f.call('qq_quit_session');
  assert.equal((await f.call('qq_send_message', { capability: scene.capability, messages: ['hello'] })).text, 'STALE_SCENE');
  const qzone = JSON.parse((await f.call('qq_join_session', { key: 'qzone' })).text);
  assert.equal((await f.call('qq_send_message', { capability: qzone.capability, messages: ['hello'] })).text, 'SCENE_DENIED');
  assert.equal(sends, 0);
});

test('shutdown revokes sender between async preparation and final dispatch', async t => {
  let release, entered, sends = 0;
  const gate = new Promise(resolve => release = resolve), entry = new Promise(resolve => entered = resolve);
  const f = await hostFixture(t, { handlers: { sendMessage: createUnifiedSendHandler({
    prepare: async input => { entered(); await gate; return input.payload; },
    send: async () => { sends++; return { status: 'succeeded' }; },
  }) } });
  f.add(); await f.host.tick();
  const scene = JSON.parse((await f.call('qq_join_session', { key: 'group:1' })).text);
  const call = f.call('qq_send_message', { capability: scene.capability, messages: ['hello'] });
  await entry; const closing = f.host.close(); release();
  const result = await call; await closing;
  assert.equal(result.error, true); assert.equal(result.text, 'UNAUTHORIZED'); assert.equal(sends, 0);
});
