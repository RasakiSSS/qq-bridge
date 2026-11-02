import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readCaptureStatus} from '../src/unified/capture-status.js';
import {planLegacyQq} from '../src/unified/migration-plan.js';
import {projectLegacyQzone,unresolvedSpaceWrites} from '../src/unified/migration-qzone.js';

// Local, read-only, aggregate inspection. This deliberately does not open the
// bridge, a DSH session or a writable SQLite store, and never enrolls a source.
const root=fileURLToPath(new URL('../',import.meta.url)),dir=path.join(root,'state');
const read=name=>fs.readFileSync(path.join(dir,name));
try {
  const pin=JSON.parse(read('probes/unified-legacy-source-pin.json')),account=pin.account;
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const social=read('social-v2.json'),sessions=read('sessions.json');
  const plan=planLegacyQq({account,snapshotAccount:account,snapshotId:digest(social),social:JSON.parse(social),sessions:JSON.parse(sessions).sessions});
  const qzFile=path.join(dir,'qzone.json');
  const space=fs.existsSync(qzFile)?JSON.parse(read('qzone.json')).accounts?.[account]??null:null;
  const qz=projectLegacyQzone(account,space);
  const category=rows=>Object.fromEntries([...new Set(rows.map(r=>r.reason))].map(key=>[key,rows.filter(r=>r.reason===key).length]));
  const sourceFingerprintsMatch=pin.sources['state/social-v2.json']===digest(social)&&pin.sources['state/sessions.json']===digest(sessions);
  const blockers=category(plan.blockers);
  if (!sourceFingerprintsMatch) blockers.MIGRATION_SOURCE_CHANGED=1;
  const unresolved=unresolvedSpaceWrites(space);
  if (unresolved) blockers.MIGRATION_ACTION_UNRESOLVED=unresolved;
  console.log(JSON.stringify({readOnly:true,sourceFingerprintsMatch,
    conversations:plan.scenes.length,sequenced:plan.scenes.reduce((s,x)=>s+x.events.length,0),
    sentPreviews:plan.scenes.reduce((s,x)=>s+x.sentHistory.length,0),qzoneSources:qz.length,
    blockers,warnings:category(plan.warnings),capture:readCaptureStatus(path.join(dir,'unified-raw.sqlite'),account),
    productionActivation:false},null,2));
} catch(error) {
  console.error('Migration inspection unavailable:', /^[A-Z_]{2,80}$/.test(error?.code??'')?error.code:'INVALID_SOURCE');
  process.exitCode=1;
}
