import { createUnifiedSendHandler } from './send-handler.js';
import { fail } from './store.js';

// Reuses bridge policies and its single outbound queue; never issues HTTP here.
export function createBridgeSendHandler({ assertAllowed, getConfig, getState, saveState, audit, resolveReply, send, record, computeDelays, now = Date.now }) {
  for (const callback of [assertAllowed, getConfig, getState, saveState, audit, resolveReply, send, record, computeDelays]) {
    if (typeof callback !== 'function') throw fail('SEND_ADAPTER_REQUIRED');
  }
  function validate(target, payload) {
    assertAllowed(target);
    const cfg = getConfig();
    const messages = payload.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > Math.max(1, Number(cfg.burstMaxMessages) || 8)
      || (cfg.burstEnabled === false && messages.length > 1)) throw fail('INVALID_ARGUMENTS');
    for (const message of messages) {
      if (typeof message !== 'string' || !message.trim() || message.length > Math.max(1, Number(cfg.maxMessageChars) || 500)) throw fail('INVALID_ARGUMENTS');
      audit(target, message);
    }
    return cfg;
  }
  function checkRate(target, count, cfg) {
    const time = now(), state = getState(target);
    for (const [limit, duration] of [[cfg.maxSendPerMinute, 60000], [cfg.maxSendPerHour, 3600000]]) {
      if (Number(limit) > 0 && state.sendTimes.filter(at => time - at < duration).length + count > Number(limit)) throw fail('SEND_RATE_LIMITED');
    }
    return { time, state };
  }
  return createUnifiedSendHandler({
    prepare: async ({ target, payload }) => {
      const cfg = validate(target, payload); checkRate(target, payload.messages.length, cfg);
      return payload;
    },
    send: async ({ target, payload, assertCurrent }) => {
      const guard = () => { assertCurrent(); validate(target, payload); };
      guard();
      let reply = payload.replyToMessageId;
      if (reply) {
        const resolved = await resolveReply(target, reply); guard();
        if (!resolved?.ok) throw fail('INVALID_REPLY_TARGET');
        reply = resolved.messageId;
      }
      const cfg = getConfig(), { time, state } = checkRate(target, payload.messages.length, cfg);
      const delays = computeDelays(payload.messages, cfg);
      for (const message of payload.messages) state.sendTimes.push(time);
      let sent = [], recorded = false;
      try {
        sent = await send(target, payload.messages, delays, reply, payload.atUserId, guard);
        recorded = true;
        record(target, sent);
        state.lastAiReplyAt = time; state.lastActionAt = time;
        if (state.wakeConfig) state.wakeConfig.noActionCount = 0;
        if (state.sendTimes.length > 500) state.sendTimes = state.sendTimes.slice(-500);
        saveState();
        return { status: 'succeeded', result: { sent: sent.length, failed: payload.messages.length - sent.length } };
      } catch (error) {
        if (Array.isArray(error?.sent)) sent = error.sent;
        if (sent.length && !recorded) record(target, sent);
        // An uncertain external send is not replayed by the action ledger.
        for (let i = sent.length; i < payload.messages.length; i++) {
          const index = state.sendTimes.indexOf(time); if (index >= 0) state.sendTimes.splice(index, 1);
        }
        if (state.sendTimes.length > 500) state.sendTimes = state.sendTimes.slice(-500);
        saveState();
        throw error;
      }
    },
  });
}
