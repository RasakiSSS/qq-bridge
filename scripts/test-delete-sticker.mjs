// 只删除模拟网关中的测试收藏，永远不连接真实 QQ/DSH，不访问生产表情库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const ROUTE = '/api/socialV2/delete-sticker';
const SEED = [
  { id: 'saved-a', resId: 'saved-a', url: 'https://public.invalid/a.gif', md5: 'ABC', desc: '甲', localNote: '甲笔记', tags: ['甲'], useCount: 3 },
  { id: 'saved-b', resId: 'saved-b', url: 'https://public.invalid/b.gif', md5: 'DEF', desc: '乙', localNote: '乙笔记', tags: ['乙'], useCount: 7 },
];

function request(port, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const cleanHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: cleanHeaders }, (res) => {
      let text = '';
      res.on('data', (part) => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end(JSON.stringify(body));
  });
}

async function fixture(run, { config = {}, files = {}, globals = {} } = {}) {
  const h = await bridgeHarness({
    config: { socialV2: { tools: { deleteSticker: true }, proactive: { enabled: false } }, ...config },
    files: { 'state/stickers.json': SEED, 'keep.txt': 'must remain', ...files }, globals,
  });
  h.setMode('reserved2');
  const token = h.getSocialV2State(KEY).agentToken;
  const calls = [];
  const remote = new Map(SEED.map((item) => [item.id, { emoji_id: item.id, url: item.url, md5: item.md5, desc: item.desc }]));
  h.bot.request = async (action, params) => {
    calls.push({ action, params: JSON.parse(JSON.stringify(params)) });
    if (action === 'fetch_custom_face_detail') return { status: 'ok', retcode: 0, data: [...remote.values()] };
    assert.equal(action, 'delete_custom_face', 'only the documented delete action may mutate QQ');
    remote.delete(params.emoji_id);
    return { status: 'ok', retcode: 0, data: null };
  };
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const headers = { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': token };
  const call = (body = {}, extra = {}) => request(port, extra.path || ROUTE,
    { key: KEY, stickerId: 'saved-a', ...body }, { ...headers, ...extra.headers });
  try { await run({ h, call, headers, calls, remote, port, token }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

test('deletes one QQ favorite by ID, MD5 or known URL and persists only that removal', async () => {
  for (const stickerId of ['saved-a', 'abc', 'http://public.invalid/a.gif?cache=1']) {
    await fixture(async ({ h, call, calls, remote }) => {
      const result = await call({ stickerId });
      assert.equal(result.status, 200);
      assert.equal(result.data.deleted, true);
      assert.equal(result.data.stickerId, 'saved-a');
      assert.equal(result.data.localPersisted, true);
      assert.equal(result.data.remaining, 1);
      assert.equal(remote.has('saved-a'), false);
      assert.deepEqual(calls.filter((c) => c.action === 'delete_custom_face'), [
        { action: 'delete_custom_face', params: { emoji_id: 'saved-a' } },
      ]);
      const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/stickers.json'), 'utf8'));
      assert.equal(saved.length, 1);
      assert.equal(saved[0].id, 'saved-b');
      assert.equal(saved[0].localNote, '乙笔记');
      assert.deepEqual(saved[0].tags, ['乙']);
      assert.equal(saved[0].useCount, 7);
      assert.equal(fs.readFileSync(path.join(h.temp, 'keep.txt'), 'utf8'), 'must remain');
    });
  }
});

test('gateway failure or malformed receipt never deletes the local entry', async () => {
  for (const receipt of [null, { status: 'failed', retcode: 100 }, { status: 'ok' }, { status: 'ok', retcode: '0' }]) {
    await fixture(async ({ h, call }) => {
      const original = h.bot.request;
      h.bot.request = async (action, params) => action === 'delete_custom_face' ? receipt : original(action, params);
      const result = await call();
      assert.equal(result.status, 502);
      assert.equal(result.data.ok, false);
      assert.equal(h.getStickerEntries().length, 2);
      assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/stickers.json'), 'utf8')).length, 2);
    });
  }
});

test('rejects empty, batch, wildcard, unknown and filesystem targets without a native delete', async () => {
  await fixture(async ({ h, call, calls }) => {
    for (const stickerId of ['', [], ['saved-a', 'saved-b'], {}, '*', 'missing', '../keep.txt', 'x'.repeat(2049)]) {
      const result = await call({ stickerId });
      assert.ok([400, 404].includes(result.status));
    }
    assert.equal(calls.filter((c) => c.action === 'delete_custom_face').length, 0);
    assert.equal(fs.readFileSync(path.join(h.temp, 'keep.txt'), 'utf8'), 'must remain');
  });
});

test('token, tool toggle, global toggle, pause, mode and allowlist all remain enforced', async () => {
  for (const deny of ['token', 'other-session', 'tool', 'stickers', 'v2', 'pause', 'mode', 'allowlist']) {
    await fixture(async ({ h, call, calls }) => {
      const extra = {};
      if (deny === 'token') extra.headers = { 'x-agent-token': 'invalid-token' };
      if (deny === 'other-session') extra.headers = { 'x-agent-token': h.getSocialV2State('private:123').agentToken };
      if (deny === 'tool') h.cfg.socialV2.tools.deleteSticker = false;
      if (deny === 'stickers') h.cfg.socialV2.sticker.enabled = false;
      if (deny === 'v2') h.cfg.socialV2.enabled = false;
      if (deny === 'pause') h.socialV2.paused = true;
      if (deny === 'mode') h.setMode('chat');
      if (deny === 'allowlist') h.cfg.allow.groups = [];
      const result = await call({}, extra);
      assert.equal(result.status, 403, deny);
      assert.equal(calls.length, 0, deny + ' must fail before accessing QQ');
    });
  }
});

test('missing agent token and cross-origin writes do not fall back to console privileges', async () => {
  await fixture(async ({ call, calls }) => {
    for (const headers of [{ 'x-agent-token': '' }, { 'x-agent-token': undefined }, { origin: 'https://external.invalid' }, { 'content-type': 'text/plain' }]) {
      const result = await call({}, { headers });
      assert.ok([403, 415].includes(result.status));
    }
    assert.equal(calls.length, 0);
  });
});

test('rechecks token, toggle, pause, allowlist and session policy after async synchronization', async () => {
  for (const revoke of ['token', 'tool', 'pause', 'allowlist', 'policy']) {
    await fixture(async ({ h, call, calls }) => {
      const original = h.bot.request;
      h.bot.request = async (action, params) => {
        const response = await original(action, params);
        if (action === 'fetch_custom_face_detail') {
          if (revoke === 'token') h.getSocialV2State(KEY).agentToken = 'rotated-token';
          if (revoke === 'tool') h.cfg.socialV2.tools.deleteSticker = false;
          if (revoke === 'pause') h.socialV2.paused = true;
          if (revoke === 'allowlist') h.cfg.allow.groups = [];
          if (revoke === 'policy') h.cfg.ownerQQ = 999;
        }
        return response;
      };
      assert.equal((await call()).status, 403, revoke);
      assert.equal(calls.filter((c) => c.action === 'delete_custom_face').length, 0);
      assert.equal(h.getStickerEntries().length, 2);
    });
  }
});

test('simultaneous duplicate deletion invokes the QQ action only once', async () => {
  await fixture(async ({ call, calls }) => {
    const results = await Promise.all([call(), call()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 404]);
    assert.equal(calls.filter((c) => c.action === 'delete_custom_face').length, 1);
  });
});

test('queued deletion rechecks permission after an earlier deletion completes', async () => {
  await fixture(async ({ h, call, calls }) => {
    const original = h.bot.request;
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    h.bot.request = async (action, params) => {
      if (action === 'delete_custom_face') { entered(); await gate; }
      return original(action, params);
    };
    const first = call();
    await started;
    const second = call({ stickerId: 'saved-b' });
    h.cfg.socialV2.tools.deleteSticker = false;
    release();
    assert.equal((await first).status, 200, 'already dispatched operation may finish');
    assert.equal((await second).status, 403);
    assert.equal(calls.filter((c) => c.action === 'delete_custom_face').length, 1);
  });
});

test('stale synchronization cannot resurrect a favorite after successful deletion', async () => {
  await fixture(async ({ h, call }) => {
    await h.syncStickerLibrary(true);
    const original = h.bot.request;
    let release;
    h.bot.request = async (action, params) => {
      if (action === 'fetch_custom_face_detail') {
        return new Promise((resolve) => { release = () => resolve({ status: 'ok', retcode: 0, data: SEED.map((e) => ({ emoji_id: e.id, url: e.url })) }); });
      }
      return original(action, params);
    };
    const stale = h.syncStickerLibrary(true);
    assert.equal((await call()).status, 200);
    release();
    await stale;
    assert.equal(h.getStickerEntries().some((e) => e.id === 'saved-a'), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/stickers.json'), 'utf8')).some((e) => e.id === 'saved-a'), false);
  });
});

test('a corrupted sticker store is left untouched and blocks remote deletion', async () => {
  await fixture(async ({ h, call, calls }) => {
    assert.equal((await call()).status, 503);
    assert.equal(calls.length, 0);
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/stickers.json'), 'utf8'), '{invalid');
  }, { files: { 'state/stickers.json': '{invalid' } });
});

test('local persistence failure reports remote success with an explicit warning', async () => {
  await fixture(async ({ h, call, remote }) => {
    const result = await call();
    assert.equal(result.status, 200);
    assert.equal(result.data.deleted, true);
    assert.equal(result.data.localPersisted, false);
    assert.ok(result.data.warning);
    assert.equal(remote.has('saved-a'), false);
    assert.equal(h.getStickerEntries().some((e) => e.id === 'saved-a'), false);
  }, { globals: { saveStickerStore() { throw new Error('fixture disk full'); } } });
});

test('console configuration can disable deletion and the next request immediately obeys', async () => {
  await fixture(async ({ h, call, port, calls }) => {
    const result = await request(port, '/api/socialV2/config', { tools: { deleteSticker: false } }, {
      'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
    });
    assert.equal(result.status, 200);
    assert.equal(h.cfg.socialV2.tools.deleteSticker, false);
    assert.equal((await call()).status, 403);
    assert.equal(calls.length, 0);
  });
});
