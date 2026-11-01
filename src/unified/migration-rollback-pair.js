import fs from 'node:fs';
import { rollbackOriginalBytes } from './migration-snapshot.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { accountId, fail } from './store.js';
import { projectLegacyQqRollback, projectLegacyQzoneRollback } from './migration-reverse.js';

const sha = data => createHash('sha256').update(data).digest('hex');
const names = ['social-v2.json','qzone.json'];
// The private ledger is the write-ahead manifest for BOTH files. A restart
// resumes from their hashes, not from an assumed last successful rename.
export function writeLegacyRollbackPair({ directory, store, account, handle, createScene, assertExclusive, verifyPrivate, checkpoint = () => {} }) {
  accountId(account);
  const check = () => {
    if (assertExclusive?.() !== true) throw fail('MIGRATION_EXCLUSIVE_REQUIRED');
    if (!path.isAbsolute(directory) || path.relative(directory,fs.realpathSync(directory)) || verifyPrivate?.(directory) !== true) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  };
  const read = name => {
    check();
    const target = path.join(directory,name), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('MIGRATION_INVALID_SOURCE');
    return fs.readFileSync(target);
  };
  const category = 'rollback-pair-v1';
  check();
  const record = store.transaction(() => {
    const batch = store.db.prepare('SELECT phase,snapshot FROM migration_imports WHERE account=?').get(account);
    if (batch?.phase !== 'ready' || handle?.snapshotId !== batch.snapshot || handle.account !== account) throw fail('MIGRATION_PENDING');
    const raw = store.db.prepare('SELECT payload FROM migration_preserved WHERE account=? AND category=?').get(account,category);
    const saved = raw && JSON.parse(raw.payload);
    if (saved && (saved.snapshot !== batch.snapshot || saved.directory !== directory || saved.account !== account)) throw fail('MIGRATION_CONFLICT');
    const before = names.map(name => rollbackOriginalBytes(handle,name));
    if (!before.every(Buffer.isBuffer)) throw fail('MIGRATION_INVALID_SOURCE');
    const parse = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
    // Both projections run against the same ledger transaction and original
    // bytes, including when one target already contains the new version.
    const joined = { db:store.db, account:store.account.bind(store), transaction:fn => fn() };
    const input = {store:joined,account,assertExclusive,createScene};
    const social = projectLegacyQqRollback({...input,social:parse(before[0])}).social;
    const space = projectLegacyQzoneRollback({...input,qzone:parse(before[1])}).qzone;
    if (Object.values(social.conversations).some(c => c.unread.length>100 || c.recentMessages.length>200)) throw fail('MIGRATION_LEGACY_CAPACITY_EXCEEDED');
    const files = [social,space].map((value,i) => {
      const next = Buffer.from(JSON.stringify(value));
      return { before:sha(before[i]), after:sha(next) };
    });
    const manifest = { account, snapshot:batch.snapshot, directory, files };
    if (saved && JSON.stringify(saved) !== JSON.stringify(manifest)) throw fail('MIGRATION_CONFLICT');
    for (const [i,name] of names.entries()) {
      const actual = sha(read(name));
      if (actual !== files[i].before && !(saved && actual === files[i].after)) throw fail('MIGRATION_CONFLICT');
    }
    if (!saved) store.db.prepare('INSERT INTO migration_preserved VALUES(?,?,?)').run(account,category,JSON.stringify(manifest));
    // Only hashes enter the ledger; old credentials stay in the private snapshot.
    return { ...manifest, next:[social,space].map(value => Buffer.from(JSON.stringify(value))) };
  });
  for (const [i,name] of names.entries()) {
    const f = record.files[i], actual = sha(read(name));
    if (actual === f.after) continue;
    if (actual !== f.before) throw fail('MIGRATION_CONFLICT');
    const target = path.join(directory,name), temp = target + '.rollback-' + randomUUID();
    const fd = fs.openSync(temp,'wx',0o600);
    try { fs.writeFileSync(fd,record.next[i]); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (sha(read(name)) !== f.before || sha(fs.readFileSync(temp)) !== f.after) throw fail('MIGRATION_CONFLICT');
    fs.renameSync(temp,target);
    if (sha(read(name)) !== f.after) throw fail('MIGRATION_WRITE_VERIFY_FAILED');
    if (checkpoint(name)?.then) throw fail('ASYNC_TRANSACTION');
  }
  check();
  if (!names.every((name,i) => sha(read(name)) === record.files[i].after)) throw fail('MIGRATION_CONFLICT');
  return { snapshot:record.snapshot, files:names.slice(), operational:false };
}
