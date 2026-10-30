import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_SOURCE_FILES, readLegacySnapshotFiles, captureMigrationSnapshot, loadMigrationSnapshot, snapshotJson } from '../src/unified/migration-snapshot.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-migration-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let released = 0, epoch = 'epoch-1';
  const files = { 'social-v2.json': Buffer.from('{"conversations":{},"paused":true}'),
    'sessions.json': Buffer.from('{"sessions":{}}'), 'config.json': Buffer.from('{"secret":"fixture-private"}'),
    'qzone.json': null, 'current-role.json': null, 'initial-prompts.json': null,
    'roles/fixture.md': Buffer.from('fixture persona') };
  for (const name of Object.keys(MIGRATION_SOURCE_FILES)) if (!(name in files)) files[name] = null;
  const options = { root, verifyPrivate: () => true, readFiles: () => files,
    acquire: async () => ({ assert: () => ({ account: '100', sourceAccount: '100', provenance: 'fixture-attestation', epoch, quiesced: true }), release: () => { released++; } }) };
  const load = captured => loadMigrationSnapshot({ ...captured, expectedAccount: '100', verifyPrivate: () => true, attest: () => true });
  return { root, files, options, load, get released() { return released; }, changeIdentity: () => { epoch = 'epoch-2'; } };
}
test('snapshot commits only stable account-bound bytes; handles cannot be forged or mutated', async t => {
  const f = fixture(t), captured = await captureMigrationSnapshot(f.options);
  assert.equal(f.released, 1);
  assert.ok(!JSON.stringify(captured).includes('fixture-private'));
  const handle = f.load(captured);
  assert.equal(snapshotJson(handle, 'social-v2.json').paused, true);
  const config = snapshotJson(handle, 'config.json'); config.secret = 'changed';
  assert.equal(snapshotJson(handle, 'config.json').secret, 'fixture-private');
  assert.throws(() => snapshotJson({ ...handle }, 'config.json'), { code: 'MIGRATION_SNAPSHOT_UNVERIFIED' });
  assert.throws(() => loadMigrationSnapshot({ ...captured, expectedAccount: '200', verifyPrivate: () => true, attest: () => true }), { code: 'MIGRATION_SNAPSHOT_UNVERIFIED' });
  assert.throws(() => loadMigrationSnapshot({ ...captured, expectedAccount: '100', verifyPrivate: () => true, attest: () => false }), { code: 'MIGRATION_SNAPSHOT_UNVERIFIED' });
});
test('changing source or login during capture leaves no importable snapshot and releases lease', async t => {
  for (const kind of ['source', 'identity']) {
    const f = fixture(t); let reads = 0;
    f.options.readFiles = () => {
      if (++reads === 2) {
        if (kind === 'source') f.files['social-v2.json'] = Buffer.from('{"paused":false}');
        else f.changeIdentity();
      }
      return f.files;
    };
    await assert.rejects(captureMigrationSnapshot(f.options), { code: 'MIGRATION_SOURCE_CHANGED' });
    assert.equal(f.released, 1);
    for (const directory of fs.readdirSync(f.root)) assert.equal(fs.existsSync(path.join(f.root, directory, 'manifest.json')), false);
  }
});
test('private storage and complete inventory are mandatory; damaged files cannot load', async t => {
  const f = fixture(t);
  await assert.rejects(captureMigrationSnapshot({ ...f.options, verifyPrivate: () => false }), { code: 'MIGRATION_PRIVATE_DIRECTORY_REQUIRED' });
  delete f.files['qzone.json'];
  await assert.rejects(captureMigrationSnapshot(f.options), { code: 'MIGRATION_INCOMPLETE_SNAPSHOT' });
  f.files['qzone.json'] = null;
  const captured = await captureMigrationSnapshot(f.options);
  fs.writeFileSync(path.join(captured.directory, 'social-v2.json'), '{}');
  assert.throws(() => f.load(captured), { code: 'MIGRATION_SNAPSHOT_CORRUPT' });
});
test('SQLite backup includes committed WAL without closing or altering source', async t => {
  const f = fixture(t), file = path.join(f.root, 'live.sqlite');
  const live = new DatabaseSync(file);
  try {
  live.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(id INTEGER PRIMARY KEY,text TEXT); INSERT INTO evidence VALUES(1,'retained');");
  const captured = await captureMigrationSnapshot({ ...f.options, memoryFile: file });
  f.load(captured);
  const copy = new DatabaseSync(path.join(captured.directory, 'memory.sqlite'), { readOnly: true });
  try { assert.equal(copy.prepare('SELECT text FROM evidence').get().text, 'retained'); } finally { copy.close(); }
  assert.equal(live.prepare('SELECT COUNT(*) AS count FROM evidence').get().count, 1);
  } finally { live.close(); }
});

test('current login alone cannot establish the owner of legacy files', async t => {
  const f = fixture(t);
  f.options.acquire = () => ({ assert: () => ({ account: '100', epoch: 'fixture', quiesced: true }), release() {} });
  await assert.rejects(captureMigrationSnapshot(f.options), { code: 'MIGRATION_ACCOUNT_UNVERIFIED' });
});

test('fixed source reader preserves roles and presets, records absence and rejects hard links', async t => {
  const f = fixture(t);
  for (const [name, relative] of Object.entries(MIGRATION_SOURCE_FILES)) {
    if (f.files[name] === null) continue;
    const file = path.join(f.root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, f.files[name]);
  }
  fs.mkdirSync(path.join(f.root, 'roles'));
  fs.writeFileSync(path.join(f.root, 'roles/fixture.md'), 'custom personality');
  const preset = path.join(f.root, MIGRATION_SOURCE_FILES['preset-v2.yml']);
  fs.mkdirSync(path.dirname(preset), { recursive: true }); fs.writeFileSync(preset, 'private custom preset');
  const files = readLegacySnapshotFiles(f.root);
  assert.equal(files['roles/fixture.md'].toString(), 'custom personality');
  assert.equal(files['preset-v2.yml'].toString(), 'private custom preset');
  assert.equal(files['qzone-session.json'], null);
  fs.linkSync(path.join(f.root, 'config.json'), path.join(f.root, 'linked-config.json'));
  assert.throws(() => readLegacySnapshotFiles(f.root), { code: 'MIGRATION_UNSAFE_FILE' });
});
