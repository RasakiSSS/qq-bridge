import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeSendHandler } from '../src/unified/bridge-send.js';

function fixture(overrides = {}) {
  const state = { sendTimes: [], wakeConfig: {} }, records = [], sends = [];
  const config = { maxMessageChars: 500, burstMaxMessages: 8, maxSendPerMinute: 3 };
  let allowed = true;
  const handler = createBridgeSendHandler({ assertAllowed() { if (!allowed) throw new Error('revoked'); },
    getConfig: () => config, getState: () => state, saveState() {}, audit(_key, text) { if (text.includes('secret')) throw new Error('audit'); },
    resolveReply: async () => ({ ok: true, messageId: 'resolved' }),
    send: async (...args) => { args[5](); sends.push(args); return args[1]; },
    record: (key, messages) => records.push({ key, messages }), computeDelays: () => [], now: () => 100000, ...overrides });
  const input = { target: 'group:1', payload: { messages: ['hello'] }, assertCurrent() { if (!allowed) throw new Error('revoked'); } };
  return { state, config, records, sends, handler, input, revoke: () => allowed = false,
    async run(payload = input.payload) { const prepared = await handler.prepare({ ...input, payload }); return handler.dispatch({ ...input, payload: prepared }); } };
}

test('bridge sender preserves message limits, audit and rate limits before any network write', async () => {
  const f = fixture();
  for (const payload of [{ messages: ['secret'] }, { messages: ['x'.repeat(501)] }, { messages: Array(9).fill('hello') }, { messages: [' '] }]) await assert.rejects(f.run(payload));
  f.state.sendTimes.push(99999, 99999, 99999);
  await assert.rejects(f.run(), { code: 'SEND_RATE_LIMITED' });
  assert.equal(f.sends.length, 0); assert.equal(f.records.length, 0);
});

test('reference lookup is followed by final policy check before quota reservation', async () => {
  let f;
  f = fixture({ resolveReply: async () => { f.revoke(); return { ok: true, messageId: '123' }; } });
  await assert.rejects(f.run({ messages: ['hello'], replyToMessageId: '12' }), /revoked/);
  assert.equal(f.sends.length, 0); assert.equal(f.state.sendTimes.length, 0);
});

test('invalid quote target never sends and leaves quota unchanged', async () => {
  const f = fixture({ resolveReply: async () => ({ ok: false }) });
  await assert.rejects(f.run({ messages: ['hello'], replyToMessageId: '12' }), { code: 'INVALID_REPLY_TARGET' });
  assert.equal(f.state.sendTimes.length, 0); assert.equal(f.sends.length, 0);
});

test('each queued write receives a live authority check, and partial sends are recorded exactly once', async () => {
  let f, checked = 0;
  f = fixture({ send: async (_key, messages, _delays, _reply, _at, guard) => {
    guard(); checked++; f.revoke();
    try { guard(); } catch (error) { error.sent = [messages[0]]; throw error; }
  } });
  await assert.rejects(f.run({ messages: ['first', 'second'] }), /revoked/);
  assert.equal(checked, 1); assert.equal(f.state.sendTimes.length, 1);
  assert.deepEqual(f.records, [{ key: 'group:1', messages: ['first'] }]);
});

test('failure to persist a successful send does not record it a second time', async () => {
  const f = fixture({ saveState() { throw new Error('disk unavailable'); } });
  await assert.rejects(f.run(), /disk unavailable/);
  assert.equal(f.sends.length, 1); assert.equal(f.records.length, 1);
  assert.equal(f.state.sendTimes.length, 1);
});

test('private @ is rejected and changing a tool limit during preparation is rechecked', async () => {
  const f = fixture();
  await assert.rejects(f.handler.prepare({ ...f.input, target: 'private:2', payload: { messages: ['hello'], atUserId: '3' } }), { code: 'INVALID_ARGUMENTS' });
  const payload = await f.handler.prepare({ ...f.input, payload: { messages: ['first', 'second'] } });
  f.config.burstEnabled = false;
  await assert.rejects(f.handler.dispatch({ ...f.input, payload }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(f.sends.length, 0);
});
