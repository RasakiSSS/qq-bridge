import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { MigrationIngress, createMigrationBarrier } from '../src/unified/migration-ingress.js';
import { MigrationStage } from '../src/unified/migration-stage.js';
import { UnifiedStore } from '../src/unified/store.js';
import { importStagedMigration } from '../src/unified/migration-import.js';
import { importMigrationDeltas } from '../src/unified/migration-delta.js';
import { captureMigrationSnapshot, loadMigrationSnapshot, MIGRATION_SOURCE_FILES } from '../src/unified/migration-snapshot.js';

const who = () => ({ account: '100', sourceAccount: '100', epoch: 'epoch-1', provenance: 'operator-fixture' });
const event = (sourceId = 'm1') => ({ account: '100', scene: 'group:1', sourceId, kind: 'message', at: 1000, payload: { text: 'full fixture', media: [] } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-ingress-'));
  const file = path.join(root, 'ingress.sqlite'); let journal, exclusive = true;
  const open = () => journal = new MigrationIngress({ file, verifyPrivate: () => true, assertExclusive: () => exclusive });
  open(); t.after(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, get journal() { return journal; }, reopen() { journal.close(); open(); }, revoke() { exclusive = false; } };
}
async function snapshot(f, acquire) {
  const files = Object.fromEntries(Object.keys(MIGRATION_SOURCE_FILES).map(name => [name, null]));
  files['social-v2.json'] = Buffer.from(JSON.stringify({ paused: false, conversations: {} }));
  files['sessions.json'] = Buffer.from('{"sessions":{}}'); files['config.json'] = Buffer.from('{}');
  const captured = await captureMigrationSnapshot({ root: f.root, acquire, verifyPrivate: () => true, readFiles: () => files });
  return loadMigrationSnapshot({ ...captured, expectedAccount: '100', attest: () => true, verifyPrivate: () => true });
}

test('ingress precedes any snapshot, persists across reopen and deduplicates canonical content', t => {
  const f = fixture(t), j = f.journal;
  assert.throws(() => j.append(who(), event()), { code: 'MIGRATION_BARRIER_REQUIRED' });
  j.begin(who()); const first = j.append(who(), event()); assert.equal(first.durable, true);
  const reordered = { ...event(), payload: { media: [], text: 'full fixture' } };
  assert.equal(j.append(who(), reordered).duplicate, true);
  assert.throws(() => j.append(who(), { ...event(), payload: { text: 'different' } }), { code: 'MIGRATION_CONFLICT' });
  f.reopen(); assert.equal(f.journal.active(), true);
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM conflicts').get().n, 1);
  assert.throws(() => f.journal.assertReady(who()), { code: 'MIGRATION_CONFLICT' });
  assert.equal(f.journal.append(who(), event()).seq, first.seq);
  assert.equal(f.journal.append(who(), event('next')).durable, true);
  assert.equal(f.journal.begin(who()), false);
});
test('different login epoch, account, source attestation and lost ownership cannot write', t => {
  const f = fixture(t); f.journal.begin(who());
  for (const change of [{ epoch: 'epoch-2' }, { provenance: 'another-attestation' }, { account: '200', sourceAccount: '200' }]) {
    assert.throws(() => f.journal.begin({ ...who(), ...change }), { code: 'MIGRATION_SOURCE_CHANGED' });
  }
  assert.throws(() => f.journal.append(who(), { ...event(), account: '200' }), { code: 'MIGRATION_INVALID_SOURCE' });
  assert.throws(() => f.journal.begin({ ...who(), sourceAccount: '200' }), { code: 'MIGRATION_ACCOUNT_UNVERIFIED' });
  f.revoke(); assert.throws(() => f.journal.append(who(), event()), { code: 'MIGRATION_EXCLUSIVE_REQUIRED' });
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM incoming').get().n, 0);
});
test('barrier drains accepted legacy work, routes new incoming durably and release never resumes', async t => {
  const f = fixture(t); let finish, flushes = 0, delivered = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const barrier = createMigrationBarrier({ journal: f.journal, currentIdentity: who,
    assertLegacyIdle: () => true, flushLegacy: () => { flushes++; return true; } });
  const old = barrier.ingest(event('old'), async () => { await pending; delivered++; });
  const acquiring = barrier.acquire();
  const saved = await barrier.ingest(event('new'), () => { throw Error('must not enter legacy'); });
  assert.equal(saved.durable, true); assert.equal(flushes, 0);
  assert.throws(() => barrier.runLegacy(() => {}), { code: 'MIGRATION_PENDING' });
  finish(); await old; const lease = await acquiring;
  assert.equal(flushes, 1); assert.equal(delivered, 1); assert.equal(lease.assert().quiesced, true);
  lease.release(); assert.throws(() => lease.assert(), { code: 'MIGRATION_NOT_QUIESCED' });
  assert.throws(() => barrier.runLegacy(() => {}), { code: 'MIGRATION_PENDING' });
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM incoming').get().n, 1);
});
test('failed preflight and identity change retain routing lock without claiming quiescence', async t => {
  const f = fixture(t); let current = who();
  const barrier = createMigrationBarrier({ journal: f.journal, currentIdentity: () => current,
    assertLegacyIdle: () => false, flushLegacy: () => { throw Error('should not flush'); } });
  await assert.rejects(barrier.acquire(), { code: 'LEGACY_SESSION_BUSY' });
  assert.equal(f.journal.active(), true);
  current = { ...who(), epoch: 'changed' };
  await assert.rejects(barrier.acquire(), { code: 'MIGRATION_SOURCE_CHANGED' });
  assert.throws(() => barrier.ingest(event(), () => {}), { code: 'MIGRATION_SOURCE_CHANGED' });
});

test('quiescence timeout keeps durable routing and drains late legacy work before retry', async t => {
  const f = fixture(t); let finish, idleChecks = 0;
  const waiting = new Promise(resolve => { finish = resolve; });
  const barrier = createMigrationBarrier({ journal: f.journal, currentIdentity: who, timeoutMs: 200,
    assertLegacyIdle: () => { idleChecks++; return true; }, flushLegacy: () => true });
  const old = barrier.runLegacy(() => waiting);
  await assert.rejects(barrier.acquire(), { code: 'MIGRATION_QUIESCE_TIMEOUT' });
  assert.equal(idleChecks, 0); assert.equal(f.journal.active(), true);
  assert.equal((await barrier.ingest(event(), () => assert.fail('legacy delivery'))).durable, true);
  assert.throws(() => barrier.runLegacy(() => {}), { code: 'MIGRATION_PENDING' });
  finish(); await old;
  const lease = await barrier.acquire(); assert.equal(lease.assert().quiesced, true); lease.release();
});

test('late idle response after timeout cannot trigger flush and stays tracked across retries', async t => {
  const f = fixture(t); let finish, idleChecks = 0, flushes = 0;
  const waiting = new Promise(resolve => { finish = resolve; });
  const barrier = createMigrationBarrier({ journal: f.journal, currentIdentity: who, timeoutMs: 200,
    assertLegacyIdle: () => { idleChecks++; return idleChecks === 1 ? waiting : true; },
    flushLegacy: () => { flushes++; return true; } });
  await assert.rejects(barrier.acquire(), { code: 'MIGRATION_QUIESCE_TIMEOUT' });
  await assert.rejects(barrier.acquire(), { code: 'MIGRATION_QUIESCE_TIMEOUT' });
  assert.equal(idleChecks, 1); assert.equal(flushes, 0);
  finish(true); await waiting;
  const lease = await barrier.acquire(); assert.equal(flushes, 1); lease.release();
});

test('late flush must finish before another acquisition, and invalid deadlines cannot open barrier', async t => {
  const f = fixture(t); let finish, flushes = 0, idleChecks = 0;
  const waiting = new Promise(resolve => { finish = resolve; });
  const options = { journal: f.journal, currentIdentity: who,
    assertLegacyIdle: () => { idleChecks++; return true; },
    flushLegacy: () => { flushes++; return flushes === 1 ? waiting : true; } };
  for (const timeoutMs of [0, -1, Infinity, 60001, 1.5]) {
    assert.throws(() => createMigrationBarrier({ ...options, timeoutMs }), { code: 'MIGRATION_INVALID_TIMEOUT' });
  }
  assert.equal(f.journal.active(), false);
  const barrier = createMigrationBarrier({ ...options, timeoutMs: 200 });
  await assert.rejects(barrier.acquire(), { code: 'MIGRATION_QUIESCE_TIMEOUT' });
  await assert.rejects(barrier.acquire(), { code: 'MIGRATION_QUIESCE_TIMEOUT' });
  assert.equal(flushes, 1); assert.equal(idleChecks, 1);
  finish(true); await waiting;
  const lease = await barrier.acquire(); assert.equal(flushes, 2); lease.release();
});

test('conflicts arriving during idle check block the snapshot but remain durable with later messages', async t => {
  const f = fixture(t);
  const barrier = createMigrationBarrier({ journal: f.journal, currentIdentity: who,
    assertLegacyIdle: () => {
      f.journal.append(who(), event());
      assert.throws(() => f.journal.append(who(), { ...event(), payload: { text: 'conflict' } }), { code: 'MIGRATION_CONFLICT' });
      return true;
    }, flushLegacy: () => true });
  await assert.rejects(barrier.acquire(), { code: 'MIGRATION_CONFLICT' });
  assert.equal((await barrier.ingest(event('later'), () => {})).durable, true);
  f.reopen(); assert.throws(() => f.journal.assertReady(who()), { code: 'MIGRATION_CONFLICT' });
});
test('snapshot capture integrates with barrier; transfer retries safely after destination commit interruption', async t => {
  const f = fixture(t);
  const barrier = createMigrationBarrier({ journal: f.journal, currentIdentity: who, assertLegacyIdle: () => true, flushLegacy: () => true });
  const handle = await snapshot(f, barrier.acquire);
  await barrier.ingest(event(), () => { throw Error('not legacy'); });
  f.journal.bindSnapshot(who(), handle);
  assert.throws(() => f.journal.bindSnapshot(who(), { ...handle }), { code: 'MIGRATION_SNAPSHOT_UNVERIFIED' });
  const stage = new MigrationStage({ file: path.join(f.root, 'stage.sqlite'), verifyPrivate: () => true });
  try {
    assert.throws(() => f.journal.transfer(who(), stage), { code: 'MIGRATION_SNAPSHOT_REQUIRED' });
    stage.importSnapshot(handle);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import {MigrationIngress} from ${JSON.stringify(new URL('../src/unified/migration-ingress.js', import.meta.url).href)};
      import {MigrationStage} from ${JSON.stringify(new URL('../src/unified/migration-stage.js', import.meta.url).href)};
      const j=new MigrationIngress({file:process.argv[1],verifyPrivate:()=>true,assertExclusive:()=>true});
      const stage=new MigrationStage({file:process.argv[2],verifyPrivate:()=>true});
      j.transfer(${JSON.stringify(who())},stage,{checkpoint(){process.exit(74)}});
    `, f.file, path.join(f.root, 'stage.sqlite')], { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 74, child.stderr);
    f.reopen();
    assert.equal(f.journal.transfer(who(), stage).pending, 0);
    assert.equal(stage.db.prepare('SELECT COUNT(*) AS n FROM delta_events').get().n, 1);
    assert.equal(f.journal.transfer(who(), stage).transferred, 0);
    assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM incoming').get().n, 1);
    assert.equal(stage.rollbackPlan('100').incoming[0].payload.text, 'full fixture');
    const replaced = new MigrationStage({ file: path.join(f.root, 'other-stage.sqlite'), verifyPrivate: () => true });
    try {
      replaced.importSnapshot(handle);
      assert.throws(() => f.journal.transfer(who(), replaced), { code: 'MIGRATION_DELTA_REQUIRES_RECONCILIATION' });
    } finally { replaced.close(); }
    const store = new UnifiedStore(path.join(f.root, 'unified.sqlite'));
    try {
      const opts = { store, stage, account: '100', assertExclusive: () => true };
      assert.throws(() => importStagedMigration(opts), { code: 'MIGRATION_DELTA_REQUIRES_RECONCILIATION' });
      importStagedMigration({ ...opts, retainDeltas: true });
      stage.action('100', 'uncertain-send', 'unknown');
      assert.equal(importMigrationDeltas(opts).imported, 1);
      assert.equal(importMigrationDeltas(opts).duplicate, 1);
      const row = store.db.prepare('SELECT * FROM events').get();
      assert.equal(row.unread, 1); assert.equal(row.wake, 0);
      assert.equal(JSON.parse(row.payload).originalUnavailable, undefined);
      assert.equal(store.db.prepare('SELECT phase FROM migration_imports').get().phase, 'staged');
      assert.equal(store.db.prepare('SELECT paused FROM accounts').get().paused, 1);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM migration_preserved WHERE category LIKE 'delta-action:%'").get().n, 1);
      stage.appendDelta('100', { ...event('newer'), payload: { text: 'newer' } });
      assert.throws(() => importMigrationDeltas({ ...opts, checkpoint() { throw Error('delta failure'); } }), /delta failure/);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
      assert.equal(importMigrationDeltas(opts).imported, 1);
    } finally { store.close(); }
  } finally { stage.close(); }
});
test('committed event survives abrupt process exit; uncommitted event does not advance receipt', t => {
  const f = fixture(t); f.journal.begin(who());
  const moduleUrl = new URL('../src/unified/migration-ingress.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {MigrationIngress} from ${JSON.stringify(moduleUrl)};
    const j=new MigrationIngress({file:process.argv[1],verifyPrivate:()=>true,assertExclusive:()=>true});
    j.append(${JSON.stringify(who())},${JSON.stringify(event('committed'))});
    j.transaction(()=>{j.db.prepare('INSERT INTO incoming(scene,source_id,kind,payload,at,fingerprint) VALUES(?,?,?,?,?,?)').run('group:1','partial','message','{}',1,'partial');process.exit(73)});
  `, f.file], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 73, child.stderr); f.reopen();
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM incoming').get().n, 1);
  assert.equal(f.journal.append(who(), event('committed')).duplicate, true);
});
