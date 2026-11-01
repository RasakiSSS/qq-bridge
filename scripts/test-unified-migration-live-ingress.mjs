import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createUnifiedBridgeDriver, assertMigrationStartup } from '../src/unified/bridge-driver.js';
import { createMigrationBarrier } from '../src/unified/migration-ingress.js';
import { replayUnifiedIngress, persistUnifiedIngress } from '../src/unified/migration-live-ingress.js';

import { cutoverFixture as fixture, current } from './fixture-unified-cutover.mjs';
const event = (id = 'new') => ({ account: '100', scene: 'group:1', sourceId: id, kind: 'message', at: 1000, payload: { text: 'complete body', media: [] } });

test('after activation arrivals remain durable while target is unavailable, then replay without DSH or legacy work', async t => {
  const f = await fixture(t); f.activate();
  const broken = { ...f.options(), store: { db: { prepare() { throw Error('target unavailable'); } } } };
  assert.throws(() => persistUnifiedIngress(broken, event()), /target unavailable/);
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM incoming').get().n, 1);
  f.close(); f.open();
  assert.equal(replayUnifiedIngress(f.options()).imported, 1);
  const row = f.store.db.prepare('SELECT * FROM events').get();
  assert.equal(row.unread, 1); assert.equal(row.wake, 1); assert.equal(row.at, 1000);
  assert.equal(f.store.account('100').paused, 1);
  assert.equal(persistUnifiedIngress(f.options(), event()).receipt.duplicate, true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
});

test('process exit after target commit retries receipt without duplicating or restoring read state', async t => {
  const f = await fixture(t); f.activate(); f.journal.append(current, event()); f.close();
  const code = `import {MigrationIngress} from './src/unified/migration-ingress.js';
import {UnifiedStore} from './src/unified/store.js';
import {replayUnifiedIngress} from './src/unified/migration-live-ingress.js';
const root=process.argv[1];
const journal=new MigrationIngress({file:root+'/ingress.sqlite',verifyPrivate:()=>true,assertExclusive:()=>true});
const store=new UnifiedStore(root+'/unified.sqlite');
replayUnifiedIngress({journal,store,current:JSON.parse(process.argv[2]),wakeAllowed:()=>true,checkpoint:()=>process.exit(19)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.root, JSON.stringify(current)], { encoding: 'utf8' });
  assert.equal(child.status, 19, child.stderr); f.open();
  assert.equal(f.journal.db.prepare('SELECT transferred FROM barrier').get().transferred, 0);
  f.store.db.prepare('UPDATE events SET unread=0').run();
  const retried = replayUnifiedIngress(f.options()); assert.equal(retried.duplicate, 1);
  assert.equal(f.store.db.prepare('SELECT unread FROM events').get().unread, 0);
});

test('lost committed target receipt cannot be skipped by a journal cursor', async t => {
  const f = await fixture(t); f.activate(); persistUnifiedIngress(f.options(), event());
  f.store.db.prepare("DELETE FROM migration_preserved WHERE category LIKE 'live-ingress:%'").run();
  assert.throws(() => replayUnifiedIngress(f.options()), { code: 'MIGRATION_DELTA_REQUIRES_RECONCILIATION' });
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM incoming').get().n, 1);
});

test('staged, wrong identity and invalid wake cannot advance cursor; malformed requests remain durable', async t => {
  const f = await fixture(t);
  assert.throws(() => replayUnifiedIngress(f.options()), { code: 'MIGRATION_PENDING' }); f.activate();
  assert.throws(() => persistUnifiedIngress({ ...f.options(), current: { ...current, epoch: 'changed' } }, event()), { code: 'MIGRATION_SOURCE_CHANGED' });
  assert.throws(() => persistUnifiedIngress({ ...f.options(), wakeAllowed: () => Promise.resolve(true) }, event()), { code: 'MIGRATION_INVALID_WAKE' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  replayUnifiedIngress(f.options());
  const request = { ...event('request'), kind: 'friend-request', payload: { flag: 'fixture' } };
  assert.throws(() => persistUnifiedIngress(f.options(), request), { code: 'MIGRATION_INVALID_SOURCE' });
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM incoming').get().n, 2);
  assert.equal(f.journal.db.prepare('SELECT transferred FROM barrier').get().transferred, 1);
});

test('own Qzone feed remains read without hiding a comment; bounded replay drains a backlog', async t => {
  const f = await fixture(t); f.activate();
  f.journal.append(current, { ...event('post:100:p'), scene: 'qzone', kind: 'qzone-feed', payload: { text: 'own', authorQQ: '100' } });
  f.journal.append(current, { ...event('["100","p","","c"]'), scene: 'qzone', kind: 'qzone-comment', payload: { text: 'comment', authorQQ: '200', ownerQQ: '100' } });
  assert.equal(replayUnifiedIngress({ ...f.options(), limit: 1 }).pending, 1);
  assert.equal(replayUnifiedIngress({ ...f.options(), limit: 1 }).pending, 0);
  assert.deepEqual(f.store.db.prepare('SELECT unread,wake FROM events ORDER BY seq').all().map(r => [r.unread,r.wake]), [[0,0],[1,1]]);
});


test('existing barrier and driver replay committed cutover while DSH readiness is false', async t => {
  const f = await fixture(t); f.activate(); let available = false;
  const replay = () => { if (!available) throw Error('target offline'); return replayUnifiedIngress(f.options()); };
  const barrier = createMigrationBarrier({ journal: f.journal, currentIdentity: () => current,
    assertLegacyIdle: () => true, flushLegacy: () => true, replayPersisted: replay });
  await assert.rejects(barrier.ingest(event('barrier-arrival'), () => assert.fail('legacy called')), /target offline/);
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM incoming').get().n, 1);
  available = true;
  const driver = createUnifiedBridgeDriver({ createHost: () => assert.fail('DSH host must stay unopened'), ready: () => false, replayPersisted: replay });
  try {
    assert.equal((await driver.tick()).status, 'paused');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
    await barrier.ingest(event('second'), () => assert.fail('legacy called'));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
    assert.throws(() => barrier.runLegacy(() => {}), { code: 'MIGRATION_PENDING' });
  } finally { await driver.close(); }
});


test('friend requests before and after cutover reach private request table without exposing flags or reverting decisions', async t => {
  const f = await fixture(t);
  const request = flag => ({ account: '100', scene: 'private:200', kind: 'friend-request', sourceId: 'request-' + flag, at: 1000,
    payload: { self_id: 100, post_type: 'request', request_type: 'friend', user_id: 200, time: 1, flag, comment: 'fixture' } });
  f.journal.append(current, request('before')); f.journal.transfer(current, f.stage); f.activate();
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM friend_requests').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  f.journal.append(current, request('after'));
  assert.throws(() => replayUnifiedIngress({ ...f.options(), checkpoint: () => { throw Error('interrupt'); } }), /interrupt/);
  f.store.db.prepare("UPDATE friend_requests SET status='accepted'").run();
  assert.equal(replayUnifiedIngress(f.options()).duplicate, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE status='accepted'").get().n, 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  persistUnifiedIngress(f.options(), event('message-after-request'));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
});


test('real startup fence refuses configuration-only rollback and corrupt control without modifying the ledger', async t => {
  const f = await fixture(t), file = path.join(f.root, 'unified.sqlite');
  assert.throws(() => assertMigrationStartup(file, false), { code: 'MIGRATION_LEGACY_START_BLOCKED' });
  assert.doesNotThrow(() => assertMigrationStartup(file, true));
  f.activate(); f.close();
  const original = fs.readFileSync(file);
  assert.throws(() => assertMigrationStartup(file, false), { code: 'MIGRATION_LEGACY_START_BLOCKED' });
  assert.doesNotThrow(() => assertMigrationStartup(file, true));
  assert.deepEqual(fs.readFileSync(file), original);
  const corrupt = path.join(f.root, 'corrupt.sqlite'); fs.writeFileSync(corrupt, 'not a database');
  assert.throws(() => assertMigrationStartup(corrupt, false), { code: 'MIGRATION_STARTUP_UNVERIFIED' });
  assert.equal(fs.readFileSync(corrupt, 'utf8'), 'not a database');
  assert.doesNotThrow(() => assertMigrationStartup(path.join(f.root, 'absent.sqlite'), false));
});

test('a journal missing committed source rows cannot report a completed delivery cursor', async t => {
  const f = await fixture(t); f.activate();
  persistUnifiedIngress(f.options(), event('one')); persistUnifiedIngress(f.options(), event('two'));
  f.journal.db.prepare('DELETE FROM incoming WHERE seq=1').run();
  assert.throws(() => replayUnifiedIngress(f.options()), { code: 'MIGRATION_CONFLICT' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
});

test('bridge cutover route uses the attested journal and resumes a committed arrival before fresh traffic', async t => {
  const { openCutoverInbox } = await import('../src/unified/cutover-inbox.js');
  const f = await fixture(t);
  const options = { store: f.store, account: '100', file: path.join(f.root, 'ingress.sqlite'),
    assertOwner() {}, excluded: () => true, verifyPrivate: () => true, wakeAllowed: row => !!row.payload.reason };
  assert.throws(() => openCutoverInbox(options), { code: 'MIGRATION_PENDING' });
  f.activate();
  f.journal.append(current, event('between-processes'));
  assert.throws(() => openCutoverInbox({ ...options, account: '101' }), { code: 'MIGRATION_SOURCE_CHANGED' });
  assert.throws(() => openCutoverInbox({ ...options, file: path.join(f.root, 'missing') }), { code: 'MIGRATION_SOURCE_CHANGED' });
  const route = openCutoverInbox(options);
  try {
    const input = { key: 'group:1', sourceId: 'next', at: 2000, payload: { text: 'complete', reason: 'mention' } };
    route.ingest(input); route.ingest(input);
    const result = route.friendRequest({ self_id: 100, user_id: 123, post_type: 'request', request_type: 'friend', flag: 'fixture-request', time: 2 });
    assert.equal(result.status, 'pending');
    assert.equal(f.journal.db.prepare('SELECT transferred FROM barrier').get().transferred, 3);
    assert.deepEqual(f.store.db.prepare('SELECT source_id,wake FROM events ORDER BY seq').all().map(r => [r.source_id,r.wake]), [['between-processes',0],['next',1]]);
  } finally { route.close(); }
});

test('recollecting an identical imported Qzone preview preserves its read flag and never upgrades it to original text', async t => {
  const { openCutoverInbox } = await import('../src/unified/cutover-inbox.js');
  const feed = { key: 'post:999:one', authorQQ: '999', tid: 'one', time: 1, content: 'preview' };
  const data = { pendingFeeds: [], seenFeeds: [feed.key], knownPosts: { [feed.key]: feed }, comments: {}, ownPosts: [], writes: [] };
  const f = await fixture(t, { qzone: { version: 1, accounts: { '100': data } } }); f.activate();
  const route = openCutoverInbox({ store: f.store, account: '100', file: path.join(f.root, 'ingress.sqlite'), assertOwner() {},
    excluded: () => true, verifyPrivate: () => true, wakeAllowed: () => true });
  try {
    const input = { key: 'qzone', sourceId: feed.key, kind: 'qzone-feed', at: 1000, payload: { ...feed, text: feed.content } };
    route.ingest(input);
    assert.throws(() => route.ingest({ ...input, payload: { ...input.payload, text: 'edited' } }), { code: 'MIGRATION_CONFLICT' });
    const rows = f.store.db.prepare("SELECT unread,payload FROM events WHERE scene='qzone'").all();
    assert.equal(rows.length, 1); assert.equal(rows[0].unread, 0); assert.equal(JSON.parse(rows[0].payload).originalUnavailable, true);
    assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM incoming').get().n, 0);
  } finally { route.close(); }
});

test('attested gateway text upgrades exactly one legacy preview and retains the original read receipt state', async t => {
  const text = 'x'.repeat(200) + ' recovered middle ' + 'y'.repeat(200);
  const old = { seq: 1, messageId: '55', userId: '999', text: text.slice(0,200), plain: text.slice(0,200), tail: text.slice(-200), time: 1033 };
  const scene = { unread: [], recentMessages: [old], lastUnreadSeq: 1, lastReadThroughSeq: 1, wakeConfig: {} };
  const f = await fixture(t, { social: { paused: true, conversations: { 'group:1': scene } } }); f.activate();
  const before = f.store.db.prepare('SELECT seq,unread FROM events').get();
  const payload = { text, messageId: '55', senderQQ: '999', gatewayPlainText: true, media: [] };
  persistUnifiedIngress(f.options(), { ...event('55'), payload });
  const after = f.store.db.prepare('SELECT * FROM events').get();
  assert.equal(after.seq,before.seq); assert.equal(after.unread,0); assert.equal(after.at,1000); assert.equal(JSON.parse(after.payload).text,text);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT payload FROM migration_sources').get().payload).at,1033);
  assert.equal(replayUnifiedIngress(f.options()).pending,0);
});

test('unsequenced legacy outgoing previews survive candidate staging in order without generating unread messages or actions', async t => {
  const { cutoverFixture }=await import('./fixture-unified-cutover.mjs');
  const old={sender:'self',isSelf:true,text:'same',plain:'same',time:1000};
  const scene={unread:[],recentMessages:[old,{...old,time:2000}],lastUnreadSeq:0,lastReadThroughSeq:0,wakeConfig:{}};
  const f=await cutoverFixture(t,{social:{paused:false,conversations:{'group:456':scene}}});
  f.activate();
  const context=JSON.parse(f.store.db.prepare("SELECT payload FROM migration_preserved WHERE category='scene:group:456'").get().payload);
  assert.deepEqual(context.sentHistory.map(h=>[h.index,h.text,h.at]),[[0,'same',1000],[1,'same',2000]]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM actions').get().n,0);
});
