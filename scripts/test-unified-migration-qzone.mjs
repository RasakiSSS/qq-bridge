import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectLegacyQzone } from '../src/unified/migration-qzone.js';

const post = (authorQQ, tid) => ({ key: `post:${authorQQ}:${tid}`, authorQQ, tid, content: 'saved preview', time: 10 });
const comment = (status = 'new', ownerQQ = '100') => ({ key: JSON.stringify([ownerQQ, 'p', '', 'c']), ownerQQ,
  tid: 'p', parentId: '', commentId: 'c', authorQQ: '200', content: 'comment preview', time: 11000, status });
const state = () => ({ ownPosts: [], seenFeeds: [], pendingFeeds: [], knownPosts: {}, comments: {}, writes: [] });

test('own post is read while its new comment remains unread, stable keys and time units match collector', () => {
  const data = state(), own = post('100', 'p'), c = comment();
  data.ownPosts.push(own); data.pendingFeeds.push(own); data.comments[c.key] = c;
  const rows = projectLegacyQzone('100', data);
  assert.equal(rows.find(r => r.kind === 'qzone-feed').readState, 'read');
  assert.equal(rows.find(r => r.kind === 'qzone-feed').at, 10000);
  assert.equal(rows.find(r => r.kind === 'qzone-comment').readState, 'unread');
  assert.equal(rows.find(r => r.kind === 'qzone-comment').at, 11000);
  assert.ok(rows.every(r => r.payload.originalUnavailable));
  assert.deepEqual(projectLegacyQzone('100', data), rows);
});
test('seen requires retained content; absent pending is not proof of read, overlap blocks', () => {
  const data = state(), p = post('200', 'p'); data.knownPosts[p.key] = p;
  assert.equal(projectLegacyQzone('100', data)[0].readState, 'unknown');
  data.seenFeeds.push(p.key, 'post:200:evicted');
  assert.equal(projectLegacyQzone('100', data).length, 1);
  assert.equal(projectLegacyQzone('100', data)[0].readState, 'read');
  data.pendingFeeds.push(p);
  assert.throws(() => projectLegacyQzone('100', data), { code: 'MIGRATION_CONFLICT' });
});
test('replied intent with unknown result is not read; exact confirmed reply is evidence', () => {
  const data = state(), c = comment('replied'); data.comments[c.key] = c;
  const w = { kind: 'reply', commentKey: c.key, tid: c.tid, ownerQQ: c.ownerQQ, status: 'uncertain' }; data.writes.push(w);
  assert.equal(projectLegacyQzone('100', data)[0].readState, 'unknown');
  w.status = 'sent'; w.ownerQQ = '300';
  assert.equal(projectLegacyQzone('100', data)[0].readState, 'unknown');
  w.ownerQQ = c.ownerQQ;
  assert.equal(projectLegacyQzone('100', data)[0].readState, 'read');
});
test('historical is not read, unrelated comments are not unread, mentions qualify', () => {
  const data = state(), c = comment('historical'); data.comments[c.key] = c;
  assert.equal(projectLegacyQzone('100', data)[0].readState, 'unknown');
  const other = comment('new', '300'); data.comments = { [other.key]: other };
  assert.equal(projectLegacyQzone('100', data)[0].readState, 'unknown');
  other.mentioned = true;
  assert.equal(projectLegacyQzone('100', data)[0].readState, 'unread');
  other.status = 'read';
  assert.equal(projectLegacyQzone('100', data)[0].readState, 'read');
});
test('mismatched keys, authors and conflicting retained copies fail closed', () => {
  const data = state(), p = post('200', 'p'); data.pendingFeeds.push(p);
  data.knownPosts[p.key] = { ...p, content: 'different' };
  assert.throws(() => projectLegacyQzone('100', data), { code: 'MIGRATION_CONFLICT' });
  data.knownPosts = {}; p.key = 'post:300:p';
  assert.throws(() => projectLegacyQzone('100', data), { code: 'MIGRATION_INVALID_SOURCE' });
  assert.throws(() => projectLegacyQzone('100', { ...state(), ownPosts: [post('200', 'p')] }), { code: 'MIGRATION_INVALID_SOURCE' });
});
test('invalid timestamps stay absent rather than using migration clock', () => {
  const data = state(), p = post('200', 'p'); p.time = null; data.pendingFeeds.push(p);
  assert.equal(projectLegacyQzone('100', data)[0].at, null);
  assert.deepEqual(projectLegacyQzone('100', null), []);
});
