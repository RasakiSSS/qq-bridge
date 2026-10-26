'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { startFriendBinding } = require('./friend-binding.cjs');
const { watchBuddyRequests } = require('./friend-requests.cjs');
const { createFriendValidation } = require('./friend-validation.cjs');
const { QQ_VERSION, WRAPPER_SHA256, MAJOR_SHA256 } = require('./friend-adapter.cjs');
const singleton = Symbol.for('qq-bridge.friend-maintenance.v1');

function launch() {
  const filename = path.join(__dirname, 'config.json');
  if (!fs.existsSync(filename)) return null;
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (config.enabled !== true) return null;
  if (config.mode !== 'maintenance-send-once' || !/^[a-f0-9]{64}$/.test(config.controlToken ?? '')
    || !path.isAbsolute(config.reportDir ?? '') || !path.isAbsolute(config.journalDir ?? '')
    || config.qqVersion !== QQ_VERSION || config.wrapperSha256 !== WRAPPER_SHA256 || config.majorSha256 !== MAJOR_SHA256
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.snowlumaHttpUrl ?? '')
    || typeof config.snowlumaToken !== 'string' || !config.snowlumaToken
    || !/^\d{5,20}$/.test(config.sourceGroup ?? '')) throw Error('ERR_CONFIG');
  let binder, validation, server, timer, stopped = false;
  const requestReaders = new Set();
  const getRequestReader = () => [...requestReaders].find(reader => reader.ready()) ?? null;
  let snapshot = { phase: 'waiting-wrapper', active: true, requestSent: false };
  let lastResult = null, port = null, nativeAttempted = false;
  const reportFile = path.join(config.reportDir, 'validation.json');
  function report() {
    fs.mkdirSync(config.reportDir, { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify({ formatVersion: 1, pid: process.pid, updatedAt: new Date().toISOString(),
      active: !stopped, port, phase: snapshot.phase, identityMatched: snapshot.identityMatched === true,
      bindingReady: !!binder?.getBinding(), requestListenerReady: !!getRequestReader(),
      lastResult, nativeAttempted, requestSent: nativeAttempted ? null : false }) + '\n');
  }
  function stop() {
    if (stopped) return;
    stopped = true; clearTimeout(timer); validation?.stop();
    for (const reader of requestReaders) reader.stop();
    requestReaders.clear(); binder?.stop(); server?.close();
    try { report(); } catch { /* Do not affect QQ. */ }
  }
  async function read(action, body) {
    const response = await fetch(config.snowlumaHttpUrl + '/' + action, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.snowlumaToken },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw Error('ERR_SNOWLUMA');
    const result = await response.json();
    if (result.retcode !== 0 || result.status !== 'ok') throw Error('ERR_SNOWLUMA');
    return result.data;
  }
  async function readFriendStatus() {
    const expected = config.expectedUin;
    const before = await read('get_login_info', {});
    if (String(before.user_id) !== expected) throw Error('ERR_ACCOUNT');
    const list = await read('get_friend_list', {});
    if (!Array.isArray(list) || list.some(v => !/^\d{5,20}$/.test(String(v?.user_id)))) throw Error('ERR_FRIEND_LIST');
    const member = await read('get_group_member_info', { group_id: Number(config.sourceGroup), user_id: Number(config.targetUin), no_cache: true });
    if (String(member.group_id) !== config.sourceGroup || String(member.user_id) !== config.targetUin) throw Error('ERR_SOURCE_GROUP');
    const after = await read('get_login_info', {});
    if (String(after.user_id) !== expected || stopped) throw Error('ERR_ACCOUNT');
    return { accountUin: expected, targetUin: config.targetUin, friend: list.some(v => String(v.user_id) === config.targetUin) };
  }
  try {
    binder = startFriendBinding({ expectedUin: config.expectedUin, wrapperPath: config.wrapperPath, timeoutMs: 1800000,
      onBuddyBinding(value) {
        if (!value) { for (const reader of requestReaders) reader.stop(); requestReaders.clear(); return; }
        if (!stopped) requestReaders.add(watchBuddyRequests(value, { targetUid: config.targetUid, onReady: () => { try { report(); } catch { stop(); } } }));
      },
      onReport(value) { snapshot = value; try { report(); } catch { stop(); } if (!value.active) stop(); },
    });
    if (stopped) { binder.stop(); return { stop }; }
    validation = createFriendValidation({ enabled: true, expectedUin: config.expectedUin, allowedTargetUins: [config.targetUin],
      qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256, majorSha256: MAJOR_SHA256, journalDir: config.journalDir,
      request: config.request }, { getBinding: () => binder.getBinding(), getRequestReader, readFriendStatus });
    server = http.createServer(async (req, res) => {
      const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      const supplied = req.headers['x-maintenance-token'];
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)
        || !timingSafeEqual(Buffer.from(supplied), Buffer.from(config.controlToken))) { req.resume(); reply(401, { error: 'unauthorized' }); return; }
      if (req.method === 'GET' && req.url === '/status') {
        reply(200, { active: !stopped, phase: snapshot.phase, bindingReady: !!binder.getBinding(), requestListenerReady: !!getRequestReader(), lastResult }); return;
      }
      if (req.method !== 'POST' || !['/preflight', '/send-once'].includes(req.url) || stopped
        || req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) {
        req.resume(); reply(400, { error: 'invalid-action' }); return;
      }
      try {
        lastResult = await validation.run(req.url.slice(1));
        if (lastResult.nativeInvoked === true) nativeAttempted = true;
        report(); reply(200, lastResult);
      } catch { stop(); reply(500, { error: 'validation-failed' }); }
    });
    server.requestTimeout = 20000; server.headersTimeout = 10000;
    server.on('error', stop);
    server.listen(0, '127.0.0.1', () => { port = server.address()?.port; try { report(); } catch { stop(); } });
    timer = setTimeout(stop, 1800000); timer.unref();
    report();
    return { stop };
  } catch { stop(); return null; }
}
if (!globalThis[singleton]) {
  try { globalThis[singleton] = launch(); }
  catch { console.warn('[QQ Friend Validation] Disabled: invalid configuration or environment.'); }
}
module.exports = { stop: () => globalThis[singleton]?.stop() };
