import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { accountId, fail } from './store.js';
import { randomUUID } from 'node:crypto';
import { MigrationIngress } from './migration-ingress.js';
import { assertSnapshotStillCurrent, snapshotIdentity, captureMigrationSnapshot, readLegacySnapshotFiles, loadMigrationSnapshot } from './migration-snapshot.js';

const scope = ['state/social-v2.json','state/sessions.json'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function regular(file, max) {
  const parent = path.dirname(file), stat = fs.lstatSync(file);
  if (path.relative(parent,fs.realpathSync(parent)) !== '' || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw fail('MIGRATION_UNSAFE_FILE');
  return fs.readFileSync(file);
}
function originals(root) {
  return Object.fromEntries(scope.map(name => [name,sha(regular(path.join(root,name),128*1024*1024))]));
}
function statementAt(root, account, verifyPrivate) {
  const file = path.join(root,'state/probes/unified-legacy-owner-attestation.json');
  if (!verifyPrivate(file)) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  const bytes = regular(file,16384), statement = JSON.parse(bytes.toString());
  if (statement.version !== 1 || statement.account !== account || statement.source !== 'operator-confirmation-in-current-chat'
    || statement.productionMigrationAuthorized !== false || JSON.stringify(statement.scope) !== JSON.stringify(scope)) throw fail('MIGRATION_ACCOUNT_UNVERIFIED');
  return sha(bytes);
}
// Pin the operator's exact source bytes. This operation neither pauses nor
// snapshots production. If they have changed by maintenance time, fail closed.
export function pinOwnerSources({ root, account, verifyPrivate, assertTrusted }) {
  accountId(account); root = fs.realpathSync(root);
  const directory = path.join(root,'state/probes'), file = path.join(directory,'unified-legacy-source-pin.json');
  const assertPrivate = () => {
    if (assertTrusted() !== true || !verifyPrivate(directory)) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  };
  assertPrivate();
  const read = () => ({version:1, root, account, declaration:statementAt(root,account,verifyPrivate), sources:originals(root)});
  const pin = read();
  if (JSON.stringify(read()) !== JSON.stringify(pin)) throw fail('MIGRATION_SOURCE_CHANGED');
  assertPrivate();
  if (!fs.existsSync(file)) {
    const fd = fs.openSync(file,'wx',0o600);
    try { fs.writeFileSync(fd,JSON.stringify(pin)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (!verifyPrivate(file)) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  if (JSON.stringify(JSON.parse(regular(file,16384))) !== JSON.stringify(pin)) throw fail('MIGRATION_SOURCE_CHANGED');
  return {file,provenance:sha(Buffer.from(JSON.stringify(pin)))};
}

// Production code must never enroll/re-pin an installation during import.
export function boundOwnerProof({ root, account, verifyPrivate, assertOwner }) {
  accountId(account); root = fs.realpathSync(root);
  const dir = path.join(root,'state/probes'), file = path.join(dir,'unified-legacy-source-pin.json');
  const check = () => {
    assertOwner();
    if (!verifyPrivate(dir) || !verifyPrivate(file)) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
    const pin = JSON.parse(regular(file,16384));
    const expected = {version:1,root,account,declaration:statementAt(root,account,verifyPrivate),sources:originals(root)};
    if (JSON.stringify(pin) !== JSON.stringify(expected)) throw fail('MIGRATION_SOURCE_CHANGED');
    return sha(Buffer.from(JSON.stringify(expected)));
  };
  const provenance = check(), pinned = JSON.parse(regular(file,16384)).sources;
  return {account,sourceAccount:account,provenance,
    assertFiles(files) {
      for (const name of scope) {
        const bytes = files[path.basename(name)];
        if (!Buffer.isBuffer(bytes) || sha(bytes) !== pinned[name]) throw fail('MIGRATION_SOURCE_CHANGED');
      }
    }, assert() { if(check() !== provenance) throw fail('MIGRATION_SOURCE_CHANGED'); }};
}

export async function captureBoundMigration({ root, privateRoot, account, journal, proof, receiver, assertOwner, assertIdle, verifyPrivate }) {
  const generation = receiver.generation;
  if (!receiver.verified || !generation || proof.account !== account) throw fail('MIGRATION_ACCOUNT_UNVERIFIED');
  const row = journal.db.prepare('SELECT identity FROM barrier WHERE id=1').get();
  const identity = JSON.parse(row?.identity ?? 'null');
  if (identity?.provenance !== proof.provenance || identity.sourceAccount !== account || identity.account !== account) throw fail('MIGRATION_ACCOUNT_UNVERIFIED');
  const check = () => {
    assertOwner(); proof.assert(); journal.assertReady(identity);
    if (!receiver.verified || receiver.generation !== generation || receiver.healthy !== true) throw fail('MIGRATION_SOURCE_CHANGED');
  };
  const idle = async () => { check(); if (await assertIdle() !== true) throw fail('LEGACY_SESSION_BUSY'); check(); };
  await idle();
  const memory = path.join(root,'state/memory.sqlite');
  const bound=journal.assertReady(identity).snapshot;
  if (bound) {
    if (!/^[a-f0-9]{64}$/.test(bound) || !verifyPrivate(privateRoot)) throw fail('MIGRATION_SNAPSHOT_UNVERIFIED');
    const matches=[];
    for (const entry of fs.readdirSync(privateRoot,{withFileTypes:true})) {
      if (!entry.isDirectory() || !/^snapshot-[a-f0-9-]{36}$/.test(entry.name)) continue;
      const dir=path.join(privateRoot,entry.name), marker=path.join(dir,'manifest.json');
      if (!fs.existsSync(marker)) continue;
      if (!verifyPrivate(dir) || !verifyPrivate(marker)) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
      if (JSON.parse(regular(marker,1024*1024)).snapshotId===bound) matches.push(dir);
    }
    if (matches.length!==1) throw fail('MIGRATION_SNAPSHOT_UNVERIFIED');
    const directory=matches[0];
    const handle=loadMigrationSnapshot({directory,expectedAccount:account,verifyPrivate,
      attest:info=>info.snapshotId===bound && info.epoch===identity.epoch && info.account===account});
    if (snapshotIdentity(handle).provenance!==proof.provenance) throw fail('MIGRATION_SOURCE_CHANGED');
    await assertSnapshotStillCurrent({handle,files:readLegacySnapshotFiles(root),memoryFile:fs.existsSync(memory)?memory:null,privateRoot,verifyPrivate});
    await idle(); check();
    return {directory,handle,snapshotId:bound,account,resumed:true};
  }
  const result = await captureMigrationSnapshot({root:privateRoot, verifyPrivate, memoryFile:fs.existsSync(memory)?memory:null,
    acquire:async()=>({assert:()=>{check();return {...identity,quiesced:true};},release(){}}),
    readFiles:async()=>{await idle();const files=readLegacySnapshotFiles(root);proof.assertFiles(files);return files;}});
  await idle();
  const handle = loadMigrationSnapshot({...result,expectedAccount:account,verifyPrivate,
    attest: info => info.snapshotId===result.snapshotId && info.epoch===identity.epoch && info.account===account});
  if (snapshotIdentity(handle).provenance !== proof.provenance) throw fail('MIGRATION_SOURCE_CHANGED');
  check(); journal.bindSnapshot(identity,handle);
  return { ...result, handle };
}

// Register an installation only while holding its strict host lock. No inferred
// account and no fallback to a fresh journal if an existing barrier disagrees.
export function prepareCaptureJournal({root,account,verifyPrivate,excluded,assertOwner,hardenFile}) {
  const proof = boundOwnerProof({root,account,verifyPrivate,assertOwner});
  const file = path.join(root,'state/migration-ingress.sqlite');
  const exists = fs.lstatSync(file,{throwIfNoEntry:false});
  if (!excluded(file) || !verifyPrivate(path.dirname(file))) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  if (!exists) {
    const fd=fs.openSync(file,'wx',0o600);
    try { if (!hardenFile(file)?.ok) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED'); } finally { fs.closeSync(fd); }
  } else if (!exists.isFile() || exists.isSymbolicLink() || exists.nlink!==1 || exists.size===0) throw fail('MIGRATION_SOURCE_CHANGED');
  if (!verifyPrivate(file)) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  const journal=new MigrationIngress({file,verifyPrivate,assertExclusive:()=>{assertOwner();return true;}});
  try {
    const previous=journal.db.prepare('SELECT identity FROM barrier WHERE id=1').get();
    if (exists && !previous) throw fail('MIGRATION_SOURCE_CHANGED');
    const identity={account,sourceAccount:account,provenance:proof.provenance,epoch:previous ? JSON.parse(previous.identity).epoch : randomUUID()};
    proof.assert(); journal.begin(identity); journal.assertReady(identity);
    return {proof,journal,identity};
  } catch(error) {journal.close();throw error;}
}
