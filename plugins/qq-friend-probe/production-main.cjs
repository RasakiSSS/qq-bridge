'use strict';
// Fixed-purpose local native service. Model calls enter through the bridge;
// this endpoint has its own secret and revalidates bridge authority before send.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { startFriendBinding } = require('./friend-binding.cjs');
const { watchBuddyRequests } = require('./friend-requests.cjs');
const { createFriendValidation } = require('./friend-validation.cjs');
const pins = require('./friend-adapter.cjs');
const singleton = Symbol.for('qq-bridge.native-friend-service.v1');

function launch() {
  const filename = path.join(__dirname, 'config.json');
  if (!fs.existsSync(filename)) return null;
  const c = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!c.enabled || c.mode !== 'production') return null;
  if (!/^[a-f0-9]{64}$/.test(c.controlToken ?? '') || !/^[1-9]\d{4,15}$/.test(c.expectedUin ?? '')
    || ![c.reportDir, c.journalDir, c.bridgeDir, c.snowlumaHome].every(p => typeof p === 'string' && path.isAbsolute(p))) throw Error('Invalid local configuration');
  let binder, server, stopped = false, busy = false, activeValidation;
  const readers = new Set(); let phase = 'starting', lastResult = null, port = null;
  function report() {
    fs.mkdirSync(c.reportDir, { recursive: true });
    fs.writeFileSync(path.join(c.reportDir, 'service.json'), JSON.stringify({ active: !stopped, port, pid: process.pid,
      phase, bindingReady: !!binder?.getBinding(), requestListenerReady: [...readers].some(x => x.ready()), lastResult }) + '\n');
  }
  function stop() {
    if (stopped) return; stopped = true;
    activeValidation?.stop(); for (const r of readers) r.stop(); readers.clear(); binder?.stop(); server?.close();
    try { report(); } catch {}
  }
  async function json(url, body, headers) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Error('Local service unavailable'); return await r.json();
  }
  function bridgeConfig() { return JSON.parse(fs.readFileSync(path.join(c.bridgeDir, 'config.json'), 'utf8')); }
  async function authorize(input) {
    try {
      const cfg = bridgeConfig(), token = cfg.consoleToken || fs.readFileSync(path.join(c.bridgeDir, 'state', 'console-token'), 'utf8').trim();
      const r = await json('http://127.0.0.1:' + (cfg.consolePort || 3100) + '/api/socialV2/relationships/native-authorize',
        { key: input.key }, { 'x-console-token': token, 'x-agent-call': '1', 'x-agent-token': input.agentToken });
      return r.ok === true && !stopped;
    } catch { return false; }
  }
  async function friendStatus(input) {
    const onebot = JSON.parse(fs.readFileSync(path.join(c.snowlumaHome, 'config', 'onebot_' + c.expectedUin + '.json'), 'utf8'));
    const net = onebot.networks?.httpServers?.[0];
    if (!net || !Number.isInteger(net.port) || net.port < 1 || net.port > 65535) throw Error('SnowLuma configuration unavailable');
    async function read(action, data) {
      const r = await json('http://127.0.0.1:' + net.port + '/' + action, data, { authorization: 'Bearer ' + net.accessToken });
      if (r.status !== 'ok' || r.retcode !== 0) throw Error('SnowLuma query rejected'); return r.data;
    }
    if (String((await read('get_login_info', {})).user_id) !== c.expectedUin) throw Error('Account changed');
    const list = await read('get_friend_list', {});
    if (!Array.isArray(list) || list.some(v => !/^[1-9]\d{4,15}$/.test(String(v?.user_id)))) throw Error('Invalid friend list');
    const member = await read('get_group_member_info', { group_id: Number(input.groupId), user_id: Number(input.userId), no_cache: true });
    if (String(member.user_id) !== input.userId || String(member.group_id) !== input.groupId) throw Error('Invalid group source');
    if (String((await read('get_login_info', {})).user_id) !== c.expectedUin) throw Error('Account changed');
    return { accountUin: c.expectedUin, targetUin: input.userId, friend: list.some(x => String(x.user_id) === input.userId) };
  }
  function validInput(x) {
    return x && Object.keys(x).every(k => ['userId', 'groupId', 'answer', 'operationId', 'targetUid', 'key', 'agentToken'].includes(k))
      && /^[1-9]\d{4,15}$/.test(x.userId) && /^[1-9]\d{4,15}$/.test(x.groupId)
      && Number.isSafeInteger(Number(x.userId)) && Number.isSafeInteger(Number(x.groupId))
      && typeof x.answer === 'string' && x.answer.length <= 500
      && /^[A-Za-z0-9_-]{8,100}$/.test(x.operationId) && /^u_[A-Za-z0-9_-]{5,128}$/.test(x.targetUid)
      && typeof x.key === 'string' && x.key.length <= 100 && typeof x.agentToken === 'string' && x.agentToken.length <= 256;
  }
  async function execute(input) {
    if (!await authorize(input)) return { status: 'not_called', code: 'ERR_AUTHORIZATION', nativeInvoked: false };
    const base = [...readers].find(r => r.ready());
    if (!base) return { status: 'not_called', code: 'ERR_REQUEST_LISTENER_UNAVAILABLE', nativeInvoked: false };
    const scopedReader = { ready: () => base.ready(), read: () => base.read(input.targetUid) };
    const journalDir = path.join(c.journalDir, createHash('sha256').update(input.operationId).digest('hex'));
    fs.mkdirSync(journalDir, { recursive: true });
    const validation = createFriendValidation({ enabled: true, expectedUin: c.expectedUin, allowedTargetUins: [input.userId],
      qqVersion: pins.QQ_VERSION, wrapperSha256: pins.WRAPPER_SHA256, majorSha256: pins.MAJOR_SHA256, journalDir, timeoutMs: 25000,
      request: { action: 'request', accountUin: c.expectedUin, targetUin: input.userId, idempotencyKey: input.operationId,
        addFriendSetting: 1, answer: input.answer, remark: '', defaultCategory: 0, sourceId: 5, sourceSubId: 2,
        onlyChat: false, qzoneNotWatch: false, qzoneNotWatched: false } },
      { getBinding: () => binder.getBinding(), getRequestReader: () => scopedReader, readFriendStatus: () => friendStatus(input), authorize: () => authorize(input) });
    activeValidation = validation;
    try { return await validation.run('send-once'); } finally { validation.stop(); activeValidation = null; }
  }
  try {
    binder = startFriendBinding({ expectedUin: c.expectedUin, wrapperPath: c.wrapperPath, persistent: true, acquireAddService: true,
      onBuddyBinding(value) {
        if (!value) { for (const r of readers) r.stop(); readers.clear(); return; }
        if ([...readers].some(r => r.ready())) return;
        readers.add(watchBuddyRequests(value, { dynamicTargets: true, onReady: () => { try { report(); } catch { stop(); } } }));
      }, onReport(state) { phase = state.phase; if (!state.active) stop(); else { try { report(); } catch { stop(); } } } });
    if (stopped) { binder.stop(); return { stop }; }
    server = http.createServer(async (req, res) => {
      const reply = (code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
      const token = req.headers['x-native-friend-token'];
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(c.controlToken))) { req.resume(); reply(401, { error: 'unauthorized' }); return; }
      if (req.method === 'GET' && req.url === '/status') { reply(200, { active: !stopped, bindingReady: !!binder.getBinding(), requestListenerReady: [...readers].some(r => r.ready()) }); return; }
      if (req.method !== 'POST' || req.url !== '/request' || stopped || busy) { req.resume(); reply(409, { error: 'unavailable' }); return; }
      busy = true;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 8192) throw Error('Body too large'); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!validInput(input)) { reply(400, { error: 'invalid-input' }); return; }
        lastResult = await execute(input); report(); reply(200, lastResult);
      } catch { reply(500, { error: 'request-failed' }); }
      finally { busy = false; }
    });
    server.requestTimeout = 30000; server.headersTimeout = 10000; server.on('error', stop);
    server.listen(0, '127.0.0.1', () => { port = server.address()?.port; try { report(); } catch { stop(); } });
    return { stop };
  } catch { stop(); return null; }
}
if (!globalThis[singleton]) { try { globalThis[singleton] = launch(); } catch { console.warn('[QQ Friend Service] Disabled.'); } }
module.exports = { stop: () => globalThis[singleton]?.stop() };
