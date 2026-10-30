import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { MIGRATION_SOURCE_FILES, readLegacySnapshotFiles, captureMigrationSnapshot, loadMigrationSnapshot } from '../src/unified/migration-snapshot.js';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedAttention } from '../src/unified/attention.js';
import { importStagedMigration } from '../src/unified/migration-import.js';
import { importMigrationDeltas } from '../src/unified/migration-delta.js';
import { MigrationStage } from '../src/unified/migration-stage.js';

test('delta overlap with legacy preview blocks whole batch instead of overriding read state or text', async t => {
  const f = await fixture(t); f.stage.importSnapshot(f.handle);
  const store = new UnifiedStore(path.join(f.root, 'overlap.sqlite'));
  try {
    const opts = { store, stage: f.stage, account: '100', assertExclusive: () => true };
    importStagedMigration(opts);
    f.stage.appendDelta('100', { scene: 'group:1', sourceId: 'new-first', kind: 'message', at: 1001, payload: { text: 'complete' } });
    f.stage.appendDelta('100', { scene: 'group:1', sourceId: 'original-id', kind: 'message', at: 1002, payload: { text: 'preview longer original' } });
    assert.throws(() => importMigrationDeltas(opts), { code: 'MIGRATION_DELTA_REQUIRES_RECONCILIATION' });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM migration_preserved WHERE category LIKE 'delta:%'").get().n, 0);
  } finally { store.close(); }
});

test('new own posts stay read but new comments unread, and lease loss rolls back all deltas', async t => {
  const f = await fixture(t); f.stage.importSnapshot(f.handle);
  const store = new UnifiedStore(path.join(f.root, 'delta-space.sqlite'));
  try {
    let exclusive = true;
    const opts = { store, stage: f.stage, account: '100', assertExclusive: () => exclusive };
    importStagedMigration(opts);
    f.stage.appendDelta('100', { scene: 'qzone', sourceId: 'post:100:own', kind: 'qzone-feed', at: 1001, payload: { text: 'own', authorQQ: '100' } });
    f.stage.appendDelta('100', { scene: 'qzone', sourceId: '["100","own","","1"]', kind: 'qzone-comment', at: 1002, payload: { text: 'new comment', ownerQQ: '100', authorQQ: '200' } });
    assert.throws(() => importMigrationDeltas({ ...opts, checkpoint() { exclusive = false; } }), { code: 'MIGRATION_EXCLUSIVE_REQUIRED' });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE scene='qzone'").get().n, 0);
    exclusive = true; assert.equal(importMigrationDeltas(opts).imported, 2);
    const rows = store.db.prepare("SELECT kind,unread,wake FROM events WHERE scene='qzone' ORDER BY seq").all();
    assert.deepEqual(rows.map(row => row.unread), [0, 1]); assert.ok(rows.every(row => !row.wake));
  } finally { store.close(); }
});

test('Qzone import preserves exact read evidence and unknown replies without waking or enabling runtime', async t => {
  const f = await fixture(t), q = f.qzone.accounts['100'];
  q.ownPosts.push({ tid: 'own', authorQQ: '100', content: 'own preview', time: 10 });
  for (const [cid, status] of [['new', 'new'], ['read', 'read'], ['unknown', 'replied']]) {
    const key = JSON.stringify(['100', 'own', '', cid]);
    q.comments[key] = { key, ownerQQ: '100', tid: 'own', parentId: '', commentId: cid, authorQQ: '200', content: cid, time: 11000, status };
  }
  f.stage.importSnapshot(await f.snapshot());
  const store = new UnifiedStore(path.join(f.root, 'qzone-unified.sqlite'));
  try {
    const options = { store, stage: f.stage, account: '100', assertExclusive: () => true };
    importStagedMigration(options);
    const events = store.db.prepare("SELECT * FROM events WHERE scene='qzone'").all();
    assert.equal(events.length, 3);
    assert.equal(events.filter(r => r.unread).length, 1);
    assert.ok(events.every(r => !r.wake && !r.notified && JSON.parse(r.payload).originalUnavailable));
    const mappings = store.db.prepare("SELECT * FROM migration_sources WHERE scene='qzone'").all();
    assert.equal(mappings.length, 4);
    assert.equal(mappings.find(r => r.read_state === 'unknown').event_seq, null);
    assert.ok(mappings.every(r => r.legacy_seq === 0));
    assert.equal(importStagedMigration(options).status, 'already-imported');
    assert.equal(store.db.prepare("SELECT phase FROM migration_imports").get().phase, 'staged');
  } finally { store.close(); }
});

