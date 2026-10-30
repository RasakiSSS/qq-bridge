import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { accountId, fail } from './store.js';

const sha = data => createHash('sha256').update(data).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
function fileDigest(file) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(65536), fd = fs.openSync(file, 'r');
  let bytes = 0;
  try { for (;;) { const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break; bytes += count; hash.update(buffer.subarray(0, count)); } }
  finally { fs.closeSync(fd); }
  return { bytes, sha256: hash.digest('hex') };
}
export const MIGRATION_SOURCE_FILES = Object.freeze({
  'social-v2.json': 'state/social-v2.json', 'sessions.json': 'state/sessions.json',
  'qzone.json': 'state/qzone.json', 'qzone-session.json': 'state/qzone-session.json',
  'current-role.json': 'state/current-role.json', 'initial-prompts.json': 'state/initial-prompts.json',
  'mode.json': 'state/mode.json', 'config.json': 'config.json',
  'preset-v1.yml': 'dsh/agent-presets/qq-chat/agent.cordis.yml',
  'preset-v2.yml': 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml',
  'preset-files.yml': 'dsh/agent-presets/qq-chat-v2-files/agent.cordis.yml',
  'preset-unified.yml': 'dsh/agent-presets/qq-unified/agent.cordis.yml',
});
const names = Object.keys(MIGRATION_SOURCE_FILES);
const safeName = name => typeof name === 'string' && name.length <= 240 && (names.includes(name) || /^roles\/[\w\u4e00-\u9fff-]+\.md$/.test(name));
const verified = new WeakMap();

function requirePrivate(check, directory) {
  // The host must verify both OS access and exclusion from model file roots.
  if (check(directory) !== true) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('MIGRATION_UNSAFE_FILE');
  return stat;
}
function plainDirectory(directory) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('MIGRATION_UNSAFE_DIRECTORY');
    if (path.dirname(current) === current) break;
  }
}
function fileSet(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('MIGRATION_INVALID_SOURCE');
  const result = new Map(); let total = 0;
  for (const name of names) if (!Object.hasOwn(input, name)) throw fail('MIGRATION_INCOMPLETE_SNAPSHOT');
  for (const name of Object.keys(input).sort()) {
    if (!safeName(name)) throw fail('MIGRATION_INVALID_SOURCE');
    const data = input[name];
    if (data === null) { result.set(name, null); continue; }
    if (!Buffer.isBuffer(data)) throw fail('MIGRATION_INVALID_SOURCE');
    total += data.length;
    if (total > 128 * 1024 * 1024) throw fail('MIGRATION_SNAPSHOT_TOO_LARGE');
    result.set(name, Buffer.from(data));
  }
  if (!result.get('social-v2.json') || !result.get('sessions.json') || !result.get('config.json')) throw fail('MIGRATION_INCOMPLETE_SNAPSHOT');
  return result;
}
const index = files => [...files].map(([name, bytes]) => ({ name, bytes: bytes?.length ?? null, sha256: bytes === null ? null : sha(bytes) }));

