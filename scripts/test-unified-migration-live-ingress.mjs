import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createUnifiedBridgeDriver, assertMigrationStartup } from '../src/unified/bridge-driver.js';
import { MigrationIngress, createMigrationBarrier } from '../src/unified/migration-ingress.js';
import { MigrationStage } from '../src/unified/migration-stage.js';
import { UnifiedStore } from '../src/unified/store.js';
import { captureMigrationSnapshot, loadMigrationSnapshot, MIGRATION_SOURCE_FILES } from '../src/unified/migration-snapshot.js';
import { importStagedMigration } from '../src/unified/migration-import.js';
import { activateStagedMigration } from '../src/unified/migration-activate.js';
import { replayUnifiedIngress, persistUnifiedIngress } from '../src/unified/migration-live-ingress.js';

const current = { account: '100', sourceAccount: '100', epoch: 'fixture', provenance: 'fixture-proof' };
const event = (id = 'new') => ({ account: '100', scene: 'group:1', sourceId: id, kind: 'message', at: 1000, payload: { text: 'complete body', media: [] } });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-ingress-'));
  let journal, store;
  const open = () => {
    journal = new MigrationIngress({ file: path.join(root, 'ingress.sqlite'), verifyPrivate: () => true, assertExclusive: () => true });
    store = new UnifiedStore(path.join(root, 'unified.sqlite'));
  };
  const close = () => { journal?.close(); store?.close(); journal = store = undefined; };
  open();
  const stage = new MigrationStage({ file: path.join(root, 'stage.sqlite'), verifyPrivate: () => true });
  t.after(() => { close(); stage.close(); fs.rmSync(root, { recursive: true, force: true }); });
  journal.begin(current);
  const lease = { assert: () => ({ ...current, quiesced: true }), release() {} };
  const files = Object.fromEntries(Object.keys(MIGRATION_SOURCE_FILES).map(key => [key, null]));
  files['social-v2.json'] = Buffer.from('{"paused":true,"conversations":{}}');
  files['sessions.json'] = Buffer.from('{"sessions":{}}'); files['config.json'] = Buffer.from('{}');
  const captured = await captureMigrationSnapshot({ root, verifyPrivate: () => true, acquire: () => lease, readFiles: () => files });
  const handle = loadMigrationSnapshot({ ...captured, expectedAccount: '100', attest: () => true, verifyPrivate: () => true });
  journal.bindSnapshot(current, handle); stage.importSnapshot(handle);
  importStagedMigration({ store, stage, account: '100', assertExclusive: () => true });
  return { root, stage, handle, lease, open, close, get journal() { return journal; }, get store() { return store; },
    activate: () => activateStagedMigration({ journal, store, stage, handle, lease }),
    options: () => ({ journal, store, current, wakeAllowed: () => true }) };
}

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
