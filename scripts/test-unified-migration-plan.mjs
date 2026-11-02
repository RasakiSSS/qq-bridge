import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planLegacyQq } from '../src/unified/migration-plan.js';

function fixture() {
  const messages = [1, 2, 3].map(seq => ({ seq, messageId: String(seq), text: 'preview', time: 1000, userId: '200' }));
  return { account: '100', snapshotAccount: '100', snapshotId: 'a'.repeat(64), now: 2000,
    sessions: { 'group:1': 'old-session' }, social: { paused: true, conversations: { 'group:1': {
      agentToken: 'never-export-this', lastUnreadSeq: 3, lastReadThroughSeq: 1,
      recentMessages: messages, unread: [messages[2]],
      wakeConfig: { mode: 'diving', infinite: false, sleepUntil: new Date(1000).toISOString(), triggers: { atMention: true } },
    } } } };
}
test('dry plan preserves exact unread and uncertain gaps, never mutates or imports credentials', () => {
  const input = fixture(), before = JSON.stringify(input), result = planLegacyQq(input);
  assert.equal(JSON.stringify(input), before); assert.equal(result.applicable, false); assert.equal(result.paused, true);
  assert.deepEqual(result.scenes[0].events.map(e => e.readState), ['read', 'unknown', 'unread']);
  assert.ok(result.scenes[0].events.every(e => e.originalUnavailable));
  assert.equal(result.scenes[0].timer.dueAt, 1000); assert.equal(result.scenes[0].timer.overdue, true);
  assert.equal(result.scenes[0].legacySessionId, 'old-session');
  assert.ok(!JSON.stringify(result).includes('never-export-this'));
  assert.deepEqual(planLegacyQq(input), result);
});
test('unbound account and malformed watermark reject instead of guessing identity or advancing read state', () => {
  const input = fixture(); input.snapshotAccount = undefined;
  assert.throws(() => planLegacyQq(input), { code: 'MIGRATION_ACCOUNT_UNVERIFIED' });
  input.snapshotAccount = '200'; assert.throws(() => planLegacyQq(input), { code: 'MIGRATION_ACCOUNT_UNVERIFIED' });
  input.snapshotAccount = '100'; input.social.conversations['group:1'].lastReadThroughSeq = 4;
  assert.throws(() => planLegacyQq(input), { code: 'MIGRATION_INVALID_SOURCE' });
});
test('conflicting copies, read watermark overlap and duplicate gateway identities block application', () => {
  const input = fixture(), scene = input.social.conversations['group:1'];
  scene.unread = [{ ...scene.recentMessages[0], text: 'changed' }, scene.recentMessages[2]];
  scene.recentMessages[1].messageId = '3';
  const result = planLegacyQq(input);
  for (const reason of ['CONFLICTING_COPY', 'UNREAD_CONFLICT', 'DUPLICATE_MESSAGE_ID']) assert.ok(result.blockers.some(b => b.reason === reason));
});
test('infinite sleep stays infinite; missing history is reported and not fabricated', () => {
  const input = fixture(), scene = input.social.conversations['group:1'];
  scene.wakeConfig = { mode: 'diving', infinite: true, triggers: { anyMessage: false } };
  scene.lastUnreadSeq = 100;
  const result = planLegacyQq(input);
  assert.equal(result.scenes[0].timer, null); assert.equal(result.scenes[0].events.length, 3);
  assert.equal(result.scenes[0].preferences.triggers.anyMessage, false);
  assert.ok(result.warnings.some(w => w.reason === 'PRUNED_HISTORY_NOT_RECOVERABLE'));
});