// HOST ONLY. acquire() must freeze legacy state writers and model dispatch,
// retain incoming events durably, and hold installation/account ownership until
// release(). This module deliberately has no production default for that lease.
export async function captureMigrationSnapshot({ root, acquire, readFiles, memoryFile = null, verifyPrivate, now = Date.now }) {
  if (typeof acquire !== 'function' || typeof readFiles !== 'function' || typeof verifyPrivate !== 'function') throw fail('MIGRATION_HOST_ADAPTER_REQUIRED');
  plainDirectory(root); requirePrivate(verifyPrivate, root);
  const lease = await acquire();
  if (!lease || typeof lease.assert !== 'function' || typeof lease.release !== 'function') throw fail('MIGRATION_LEASE_REQUIRED');
  let directory;
  try {
    const initial = await lease.assert();
    accountId(initial?.account);
    if (initial.sourceAccount !== initial.account || typeof initial.provenance !== 'string' || !initial.provenance) throw fail('MIGRATION_ACCOUNT_UNVERIFIED');
    if (initial.quiesced !== true || typeof initial.epoch !== 'string' || !initial.epoch) throw fail('MIGRATION_NOT_QUIESCED');
    const identity = JSON.stringify(initial);
    const check = async () => {
      if (JSON.stringify(await lease.assert()) !== identity) throw fail('MIGRATION_SOURCE_CHANGED');
      plainDirectory(root); requirePrivate(verifyPrivate, root);
      if (directory) { plainDirectory(directory); requirePrivate(verifyPrivate, directory); }
    };
    await check();
    const files = fileSet(await readFiles()); await check();
    directory = path.join(path.resolve(root), `snapshot-${randomUUID()}`);
    fs.mkdirSync(directory, { mode: 0o700 }); requirePrivate(verifyPrivate, directory);
    // A directory without manifest.json is incomplete and must never import.
    for (const [name, bytes] of files) {
      if (bytes === null) continue;
      const destination = path.join(directory, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(destination, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    let memory = null;
    if (memoryFile !== null) {
      plainDirectory(path.dirname(memoryFile)); regular(memoryFile);
      const database = new DatabaseSync(memoryFile, { readOnly: true });
      const destination = path.join(directory, 'memory.sqlite');
      try { await backup(database, destination); } finally { database.close(); }
      await check(); regular(destination);
      memory = { name: 'memory.sqlite', ...fileDigest(destination) };
    }
    const again = fileSet(await readFiles()); await check();
    if (JSON.stringify(index(again)) !== JSON.stringify(index(files))) throw fail('MIGRATION_SOURCE_CHANGED');
    const manifest = { version: 1, account: initial.account, epoch: initial.epoch, provenance: initial.provenance, created: now(), files: index(files), memory };
    if (!Number.isFinite(manifest.created)) throw fail('INVALID_CLOCK');
    const snapshotId = sha(encode(manifest));
    const fd = fs.openSync(path.join(directory, 'manifest.json'), 'wx', 0o600);
    try { fs.writeFileSync(fd, encode({ ...manifest, snapshotId })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    await check();
    return { directory, snapshotId, account: initial.account };
  } catch (error) {
    // Preserve partial backup material. Invalidate only our commit marker;
    // never remove sources or a completed backup belonging to another capture.
    if (directory && fs.existsSync(path.join(directory, 'manifest.json'))) {
      fs.renameSync(path.join(directory, 'manifest.json'), path.join(directory, 'incomplete-manifest.json'));
    }
    throw error;
  } finally { await lease.release(); }
}

// Hash verification is integrity, not account authentication. The caller must
// independently attest that this private snapshot belongs to expectedAccount.
export function loadMigrationSnapshot({ directory, expectedAccount, verifyPrivate, attest }) {
  accountId(expectedAccount); plainDirectory(directory); requirePrivate(verifyPrivate, directory);
  const marker = path.join(directory, 'manifest.json');
  if (regular(marker).size > 1024 * 1024) throw fail('MIGRATION_SNAPSHOT_TOO_LARGE');
  const { snapshotId, ...manifest } = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (manifest.version !== 1 || manifest.account !== expectedAccount || sha(encode(manifest)) !== snapshotId
      || typeof attest !== 'function' || attest({ directory, snapshotId, account: expectedAccount, epoch: manifest.epoch }) !== true) throw fail('MIGRATION_SNAPSHOT_UNVERIFIED');
  if (!Array.isArray(manifest.files) || new Set(manifest.files.map(row => row.name)).size !== manifest.files.length) throw fail('MIGRATION_INVALID_SOURCE');
  const files = Object.create(null);
  let total = 0;
  const read = row => {
    const file = path.join(directory, row.name); plainDirectory(path.dirname(file)); const stat = regular(file);
    total += stat.size;
    if (total > 128 * 1024 * 1024) throw fail('MIGRATION_SNAPSHOT_TOO_LARGE');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) throw fail('MIGRATION_SNAPSHOT_CORRUPT');
    return bytes;
  };
  for (const row of manifest.files) {
    if (!safeName(row.name)) throw fail('MIGRATION_INVALID_SOURCE');
    files[row.name] = row.sha256 === null && row.bytes === null ? null : read(row);
  }
  fileSet(files);
  if (manifest.memory) {
    if (manifest.memory.name !== 'memory.sqlite') throw fail('MIGRATION_INVALID_SOURCE');
    const file = path.join(directory, 'memory.sqlite'); regular(file);
    const digest = fileDigest(file);
    if (digest.bytes !== manifest.memory.bytes || digest.sha256 !== manifest.memory.sha256) throw fail('MIGRATION_SNAPSHOT_CORRUPT');
  }
  const handle = Object.freeze({ snapshotId, account: expectedAccount });
  verified.set(handle, { manifest, files });
  return handle;
}

export function snapshotJson(handle, name) {
  const data = verified.get(handle);
  if (!data || !names.includes(name) || !name.endsWith('.json')) throw fail('MIGRATION_SNAPSHOT_UNVERIFIED');
  const bytes = data.files[name];
  return bytes === null ? null : JSON.parse(bytes.toString('utf8'));
}

// Fixed source mapping; explicit absent files are part of the digest. This is a
// reader only: the caller still needs the capture lease and account provenance.
export function readLegacySnapshotFiles(root) {
  plainDirectory(root);
  const files = Object.create(null); let total = 0;
  const read = relative => {
    const file = path.join(root, relative);
    try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    plainDirectory(path.dirname(file));
    total += regular(file).size;
    if (total > 128 * 1024 * 1024) throw fail('MIGRATION_SNAPSHOT_TOO_LARGE');
    return fs.readFileSync(file);
  };
  for (const [name, relative] of Object.entries(MIGRATION_SOURCE_FILES)) files[name] = read(relative);
  const roles = path.join(root, 'roles');
  if (fs.existsSync(roles)) {
    plainDirectory(roles);
    for (const name of fs.readdirSync(roles).sort()) {
      if (!name.endsWith('.md')) continue;
      const relative = `roles/${name}`;
      if (!safeName(relative)) throw fail('MIGRATION_UNSAFE_FILE');
      files[relative] = read(relative);
    }
  }
  return Object.fromEntries(fileSet(files));
}
