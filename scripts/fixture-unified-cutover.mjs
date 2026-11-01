import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MigrationIngress } from '../src/unified/migration-ingress.js';
import { MigrationStage } from '../src/unified/migration-stage.js';
import { UnifiedStore } from '../src/unified/store.js';
import { captureMigrationSnapshot, loadMigrationSnapshot, MIGRATION_SOURCE_FILES } from '../src/unified/migration-snapshot.js';
import { importStagedMigration } from '../src/unified/migration-import.js';
import { activateStagedMigration } from '../src/unified/migration-activate.js';

export const current = { account: '100', sourceAccount: '100', epoch: 'fixture', provenance: 'fixture-proof' };
export async function cutoverFixture(t, { qzone = null, social } = {}) {
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
  files['social-v2.json'] = Buffer.from(JSON.stringify(social ?? {paused:true,conversations:{}}));
  files['sessions.json'] = Buffer.from('{"sessions":{}}'); files['config.json'] = Buffer.from('{}');
  if (qzone) files['qzone.json'] = Buffer.from(JSON.stringify(qzone));
  const captured = await captureMigrationSnapshot({ root, verifyPrivate: () => true, acquire: () => lease, readFiles: () => files });
  const handle = loadMigrationSnapshot({ ...captured, expectedAccount: '100', attest: () => true, verifyPrivate: () => true });
  journal.bindSnapshot(current, handle); stage.importSnapshot(handle);
  importStagedMigration({ store, stage, account: '100', assertExclusive: () => true });
  return { root, stage, handle, lease, open, close, get journal() { return journal; }, get store() { return store; },
    activate: () => activateStagedMigration({ journal, store, stage, handle, lease }),
    options: () => ({ journal, store, current, wakeAllowed: () => true }) };
}
