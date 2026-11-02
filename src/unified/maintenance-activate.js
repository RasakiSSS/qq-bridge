import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readCaptureStatus} from './capture-status.js';
import {MigrationStage} from './migration-stage.js';
import {activateInstalledCandidate} from './migration-install.js';
import {fail} from './store.js';

// A local operator reconciles upstream records through the start of this
// verified connection. The receiver continues saving arrivals while waiting.
export async function activateMaintenance({root,handle,candidate,registration,receiver,verifyPrivate,assertOwner,assertIdle,announce,signal}) {
  const {journal,identity,proof}=registration, generation=receiver.generation;
  const state=path.join(root,'state'), raw=path.join(state,'unified-raw.sqlite');
  const evidence=path.join(state,'migration-snapshots','coverage-'+handle.snapshotId+'.json');
  const assert=()=>{
    signal?.throwIfAborted();
    assertOwner(); proof.assert();
    if(!generation||!receiver.healthy||!receiver.verified||receiver.generation!==generation)throw fail('MIGRATION_RECEIVER_OFFLINE');
    return {...identity,quiesced:true};
  };
  const coverage=()=>{
    assert();
    const st=fs.lstatSync(evidence,{throwIfNoEntry:false});
    if(!st)return false;
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>16384||!verifyPrivate(evidence))throw fail('MIGRATION_UNSAFE_FILE');
    const doc=JSON.parse(fs.readFileSync(evidence,'utf8'));
    if(doc.account!==identity.account||doc.snapshot!==handle.snapshotId||doc.generation!==generation)return false;
    const report=readCaptureStatus(raw,identity.account);
    const acceptedGap=doc.result==='recovered-available-operator-accepted-gaps'&&
      doc.operatorDecision==='retain-recoverable-and-proceed'&&Array.isArray(doc.unverifiedScopes)&&doc.unverifiedScopes.length>0&&
      doc.unverifiedScopes.every(s=>typeof s==='string'&&s.trim().length>0)&&Number.isSafeInteger(doc.recoveredMessages)&&doc.recoveredMessages>=0;
    return doc.version===1&&(doc.result==='reconciled-all-admitted-inbound'||acceptedGap)&&typeof doc.evidenceReference==='string'&&
      doc.evidenceReference.trim().length>0&&report.lastWindow?.verified!=null&&report.lastWindow.closed===null&&
      report.lastWindow.failed===null&&!report.counts.unverified&&!report.counts.uncertainCommands&&
      Number.isSafeInteger(doc.checkedThrough)&&doc.checkedThrough>=report.lastWindow.verified&&doc.checkedThrough<=Date.now();
  };
  assert();
  if(!verifyPrivate(path.dirname(evidence))||!verifyPrivate(raw))throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  const published=journal.db.prepare('SELECT snapshot,phase FROM installed_base WHERE id=1').get();
  if(published?.snapshot!==handle.snapshotId||published.phase!=='published')throw fail('MIGRATION_PENDING');
  announce({snapshot:handle.snapshotId,generation,evidence});
  const file=path.join(candidate.directory,'stage.sqlite');
  if(!verifyPrivate(file)||fs.realpathSync(file)!==file||fs.lstatSync(file).nlink!==1)throw fail('MIGRATION_UNSAFE_FILE');
  const source=new DatabaseSync(file,{readOnly:true});
  let created;
  try {created=source.prepare('SELECT created FROM batches WHERE account=? AND snapshot=?').get(identity.account,handle.snapshotId)?.created;}
  finally {source.close();}
  if(!Number.isSafeInteger(created))throw fail('MIGRATION_CONFLICT');
  const stage=new MigrationStage({file:':memory:',verifyPrivate:()=>true});
  try {
    stage.importSnapshot(handle,{now:created});
    // On restart the journal cursor can precede our new in-memory stage.
    // Recover the transferred prefix exclusively from durable gateway rows.
    const through=journal.assertReady(identity).transferred;
    for(const row of journal.db.prepare('SELECT * FROM incoming WHERE seq<=? ORDER BY seq').iterate(through)){
      stage.appendDelta(identity.account,{scene:row.scene,kind:row.kind,sourceId:row.source_id,at:row.at,payload:JSON.parse(row.payload)});
    }
    for(;;){
      if(await assertIdle()!==true)throw fail('LEGACY_SESSION_BUSY');
      assert();
      try {
        return activateInstalledCandidate({root,handle,journal,stage,lease:{assert},verifyPrivate,assertCoverage:coverage});
      }catch(error){
        if(error.code==='MIGRATION_INGRESS_PENDING'){
          if(!coverage()) {await delay(1000,undefined,{signal});continue;}
          journal.transfer(identity,stage);continue;
        }
        if(error.code!=='MIGRATION_COVERAGE_UNVERIFIED')throw error;
      }
      while(!coverage())await delay(1000,undefined,{signal});
    }
  }finally{stage.close();}
}
