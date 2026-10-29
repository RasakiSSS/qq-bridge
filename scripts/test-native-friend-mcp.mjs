import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveNativeFriendUid, nativeFriendRequest } from '../src/native-friend-client.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const root = path.resolve('state/probes');
function temp(t) { fs.mkdirSync(root, { recursive: true }); const p = fs.mkdtempSync(path.join(root, 'native-mcp-test-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }

test('UID lookup and client use trusted account DB, fixed local endpoint and final policy check', async t => {
  const dir = temp(t), data = path.join(dir, 'data', '123456789'); fs.mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(path.join(data, 'snowluma_identity.db'));
  db.exec('CREATE TABLE users(uin INTEGER,uid TEXT); CREATE TABLE group_members(group_id INTEGER,uin INTEGER,uid TEXT,active INTEGER)');
  db.prepare('INSERT INTO users VALUES (?,?)').run(987654321, 'u_0123456789012345678901'); db.close();
  assert.equal(resolveNativeFriendUid({ homeDir: dir, accountUin: '123456789', userId: '987654321', groupId: '555555555' }), 'u_0123456789012345678901');
  assert.throws(() => resolveNativeFriendUid({ homeDir: dir, accountUin: '123456789', userId: '111111111', groupId: '555555555' }));
  const configFile = path.join(dir, 'native.json');
  fs.writeFileSync(configFile, JSON.stringify({ enabled: true, mode: 'production', reportDir: dir, snowlumaHome: dir, expectedUin: '123456789', controlToken: 'a'.repeat(64) }));
  fs.writeFileSync(path.join(dir, 'service.json'), JSON.stringify({ active: true, port: 12345 }));
  let checks = 0, called = 0;
  const options = { configFile, input: { userId: '987654321', groupId: '555555555', answer: 'hi', operationId: 'test-one' }, key: 'private:123', agentToken: 'test-token',
    assertAllowed: () => { checks++; }, fetchImpl: async (url, init) => {
      called++; assert.equal(url, 'http://127.0.0.1:12345/request'); assert.equal(init.redirect, 'error');
      assert.equal(JSON.parse(init.body).targetUid, 'u_0123456789012345678901');
      return { ok: true, json: async () => ({ status: 'native_returned', nativeInvoked: true, outcome: { result: 0, responseResult: 0, errorCode: 0 } }) };
    } };
  assert.equal((await nativeFriendRequest(options)).status, 'succeeded'); assert.equal(checks, 2);
  await assert.rejects(nativeFriendRequest({ ...options, expectedAccount: '222222222' })); assert.equal(called, 1);
  await assert.rejects(nativeFriendRequest({ ...options, assertAllowed: () => { throw Error('paused'); } })); assert.equal(called, 1);
});

test('actual MCP stdio lists qq_add_friend and routes the fixed action without direct OneBot/native access', async t => {
  const dir = temp(t); fs.mkdirSync(path.join(dir, 'src'));
  for (const name of ['mcp-snowluma-safe.js', 'sensitive.js', 'qq-model-view.js']) fs.copyFileSync(path.join('src', name), path.join(dir, 'src', name));
  let body;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); body = JSON.parse(Buffer.concat(chunks));
    assert.equal(req.url, '/api/socialV2/relationships/action'); assert.equal(req.headers['x-agent-token'], 'fixture-agent');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { status: 'succeeded' } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ consolePort: server.address().port, consoleToken: 'fixture-console', socialV2: { relationships: { enabled: true } } }));
  const client = new Client({ name: 'native-friend-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(dir, 'src/mcp-snowluma-safe.js')], stderr: 'pipe' }));
  assert.ok((await client.listTools()).tools.some(x => x.name === 'qq_add_friend'));
  const result = await client.callTool({ name: 'qq_add_friend', arguments: { key: 'group:555555555', token: 'fixture-agent', userId: '987654321', groupId: '555555555', answer: 'hi', operationId: 'operation-001' } });
  assert.notEqual(result.isError, true); assert.equal(body.action, 'request_friend'); assert.equal(body.input.operationId, 'operation-001');
});

test('bridge native route and final callback enforce flags, session token, whitelist and manual pause', async t => {
  let invoked = 0;
  const h = await bridgeHarness({ config: { socialV2: { relationships: { enabled: true, actions: { nativeFriendRequest: true } }, tools: { relationships: true } } },
    globals: { nativeFriendRequest: async opts => { opts.assertAllowed(); invoked++; return { status: 'succeeded', data: { submitted: true } }; } } });
  t.after(() => h.close()); h.setMode('reserved2'); h.cfg.socialV2.relationships.actions = { nativeFriendRequest: true }; h.cfg.socialV2.peakSleep = { enabled: false };
  const token = h.getSocialV2State('private:123').agentToken;
  const server = h.startConsoleServer(h.cfg); if (!server.listening) await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const call = async (route, key = 'private:123', supplied = token) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/relationships/${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': supplied },
      body: JSON.stringify({ key, action: 'request_friend', input: { userId: '987654321', groupId: '555555555', answer: 'hi', operationId: 'operation-001' } }) });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await call('action')).body.ok, true); assert.equal(invoked, 1);
  assert.equal((await call('native-authorize')).body.ok, true);
  assert.equal((await call('action', 'private:123', 'bad')).status, 403);
  assert.equal((await call('action', 'group:999', token)).status, 403);
  h.socialV2.paused = true; assert.equal((await call('action')).status, 403); assert.equal((await call('native-authorize')).status, 403);
  h.socialV2.paused = false; h.cfg.socialV2.relationships.actions.nativeFriendRequest = false;
  assert.equal((await call('action')).status, 403); assert.equal(invoked, 1);
});
