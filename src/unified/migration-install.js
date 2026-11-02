import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {snapshotIdentity} from './migration-snapshot.js';
import {activateStagedMigration} from './migration-activate.js';
import {MigrationStage} from './migration-stage.js';
import {importStagedMigration} from './migration-import.js';
import {UnifiedStore,fail} from './store.js';

function safeFile(file,links=1) {
  const st=fs.lstatSync(file,{bigint:true});
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==BigInt(links)) throw fail('MIGRATION_UNSAFE_FILE');
  return st;
}
const identity=st=>st.dev+':'+st.ino;
const fileHash=file=>{
  const fd=fs.openSync(file,'r'),buf=Buffer.alloc(65536),hash=createHash('sha256');
  try {let n;while((n=fs.readSync(fd,buf,0,buf.length,null)))hash.update(buf.subarray(0,n));return hash.digest('hex');}
  finally{fs.closeSync(fd);}
};
function logical(db,trustedSchema) {
  const hash=createHash('sha256'), add=row=>hash.update(JSON.stringify(row)+'\n');
  add(db.prepare('PRAGMA application_id').get());add(db.prepare('PRAGMA user_version').get());
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  if(trustedSchema!==undefined && JSON.stringify(schema)!==trustedSchema)throw fail('MIGRATION_CONFLICT');
  add(schema);
  for(const row of schema.filter(r=>r.type==='table')){
    if(!/^[a-z_][a-z_0-9]*$/.test(row.name))throw fail('INVALID_STORE');
    for(const value of db.prepare('SELECT * FROM "'+row.name+'" ORDER BY rowid').iterate())add(value);
  }
  return hash.digest('hex');
}

