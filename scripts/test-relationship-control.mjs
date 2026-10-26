import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  RELATION_ACTIONS,
  createRelationshipStore,
  normalizeFriendRequestEvent,
  normalizeRelationshipAction,
  parseRelationshipId,
  relationshipActionResult,
  relationshipConfig,
  relationshipToolFlag,
} from '../src/relationship-control.js';

function tempFile(name = 'relationships.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-relationship-'));
  return { dir, file: path.join(dir, name) };
}

test('relationship config is disabled by default and native request stays disabled', () => {
  const config = relationshipConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.actions.nativeFriendRequest, false);
  assert.equal(relationshipToolFlag('list_requests'), 'relationships');
  assert.equal(relationshipToolFlag('unknown'), null);
});

test('safe relationship ids accept canonical decimal strings and reject unsafe values', () => {
  assert.deepEqual(parseRelationshipId('00123', 'user_id'), { text: '123', number: 123 });
  assert.deepEqual(parseRelationshipId(456, 'group_id'), { text: '456', number: 456 });
  assert.throws(() => parseRelationshipId('0', 'user_id'), /正十进制/);
  assert.throws(() => parseRelationshipId('9007199254740992', 'user_id'), /安全整数/);
  assert.throws(() => parseRelationshipId(1.5, 'user_id'), /正整数/);
});

test('request actions map to the exact OneBot payload and default rejection does not block', () => {
  assert.deepEqual(normalizeRelationshipAction(RELATION_ACTIONS.ACCEPT_REQUEST, { flag: 'f' }).onebotParams, { flag: 'f', approve: true });
  assert.deepEqual(normalizeRelationshipAction(RELATION_ACTIONS.REJECT_REQUEST, { flag: 'f' }).onebotParams, { flag: 'f', approve: false });
  assert.deepEqual(normalizeRelationshipAction(RELATION_ACTIONS.DELETE_FRIEND, { user_id: '123' }).onebotParams, { user_id: 123, block: false });
  assert.deepEqual(normalizeRelationshipAction(RELATION_ACTIONS.LEAVE_GROUP, { groupId: '456' }).onebotParams, { group_id: 456 });
  assert.throws(() => normalizeRelationshipAction(RELATION_ACTIONS.DELETE_FRIEND, { user_id: '1', packet: 'raw' }), /未知参数/);
});

test('friend request event requires a friend request and keeps sanitized bounded evidence', () => {
  const event = normalizeFriendRequestEvent({ post_type: 'request', request_type: 'friend', flag: 'flag-1', user_id: '007', comment: '  hello  ', time: 10 }, { now: () => 99, sanitize: (text) => text.replace('hello', 'safe') });
  assert.deepEqual(event, {
    id: 'friend-request:flag-1', type: 'friend_request', requestType: 'friend', flag: 'flag-1', userId: '7',
    subType: null, comment: 'safe', receivedAt: 10000, status: 'pending', updatedAt: 99,
  });
  assert.throws(() => normalizeFriendRequestEvent({ post_type: 'request', request_type: 'group', flag: 'f', user_id: '1' }), /request_type=friend/);
  assert.throws(() => normalizeFriendRequestEvent({ post_type: 'request', request_type: 'friend', user_id: '1' }), /flag/);
});

test('store deduplicates requests and persists accepted/rejected history', () => {
  const { file } = tempFile();
  let clock = 1000;
  const store = createRelationshipStore({ file, now: () => clock, sanitize: (text) => text });
  const first = store.recordRequest({ post_type: 'request', request_type: 'friend', flag: 'same', user_id: '100', comment: 'one' });
  clock += 1;
  const duplicate = store.recordRequest({ post_type: 'request', request_type: 'friend', flag: 'same', user_id: '100', comment: 'two' });
  assert.equal(first.id, duplicate.id);
  assert.equal(store.listPending().length, 1);
  const accepted = store.recordAction({ action: RELATION_ACTIONS.ACCEPT_REQUEST, requestId: first.id, ok: true, data: { result: 0, context: 'private' } });
  assert.equal(accepted.status, 'succeeded');
  assert.equal(store.listPending().length, 0);
  const reopened = createRelationshipStore({ file, now: () => clock });
  assert.equal(reopened.status().history, 1);
  assert.equal(reopened.snapshot().pending[0].status, 'accepted');
  assert.equal(reopened.snapshot().pending[0].comment, 'two');
  assert.equal(reopened.snapshot().history[0].data, undefined);
});

test('failed and unknown outcomes remain distinct and do not claim relationship success', () => {
  const { file } = tempFile();
  const store = createRelationshipStore({ file });
  store.recordRequest({ post_type: 'request', request_type: 'friend', flag: 'f', user_id: '1' });
  const failed = store.recordAction({ action: RELATION_ACTIONS.REJECT_REQUEST, requestId: 'friend-request:f', ok: false, error: new Error('retcode 1') });
  assert.equal(failed.status, 'failed');
  assert.equal(store.snapshot().pending[0].status, 'failed');
  const unknown = relationshipActionResult(RELATION_ACTIONS.DELETE_FRIEND, { ok: false, error: Object.assign(new Error('transport'), { unknown: true }) });
  assert.equal(unknown.status, 'unknown');
});

test('result sanitizer excludes opaque request and response payloads', () => {
  const result = relationshipActionResult(RELATION_ACTIONS.DELETE_FRIEND, { ok: true, data: { result: 0, errMsg: '', context: { secret: 'x' }, req: { raw: true }, rsp: { raw: true } } });
  assert.deepEqual(result.data, { result: 0, errMsg: '' });
});

test('corrupt state fails closed and never overwrites the original file', () => {
  const { file } = tempFile();
  fs.writeFileSync(file, '{broken', 'utf8');
  const store = createRelationshipStore({ file });
  assert.equal(store.isWritable(), false);
  assert.throws(() => store.recordRequest({ post_type: 'request', request_type: 'friend', flag: 'f', user_id: '1' }), /只读降级/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
