import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('upstream turn errors stay in logs and activity, with farewell cleanup preserved', async () => {
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const start = source.indexOf("} else if (ended.reason.kind === 'error') {");
  const end = source.indexOf("} else if (ended.reason.kind === 'aborted') {", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start + "} else if (ended.reason.kind === 'error') {".length, end);
  for (const key of ['group:456', 'private:123']) {
    const logs = [], activity = [], sent = [];
    const state = { phase: 'exiting', activeDeadlineAt: 1, activeExitAt: 1 };
    await vm.runInNewContext(`(async () => {${body}})()`, {
      key, ended: { reason: { kind: 'error', error: { message: '502 acp-proxy failure: upstream circuit open; UND_ERR_SOCKET' } } },
      isFarewell: true, socialState: () => state, shouldAuditKey: () => true, SENSITIVE_RE: /fixture-secret/,
      log: s => logs.push(s), appendActivity: s => activity.push(s), sendToQQ: async (...args) => sent.push(args),
    });
    assert.equal(sent.length, 0);
    assert.ok(logs.some(s => s.includes('acp-proxy failure')));
    assert.ok(activity.some(s => s.includes('agent 处理出错')));
    assert.equal(state.phase, 'idle'); assert.equal(state.activeDeadlineAt, 0);
  }
});

test('rejected prompt returns failure to caller without posting infrastructure details to QQ', async t => {
  const h = await bridgeHarness(); t.after(() => h.close());
  h.setMode('chat');
  h.api.sessions.prompt = async () => ({ result: { ok: false, error: { code: '502', message: 'acp-proxy failure: upstream circuit open' } } });
  const result = await h.deliverPrompt('private:123', 'fixture input');
  assert.equal(result.ok, false);
  assert.match(result.error, /acp-proxy/);
  assert.equal(h.calls.sent.length, 0);
});