// Re-derive every staged row (including absence of actions/tokens) from the
// authenticated snapshot before publishing an installation-owned staged DB.
export async function installPausedCandidate({root,handle,candidate,current,journal,verifyPrivate,hardenFile,assertExclusive,checkpoint=()=>{}}) {
  const account=handle.account, from=snapshotIdentity(handle), state=path.join(root,'state'),target=path.join(state,'unified.sqlite');
  const check=()=>{
    if(assertExclusive()!==true)throw fail('MIGRATION_EXCLUSIVE_REQUIRED');
    const barrier=journal.assertReady(current);
    if(barrier.snapshot!==handle.snapshotId||current.account!==account||current.sourceAccount!==account||current.epoch!==from.epoch||current.provenance!==from.provenance)throw fail('MIGRATION_SOURCE_CHANGED');
  };
  check();
  if(!path.isAbsolute(root)||path.relative(state,fs.realpathSync(state))||!verifyPrivate(state)||
    candidate.phase!=='staged'||candidate.snapshotId!==handle.snapshotId||candidate.directory!==path.join(state,'migration-snapshots','candidate-'+handle.snapshotId)
    ||path.relative(candidate.directory,fs.realpathSync(candidate.directory))||!verifyPrivate(candidate.directory))throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  const source=path.join(candidate.directory,'unified.sqlite'),stageFile=path.join(candidate.directory,'stage.sqlite');
  for(const base of [source,stageFile]) {
    safeFile(base);if(!verifyPrivate(base))throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
    for(const ext of ['-shm','-wal','-journal'])if(fs.lstatSync(base+ext,{throwIfNoEntry:false})){safeFile(base+ext);if(!verifyPrivate(base+ext))throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');}
  }
  const stageDb=new DatabaseSync(stageFile,{readOnly:true});
  let created;
  try {created=stageDb.prepare('SELECT created FROM batches WHERE account=? AND snapshot=?').get(account,handle.snapshotId)?.created;}finally{stageDb.close();}
  if(!Number.isSafeInteger(created))throw fail('MIGRATION_INVALID_SOURCE');
  journal.transaction(()=>journal.db.exec('CREATE TABLE IF NOT EXISTS installed_base(id INTEGER PRIMARY KEY CHECK(id=1),snapshot TEXT,temporary TEXT,file_id TEXT,digest TEXT,phase TEXT)'));
  let receipt=journal.db.prepare('SELECT * FROM installed_base WHERE id=1').get();
  if(receipt && (receipt.snapshot!==handle.snapshotId||!/^\.migration-base-[a-f0-9-]{36}\.sqlite$/.test(receipt.temporary)||!['prepared','published'].includes(receipt.phase)))throw fail('MIGRATION_CONFLICT');
  if(!receipt) {
    if(fs.lstatSync(target,{throwIfNoEntry:false}))throw fail('MIGRATION_TARGET_NOT_EMPTY');
    const db=new DatabaseSync(source,{readOnly:true}),stage=new MigrationStage({file:':memory:',verifyPrivate:()=>true});
    try {
      const imported=db.prepare('SELECT imported_at FROM migration_imports WHERE account=? AND phase=? AND snapshot=?').get(account,'staged',handle.snapshotId);
      if(!imported)throw fail('MIGRATION_PENDING');
      stage.importSnapshot(handle,{now:created});
      const ref=new UnifiedStore(':memory:');
      try{
        importStagedMigration({store:ref,stage,account,assertExclusive,now:imported.imported_at});
        const expected=logical(ref.db),trustedSchema=JSON.stringify(ref.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all());
        const temporary='.migration-base-'+randomUUID()+'.sqlite',temp=path.join(state,temporary);
        fs.closeSync(fs.openSync(temp,'wx',0o600));
        if(!hardenFile(temp)?.ok||!verifyPrivate(temp))throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
        await backup(db,temp);
        const copy=new DatabaseSync(temp);
        try{
          if(copy.prepare('PRAGMA journal_mode=DELETE').get().journal_mode!=='delete'||logical(copy,trustedSchema)!==expected)throw fail('MIGRATION_CONFLICT');
        }finally{copy.close();}
        const fd=fs.openSync(temp,'r+');try {fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        check();
        const record={temporary,fileId:identity(safeFile(temp)),digest:fileHash(temp)};
        journal.transaction(()=>journal.db.prepare("INSERT INTO installed_base VALUES(1,?,?,?,?,'prepared')").run(handle.snapshotId,record.temporary,record.fileId,record.digest));
        receipt=journal.db.prepare('SELECT * FROM installed_base WHERE id=1').get();
        await checkpoint('prepared');
      }finally{ref.close();}
    }finally{stage.close();db.close();}
  }
  check();
  const temp=path.join(state,receipt.temporary);
  // A pre-existing target without this receipt is never opened for writing.
  for(const ext of ['-wal','-shm','-journal']) if(fs.lstatSync(target+ext,{throwIfNoEntry:false}))throw fail('MIGRATION_CONFLICT');
  if(!fs.lstatSync(target,{throwIfNoEntry:false})){
    if(receipt.phase!=='prepared'||identity(safeFile(temp))!==receipt.file_id||fileHash(temp)!==receipt.digest)throw fail('MIGRATION_CONFLICT');
    fs.linkSync(temp,target); // same directory, atomic create-if-absent
    await checkpoint('linked');
  }
  check();
  const leftover=fs.lstatSync(temp,{throwIfNoEntry:false});
  if(identity(safeFile(target,leftover?2:1))!==receipt.file_id||fileHash(target)!==receipt.digest||!verifyPrivate(target))throw fail('MIGRATION_CONFLICT');
  if(leftover){
    if(receipt.phase!=='prepared'||identity(safeFile(temp,2))!==receipt.file_id)throw fail('MIGRATION_CONFLICT');
    fs.unlinkSync(temp); // remove our temporary link only after the target is verified
  }
  check();
  if(identity(safeFile(target))!==receipt.file_id)throw fail('MIGRATION_CONFLICT');
  journal.transaction(()=>journal.db.prepare("UPDATE installed_base SET phase='published' WHERE id=1").run());
  return {phase:'staged',snapshotId:handle.snapshotId,operational:false};
}

// Called under the same exclusive host lease as capture/transfer. The caller
// must establish transport coverage before creating the first durable intent.
export function activateInstalledCandidate({root,handle,journal,stage,lease,verifyPrivate,assertCoverage,checkpoint=()=>{}}) {
  const source=snapshotIdentity(handle), account=source.account;
  const state=path.join(root,'state'), target=path.join(state,'unified.sqlite');
  if(!path.isAbsolute(root)||path.relative(state,fs.realpathSync(state))||!verifyPrivate(state))
    throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  const receipt=journal.db.prepare('SELECT * FROM installed_base WHERE id=1').get();
  if(receipt?.snapshot!==handle.snapshotId||receipt.phase!=='published') throw fail('MIGRATION_PENDING');
  const check=()=>{
    const current=lease.assert();
    if(current?.quiesced!==true||current.account!==account||current.sourceAccount!==account||
      current.provenance!==source.provenance||current.epoch!==source.epoch) throw fail('MIGRATION_NOT_QUIESCED');
    if(identity(safeFile(target))!==receipt.file_id||!verifyPrivate(target))throw fail('MIGRATION_SOURCE_CHANGED');
    const barrier=journal.assertReady(current);
    if(barrier.snapshot!==handle.snapshotId)throw fail('MIGRATION_DIFFERENT_SNAPSHOT');
    return barrier;
  };
  const barrier=check();
  journal.db.exec('CREATE TABLE IF NOT EXISTS activation_intent(id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL, file_id TEXT NOT NULL, at INTEGER NOT NULL, through_seq INTEGER NOT NULL, committed INTEGER NOT NULL)');
  let intent=journal.db.prepare('SELECT * FROM activation_intent WHERE id=1').get();
  for(const suffix of ['-wal','-shm','-journal']){
    const file=target+suffix;
    if(fs.lstatSync(file,{throwIfNoEntry:false})){
      safeFile(file);
      if(!intent||!verifyPrivate(file))throw fail('MIGRATION_CONFLICT');
    }
  }
  if(!intent){
    if(fileHash(target)!==receipt.digest)throw fail('MIGRATION_CONFLICT');
    if(journal.db.prepare('SELECT 1 FROM incoming WHERE seq>?').get(barrier.transferred))throw fail('MIGRATION_INGRESS_PENDING');
    if(assertCoverage?.()!==true)throw fail('MIGRATION_COVERAGE_UNVERIFIED');
    journal.transaction(()=>{
      check();
      journal.db.prepare('INSERT INTO activation_intent VALUES(1,?,?,?,?,0)').run(handle.snapshotId,receipt.file_id,Date.now(),barrier.transferred);
    });
    checkpoint('intent');
    intent=journal.db.prepare('SELECT * FROM activation_intent WHERE id=1').get();
  }
  if(intent.snapshot!==handle.snapshotId||intent.file_id!==receipt.file_id)throw fail('MIGRATION_CONFLICT');
  const store=new UnifiedStore(target);
  try {
    const phase=store.db.prepare('SELECT phase FROM migration_imports WHERE account=? AND snapshot=?').get(account,handle.snapshotId)?.phase;
    if(phase==='staged'&&!intent.committed){
      if(assertCoverage?.()!==true)throw fail('MIGRATION_COVERAGE_UNVERIFIED');
      // New arrivals after a pre-commit crash must be transferred first.
      const through=check().transferred;
      journal.transaction(()=>journal.db.prepare('UPDATE activation_intent SET through_seq=? WHERE id=1').run(through));
      intent.through_seq=through;
      activateStagedMigration({store,stage,journal,handle,lease,now:intent.at});
      checkpoint('target-committed');
    } else if(phase!=='ready')throw fail('MIGRATION_CONFLICT');
    const decision=JSON.parse(store.db.prepare("SELECT payload FROM migration_preserved WHERE account=? AND category='cutover'").get(account)?.payload??'null');
    if(decision?.snapshotId!==intent.snapshot||decision.account!==account||decision.epoch!==source.epoch||
      decision.provenance!==source.provenance||decision.route!=='unified'||decision.at!==intent.at||
      decision.ingressThrough!==intent.through_seq||check().transferred<intent.through_seq)throw fail('MIGRATION_CONFLICT');
    journal.transaction(()=>journal.db.prepare('UPDATE activation_intent SET committed=1 WHERE id=1').run());
    return decision;
  } finally {store.close();}
}
