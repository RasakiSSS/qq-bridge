import fs from 'node:fs';
import path from 'node:path';
import { MigrationStage } from './migration-stage.js';
import { UnifiedStore, fail } from './store.js';
import { importStagedMigration } from './migration-import.js';
import { snapshotIdentity } from './migration-snapshot.js';

// Base import only. The live journal's transferred cursor is owned by cutover;
// preparing an isolated candidate must never claim any gateway delivery.
export function prepareMigrationCandidate({parent, handle, account, current, verifyPrivate, assertExclusive}) {
  const identity = snapshotIdentity(handle);
  if (identity.account!==account || identity.epoch!==current.epoch || identity.provenance!==current.provenance
      || !/^[0-9a-f]{64}$/.test(handle.snapshotId)) throw fail('MIGRATION_SOURCE_CHANGED');
  const check = () => {
    if (assertExclusive()!==true) throw fail('MIGRATION_EXCLUSIVE_REQUIRED');
    if (!verifyPrivate(parent) || path.relative(parent,fs.realpathSync(parent))!=='') throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  };
  check();
  const directory=path.join(parent,'candidate-'+handle.snapshotId);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory,{mode:0o700});
  if (!fs.lstatSync(directory).isDirectory() || path.relative(directory,fs.realpathSync(directory))!=='' || !verifyPrivate(directory)) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  for(const name of ['stage.sqlite','unified.sqlite']) {
    for(const suffix of ['','-journal','-wal','-shm']) {
      const file=path.join(directory,name+suffix), st=fs.lstatSync(file,{throwIfNoEntry:false});
      if (st && (!st.isFile() || st.isSymbolicLink() || st.nlink!==1 || !verifyPrivate(file))) throw fail('MIGRATION_UNSAFE_FILE');
    }
  }
  const stage=new MigrationStage({file:path.join(directory,'stage.sqlite'),verifyPrivate});
  try {
    stage.importSnapshot(handle); check();
    const store=new UnifiedStore(path.join(directory,'unified.sqlite'));
    try {
      const result=importStagedMigration({store,stage,account,assertExclusive,retainDeltas:true});
      if(result.phase!=='staged' || store.account(account).paused!==1) throw fail('MIGRATION_NOT_QUIESCED');
      const rows=store.db.prepare('SELECT read_state,count(*) AS n FROM migration_sources WHERE account=? GROUP BY read_state').all(account);
      check();
      return {snapshotId:handle.snapshotId,directory,phase:'staged',operational:false,sourceCounts:Object.fromEntries(rows.map(row=>[row.read_state,row.n]))};
    } finally {store.close();}
  } finally {stage.close();}
}
