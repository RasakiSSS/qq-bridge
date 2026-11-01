import {DatabaseSync} from 'node:sqlite';
import {UnifiedStore} from '../src/unified/store.js';
import {MigrationStage} from '../src/unified/migration-stage.js';
import {activateStagedMigration} from '../src/unified/migration-activate.js';
import {persistUnifiedIngress} from '../src/unified/migration-live-ingress.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pinOwnerSources,prepareCaptureJournal,captureBoundMigration} from '../src/unified/migration-maintenance.js';
import {prepareMigrationCandidate} from '../src/unified/migration-candidate.js';

test('maintenance restart reopens the same bound snapshot and paused candidate without advancing delivery', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-maint-')), privateRoot=path.join(root,'state','migration-snapshots');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'state/probes'),{recursive:true});fs.mkdirSync(privateRoot);
  const write=(p,obj)=>fs.writeFileSync(path.join(root,p),JSON.stringify(obj));
  const account='100';
  write('config.json',{});write('state/sessions.json',{sessions:{}});write('state/social-v2.json',{paused:true,conversations:{}});
  write('state/probes/unified-legacy-owner-attestation.json',{version:1,account,source:'operator-confirmation-in-current-chat',
    productionMigrationAuthorized:false,scope:['state/social-v2.json','state/sessions.json']});
  const opts={root,account,verifyPrivate:()=>true,excluded:()=>true,assertOwner(){},assertTrusted:()=>true,hardenFile:()=>({ok:true})};
  pinOwnerSources(opts);
  const receiver={generation:'g1',verified:true,healthy:true};
  let previous;
  for(let i=0;i<2;++i) {
    const reg=prepareCaptureJournal(opts);
    try {
      const args={...opts,...reg,privateRoot,receiver,assertIdle:async()=>true};
      const snap=await captureBoundMigration(args);
      const candidate=prepareMigrationCandidate({...opts,parent:privateRoot,handle:snap.handle,current:reg.identity,assertExclusive:()=>true});
      assert.equal(candidate.phase,'staged');assert.equal(reg.journal.assertReady(reg.identity).transferred,0);
      if(previous) {
        assert.equal(snap.directory,previous.directory);assert.equal(snap.resumed,true);
        const {installPausedCandidate}=await import('../src/unified/migration-install.js');
        const target=path.join(root,'state/unified.sqlite');
        const install={...opts,handle:snap.handle,candidate,current:reg.identity,journal:reg.journal,assertExclusive:()=>true};
        fs.writeFileSync(target,'existing file');
        await assert.rejects(installPausedCandidate(install),{code:'MIGRATION_TARGET_NOT_EMPTY'});
        assert.equal(fs.readFileSync(target,'utf8'),'existing file');
        fs.renameSync(target,target+'.fixture-unrelated');
        const candidateDb=new DatabaseSync(path.join(candidate.directory,'unified.sqlite'));
        candidateDb.exec("UPDATE accounts SET permission='v1'");
        candidateDb.close();
        await assert.rejects(installPausedCandidate(install),{code:'MIGRATION_CONFLICT'});
        assert.equal(fs.existsSync(target),false);
        const restore=new DatabaseSync(path.join(candidate.directory,'unified.sqlite'));
        restore.exec("UPDATE accounts SET permission='v3'"); restore.close();
        await assert.rejects(installPausedCandidate({...install,checkpoint:phase=>{if(phase==='linked')throw Error('interrupted');}}),/interrupted/);
        assert.equal(fs.statSync(target).nlink,2);
        assert.equal((await installPausedCandidate(install)).operational,false);
        assert.equal(fs.statSync(target).nlink,1);
        assert.equal((await installPausedCandidate(install)).phase,'staged');
        const store=new UnifiedStore(target);
        const stage=new MigrationStage({file:path.join(candidate.directory,'stage.sqlite'),verifyPrivate:opts.verifyPrivate});
        try {
          const current=reg.identity, journal=reg.journal;
          const lease={assert:()=>({...current,quiesced:true})};
          const activate=()=>activateStagedMigration({journal,store,stage,handle:snap.handle,lease});
          const message=id=>({account,scene:'group:1',sourceId:id,kind:'message',at:1000,payload:{text:id,media:[]}});
          journal.append(current,message('before-cutover'));
          assert.throws(activate,{code:'MIGRATION_INGRESS_PENDING'});
          journal.transfer(current,stage);
          assert.equal(activate().paused,true);
          const live={journal,store,current,wakeAllowed:()=>true};
          persistUnifiedIngress(live,message('after-cutover'));
          assert.equal(persistUnifiedIngress(live,message('after-cutover')).receipt.duplicate,true);
          assert.deepEqual(store.db.prepare('SELECT source_id FROM events WHERE unread=1 ORDER BY seq').all().map(r=>r.source_id),['before-cutover','after-cutover']);
        } finally {stage.close();store.close();}
        write('config.json',{externalChange:true});
        await assert.rejects(captureBoundMigration(args),{code:'MIGRATION_SOURCE_CHANGED'});
      }
      previous=snap;
    } finally{reg.journal.close();}
  }
  assert.equal(fs.readdirSync(privateRoot).filter(p=>p.startsWith('snapshot-')).length,1);
});
