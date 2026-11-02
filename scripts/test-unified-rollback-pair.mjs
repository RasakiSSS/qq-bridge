import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cutoverFixture } from './fixture-unified-cutover.mjs';
import { writeLegacyRollbackPair } from '../src/unified/migration-rollback-pair.js';

test('interrupted two-file rollback resumes against authenticated originals without replacing a conflicting file', async t => {
  const qzone = {version:1,accounts:{100:{pendingFeeds:[],knownPosts:{},seenFeeds:[],comments:{},ownPosts:[],writes:[]}}};
  const social = {paused:true,conversations:{}};
  const f = await cutoverFixture(t,{qzone,social}); f.activate();
  const qq = path.join(f.root,'social-v2.json'), space = path.join(f.root,'qzone.json');
  fs.writeFileSync(qq,JSON.stringify(social)); fs.writeFileSync(space,JSON.stringify(qzone));
  f.store.db.prepare("UPDATE accounts SET paused=0 WHERE account='100'").run();
  f.store.append({account:'100',scene:'qzone',sourceId:'post:999:one',kind:'qzone-feed',payload:{text:'fresh',authorQQ:'999',tid:'one'},at:1000,wake:false});
  const options = {directory:f.root,store:f.store,account:'100',handle:f.handle,assertExclusive:()=>true,verifyPrivate:()=>true};
  assert.throws(()=>writeLegacyRollbackPair({...options,checkpoint:()=>{throw Error('process interrupted');}}),/process interrupted/);
  assert.equal(JSON.parse(fs.readFileSync(qq)).paused,false); assert.deepEqual(JSON.parse(fs.readFileSync(space)),qzone);
  fs.writeFileSync(space,'unrelated modification');
  assert.throws(()=>writeLegacyRollbackPair(options),{code:'MIGRATION_CONFLICT'});
  assert.equal(fs.readFileSync(space,'utf8'),'unrelated modification');
  fs.writeFileSync(space,JSON.stringify(qzone)); f.close(); f.open();
  const resumed={...options,store:f.store};
  assert.equal(writeLegacyRollbackPair(resumed).operational,false);
  assert.equal(JSON.parse(fs.readFileSync(space)).accounts['100'].pendingFeeds.length,1);
  assert.equal(writeLegacyRollbackPair(resumed).operational,false);
});
