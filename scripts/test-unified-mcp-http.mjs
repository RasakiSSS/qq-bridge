import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedTools } from '../src/unified/tools.js';
import { startUnifiedMcpHttp, IDENTITY_META } from '../src/unified/mcp-http.js';
import { invokeMainTool, apply } from '../plugins/qq-agent-presets/qq-unified-client.mjs';
import { apply as guard } from '../plugins/qq-agent-presets/qq-unified-guard.mjs';
import { readFileSync } from 'node:fs';
import { renderPatch, patchFileFor } from './build-agent-preset-patches.mjs';

async function fixture(t, beforeDispatch = async () => {}) {
  const store = new UnifiedStore();
  store.account('100');
  store.db.prepare("UPDATE accounts SET session_id='main-1'").run();
  const scenes = new UnifiedScenes({ store, getContext: () => ({ account: '100', ownerQQ: '200', identityEpoch: 1, enabled: true }), isAllowed: () => true });
  const tools = new UnifiedTools({ scenes });
  const token = tools.issueMainCredential(), calls = [];
  const http = await startUnifiedMcpHttp({ tools, dispatch: async (token, name, args, identity) => {
    await beforeDispatch();
    calls.push(identity); return tools.call(token, name, args);
  } });
  t.after(async () => { await http.close(); store.close(); });
  const headers = { authorization: `Bearer ${token}`, 'x-qq-main-session': 'main-1', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const post = (body, extra = {}) => fetch(http.endpoint, { method: 'POST', headers: { ...headers, ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { tools, token, calls, http, headers, post };
}
const request = meta => ({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'qq_get_main_menu', arguments: {}, _meta: meta } });

test('unified guard denies legacy bypass tools, files, subagents and invented namespace names', () => {
  let check;
  guard({ tools: { restrict() { throw new Error('unknown tool'); }, guard(fn) { check = fn; } } });
  for (const name of ['qq_get_main_menu', 'qq_join_session', 'compress', 'decompress', 'search_context', 'acp_status']) assert.equal(check({ name }), undefined);
  for (const name of ['mcp__snowluma__qq_send_message', 'mcp__filesystem__read_file', 'subagent', 'read', 'qq_set_permission', 'qq_unified_arbitrary', undefined]) assert.equal(check({ name }), 'UNIFIED_TOOL_DENIED');
  assert.equal(readFileSync(patchFileFor('qq-unified'), 'utf8'), renderPatch('qq-unified'));
});

test('HTTP close waits for a host call even after its client disconnects', async t => {
  let release, entered;
  const gate = new Promise(resolve => release = resolve), entry = new Promise(resolve => entered = resolve);
  const f = await fixture(t, async () => { entered(); await gate; });
  const controller = new AbortController();
  const requestPromise = fetch(f.http.endpoint, { method: 'POST', headers: f.headers, signal: controller.signal,
    body: JSON.stringify(request({ [IDENTITY_META]: { sessionId: 'main-1', callId: 'disconnect-test' } })) });
  const rejected = assert.rejects(requestPromise);
  await entry; controller.abort(); await rejected;
  let closed = false; const closing = f.http.close().then(() => closed = true);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, false);
  release(); await closing;
  assert.equal(f.calls.length, 1);
});

test('DSH connector takes execution identity from runtime and never from arguments', async t => {
  const f = await fixture(t);
  const binding = async sessionId => {
    if (sessionId !== 'main-1') throw new Error('secret binding unavailable');
    return { endpoint: f.http.endpoint, token: f.token };
  };
  const exec = { agent: { session: { id: 'main-1' } }, callId: 'actual-call-1', signal: new AbortController().signal };
  const result = await invokeMainTool('qq_get_main_menu', {}, exec, binding);
  assert.equal(result.error, false);
  assert.deepEqual(f.calls, [{ sessionId: 'main-1', callId: 'actual-call-1' }]);
  await assert.rejects(invokeMainTool('qq_get_main_menu', { sessionId: 'main-1' }, { ...exec, agent: { session: { id: 'helper' } } }, binding), /UNIFIED_CONNECTION_FAILED/);
  await assert.rejects(invokeMainTool('qq_get_main_menu', {}, {}, binding), /MAIN_EXECUTION_REQUIRED/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(invokeMainTool('qq_get_main_menu', {}, { ...exec, signal: controller.signal }, binding), /UNIFIED_CONNECTION_FAILED/);
  assert.equal(f.calls.length, 1);
});

test('DSH registrations share MCP schemas without model-facing authentication fields', () => {
  const definitions = [];
  apply({ tools: { register: definition => definitions.push(definition) } });
  assert.equal(definitions.length, 7);
  const join = definitions.find(item => item.name === 'qq_join_session');
  assert.deepEqual(join.parameters.required, ['key']);
  assert.equal(join.parameters.additionalProperties, false);
  assert.ok(!JSON.stringify(definitions).includes('token'));
  assert.ok(!JSON.stringify(definitions).includes('callId'));
});

test('real HTTP MCP carries stable execution ID separately from JSON-RPC request ID', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(f.http.endpoint), { requestInit: { headers: f.headers } }));
  try {
    assert.equal((await client.listTools()).tools.length, 7);
    for (let i = 0; i < 2; i++) {
      const result = await client.callTool({ name: 'qq_get_main_menu', arguments: {}, _meta: { [IDENTITY_META]: { sessionId: 'main-1', callId: 'call-stable' } } });
      assert.deepEqual(JSON.parse(result.content[0].text), { sessions: [], hasMore: false });
    }
    assert.deepEqual(f.calls, Array(2).fill({ sessionId: 'main-1', callId: 'call-stable' }));
  } finally { await client.close(); }
});

test('reject missing credentials, wrong session, browser origin and missing execution metadata', async t => {
  const f = await fixture(t);
  for (const [headers, status] of [[{ authorization: '' }, 401], [{ 'x-qq-main-session': 'helper' }, 401], [{ origin: 'http://evil.test' }, 403], [{ host: 'evil.test' }, 403]]) {
    const response = await f.post(request({}), headers); assert.equal(response.status, status); await response.text();
  }
  for (const meta of [{}, { [IDENTITY_META]: { sessionId: 'helper', callId: 'x' } }, { [IDENTITY_META]: { sessionId: 'main-1', callId: '' } }]) {
    const response = await f.post(request(meta)); assert.equal(response.status, 403); await response.text();
  }
  assert.equal(f.calls.length, 0);
});

test('revoked credential cannot discover or execute tools; malformed and oversized bodies fail closed', async t => {
  const f = await fixture(t);
  for (const [body, status] of [['{', 400], [[], 400], [' '.repeat(65537), 413]]) {
    const response = await f.post(body); assert.equal(response.status, status); await response.text();
  }
  f.tools.revoke();
  const response = await f.post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(response.status, 401); assert.ok(!(await response.text()).includes(f.token));
  assert.equal(f.calls.length, 0);
});