test('invalid Qzone projection rolls back QQ import and its migration lock in the same transaction', async t => {
  const f = await fixture(t);
  f.qzone.accounts['100'].pendingFeeds.push({ key: 'post:200:bad', authorQQ: '300', content: 'mismatch', time: 10 });
  f.stage.importSnapshot(await f.snapshot());
  const store = new UnifiedStore(path.join(f.root, 'invalid-qzone.sqlite'));
  try {
    assert.throws(() => importStagedMigration({ store, stage: f.stage, account: '100', assertExclusive: () => true }), { code: 'MIGRATION_INVALID_SOURCE' });
    for (const table of ['accounts', 'events', 'migration_sources', 'migration_imports']) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
    assert.equal(f.stage.db.prepare('SELECT COUNT(*) AS n FROM batches').get().n, 1);
  } finally { store.close(); }
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-migration-stage-'));
  let stage;
  t.after(() => { stage?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const row = { seq: 1, messageId: 'original-id', userId: '200', text: 'preview', time: 1000,
    media: [{ type: 'image', url: 'fixture-only' }], forwardIds: ['forward-id'] };
  const social = { paused: true, conversations: { 'group:1': { lastUnreadSeq: 1, lastReadThroughSeq: 0,
    unread: [row], recentMessages: [row], agentToken: 'private-fixture-token',
    wakeConfig: { mode: 'diving', infinite: false, sleepUntil: new Date(2000).toISOString(), triggers: { anyMessage: false } },
    pendingThoughts: [{ text: 'unfinished fixture' }], memberImpressions: { '200': 'fixture' } } } };
  const qzone = { version: 1, accounts: { '100': { ownPosts: [], seenFeeds: ['post:100:seen'], pendingFeeds: [], comments: {}, writes: [{ status: 'uncertain' }] }, '999': { private: 'other-account' } } };
  const files = { 'social-v2.json': social, 'sessions.json': { sessions: { 'group:1': 'old-session' } },
    'config.json': { secret: 'not-imported' }, 'qzone.json': qzone,
    'current-role.json': { role: 'fixture' }, 'initial-prompts.json': { 'group:1': 'background' } };
  for (const name of Object.keys(MIGRATION_SOURCE_FILES)) if (!(name in files)) files[name] = null;
  const snapshot = async () => {
    const captured = await captureMigrationSnapshot({ root, verifyPrivate: () => true,
      acquire: () => ({ assert: () => ({ account: '100', sourceAccount: '100', provenance: 'fixture-attestation', epoch: 'fixture', quiesced: true }), release() {} }),
      readFiles: () => Object.fromEntries(Object.entries(files).map(([name, value]) => [name, value === null ? null : Buffer.from(JSON.stringify(value))])) });
    return loadMigrationSnapshot({ ...captured, expectedAccount: '100', attest: () => true, verifyPrivate: () => true });
  };
  const file = path.join(root, 'stage.sqlite');
  const open = () => { stage = new MigrationStage({ file, verifyPrivate: () => true }); return stage; };
  open();
  return { root, file, social, qzone, row, snapshot, handle: await snapshot(), get stage() { return stage; },
    reopen() { stage.close(); return open(); } };
}
test('transactional stage preserves unread, media, local context, sleep and account-specific Qzone without credentials', async t => {
  const f = await fixture(t), result = f.stage.importSnapshot(f.handle);
  assert.equal(result.operational, false); assert.equal(result.messages, 1);
  const row = f.stage.db.prepare('SELECT * FROM messages').get();
  assert.equal(row.read_state, 'unread');
  assert.deepEqual(JSON.parse(row.payload).media, f.row.media);
  assert.deepEqual(JSON.parse(row.payload).forwardIds, ['forward-id']);
  const context = JSON.parse(f.stage.db.prepare('SELECT payload FROM scenes').get().payload);
  assert.equal(context.timer.dueAt, 2000); assert.equal(context.preferences.triggers.anyMessage, false);
  assert.equal(context.pendingThoughts[0].text, 'unfinished fixture');
  const preserved = f.stage.db.prepare('SELECT * FROM preserved').all();
  const qzone = JSON.parse(preserved.find(row => row.category === 'qzone').payload);
  assert.deepEqual(qzone.comments, {}); assert.equal(qzone.writes[0].status, 'uncertain');
  assert.ok(!JSON.stringify(preserved).includes('other-account'));
  const serialized = JSON.stringify([row, context, preserved]);
  assert.ok(!serialized.includes('private-fixture-token')); assert.ok(!serialized.includes('not-imported'));
});
test('same snapshot is idempotent after reopen; other snapshot cannot overwrite staged data', async t => {
  const f = await fixture(t); f.stage.importSnapshot(f.handle); f.reopen();
  assert.equal(f.stage.importSnapshot(f.handle).status, 'already-staged');
  const other = await f.snapshot();
  assert.throws(() => f.stage.importSnapshot(other), { code: 'MIGRATION_DIFFERENT_SNAPSHOT' });
  assert.equal(f.stage.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});
test('failure midway rolls back all sections; successful retry imports once', async t => {
  const f = await fixture(t);
  assert.throws(() => f.stage.importSnapshot(f.handle, { checkpoint() { throw Error('fixture interruption'); } }), /fixture interruption/);
  for (const table of ['batches', 'messages', 'scenes', 'preserved']) assert.equal(f.stage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  f.stage.importSnapshot(f.handle); assert.equal(f.stage.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});
test('process exit before commit leaves no partial import on disk', async t => {
  const f = await fixture(t);
  const moduleUrl = new URL('../src/unified/migration-stage.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { MigrationStage } from ${JSON.stringify(moduleUrl)};
    const stage = new MigrationStage({file:process.argv[1],verifyPrivate:()=>true});
    stage.transaction(()=>{stage.db.prepare('INSERT INTO batches VALUES(?,?,?,?)').run('100','incomplete',1,0);process.exit(73)});
  `, f.file], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 73, child.stderr);
  f.reopen(); assert.equal(f.stage.db.prepare('SELECT COUNT(*) AS n FROM batches').get().n, 0);
  assert.equal(f.stage.importSnapshot(f.handle).status, 'staged');
});
test('incremental rollback plans keep new input, do not replay actions, and block ambiguous legacy overlap', async t => {
  const f = await fixture(t); f.stage.importSnapshot(f.handle);
  const event = { scene: 'group:1', sourceId: 'new-id', kind: 'message', payload: { text: 'new original' }, at: 5000 };
  assert.equal(f.stage.appendDelta('100', event), true); assert.equal(f.stage.appendDelta('100', event), false);
  assert.throws(() => f.stage.appendDelta('100', { ...event, payload: { text: 'conflict' } }), { code: 'MIGRATION_CONFLICT' });
  f.stage.appendDelta('100', { ...event, sourceId: 'original-id' });
  f.stage.action('100', 'uncertain-send', 'unknown');
  f.stage.action('100', 'completed-send', 'succeeded');
  assert.throws(() => f.stage.action('100', 'uncertain-send', 'succeeded'), { code: 'MIGRATION_CONFLICT' });
  f.reopen(); const plan = f.stage.rollbackPlan('100');
  assert.equal(plan.applicable, false); assert.equal(plan.sourcePaused, true);
  assert.equal(plan.incoming.length, 1); assert.equal(plan.incoming[0].sourceId, 'new-id');
  assert.deepEqual(plan.uncertainActionIds, ['uncertain-send']); assert.equal(plan.conflicts.length, 1);
  assert.equal(f.stage.db.prepare('SELECT read_state FROM messages').get().read_state, 'unread');
});
test('forged snapshot and conflicting media copies cannot import', async t => {
  const f = await fixture(t);
  assert.throws(() => f.stage.importSnapshot({ ...f.handle }), { code: 'MIGRATION_SNAPSHOT_UNVERIFIED' });
  f.social.conversations['group:1'].unread = [{ ...f.row, media: [] }];
  const changed = await f.snapshot();
  assert.throws(() => f.stage.importSnapshot(changed), { code: 'MIGRATION_CONFLICT' });
  assert.equal(f.stage.db.prepare('SELECT COUNT(*) AS n FROM batches').get().n, 0);
});

test('empty unified ledger imports atomically, stays fenced and maps original IDs without copying old session bindings', async t => {
  const f = await fixture(t); f.stage.importSnapshot(f.handle);
  const file = path.join(f.root, 'unified-test.sqlite'); let store = new UnifiedStore(file);
  try {
    const apply = () => importStagedMigration({ store, stage: f.stage, account: '100', assertExclusive: () => true });
    assert.equal(apply().phase, 'staged');
    assert.equal(store.account('100').paused, 1); assert.equal(store.account('100').session_id, null);
    assert.equal(store.counts('100')[0].unread, 1);
    const mapping = store.db.prepare('SELECT * FROM migration_sources').get();
    assert.equal(mapping.source_id, 'original-id'); assert.ok(mapping.event_seq > 0);
    assert.equal(store.db.prepare('SELECT due_at FROM wake_timers').get().due_at, 2000);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM session_bindings').get().n, 0);
    store.close(); store = new UnifiedStore(file);
    assert.equal(apply().status, 'already-imported');
    const scenes = new UnifiedScenes({ store, getContext: () => ({ account: '100', ownerQQ: '200' }), isAllowed: () => true });
    scenes.setPaused(false);
    assert.throws(() => scenes.active(), { code: 'MIGRATION_PENDING' });
    const attention = new UnifiedAttention({ scenes, now: () => 10000 });
    assert.throws(() => attention.materialize(), { code: 'MIGRATION_PENDING' });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='wake-timer'").get().n, 0);
  } finally { store.close(); }
});

test('runtime import refuses used target, missing exclusive lease and partial-failure commits', async t => {
  const f = await fixture(t); f.stage.importSnapshot(f.handle);
  const store = new UnifiedStore(); t.after(() => store.close());
  const options = { store, stage: f.stage, account: '100', assertExclusive: () => true };
  assert.throws(() => importStagedMigration({ ...options, assertExclusive: () => false }), { code: 'MIGRATION_EXCLUSIVE_REQUIRED' });
  assert.throws(() => importStagedMigration({ ...options, checkpoint() { throw Error('interrupted'); } }), /interrupted/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM migration_sources').get().n, 0);
  store.account('100');
  assert.throws(() => importStagedMigration(options), { code: 'MIGRATION_TARGET_NOT_EMPTY' });
});

test('uncertain legacy read state is retained for review without fabricating unread or read events', async t => {
  const f = await fixture(t);
  f.social.conversations['group:1'].unread = [];
  const handle = await f.snapshot(); f.stage.importSnapshot(handle);
  const store = new UnifiedStore(); t.after(() => store.close());
  importStagedMigration({ store, stage: f.stage, account: '100', assertExclusive: () => true });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  const row = store.db.prepare('SELECT * FROM migration_sources').get();
  assert.equal(row.read_state, 'unknown'); assert.equal(row.event_seq, null);
});
