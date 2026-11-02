import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { archiveScripts, snippets, collectClientCode, LIMITS } from '../plugins/qq-friend-probe/client-code-evidence.cjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const archivePath = path.resolve('SIMULATED-QQ', 'application.asar');
function archive(files, payload = Buffer.alloc(128)) {
  const json = Buffer.from(JSON.stringify({ files }));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4); head.writeUInt32LE(json.length + 8, 4);
  head.writeUInt32LE(json.length + 4, 8); head.writeUInt32LE(json.length, 12);
  return Buffer.concat([head, json, payload]);
}
const entry = (size = 10) => ({ size, offset: '0' });
function fixture(files, content = {}) {
  const bytes = archive(files);
  const reads = [];
  return { reads, options: { archivePath, archiveSha256: sha256(bytes), yieldTick: async () => {},
    fsApi: {
      statSync() { return { size: bytes.length }; },
      readFileSync(file) {
        reads.push(file);
        if (file === archivePath) return bytes;
        const relative = path.relative(archivePath, file).replaceAll('\\', '/');
        if (!Object.hasOwn(content, relative)) throw new Error('PRIVATE_IO_ERROR');
        return content[relative];
      },
    } } };
}

test('ASAR inventory accepts only packed JavaScript members and never follows links', () => {
  const bytes = archive({ renderer: { files: { 'main.js': entry(), 'a.png': entry(),
    'link.js': { link: '../../profile/session.js' }, 'outside.js': { ...entry(), unpacked: true } } } });
  assert.deepEqual(archiveScripts(bytes), [{ path: 'renderer/main.js', size: 10 }]);
});

test('unsafe member names, invalid ranges and oversized headers are rejected', () => {
  for (const name of ['..', '.', '../outside.js', 'dir\\outside.js', 'C:evil.js']) {
    assert.throws(() => archiveScripts(archive({ [name]: entry() })), /Invalid archive entry/);
  }
  for (const record of [{ size: -1, offset: '0' }, { size: 1000, offset: '0' }, { size: 1, offset: '-1' },
    { size: 1, offset: '1e1' }, { size: 1, offset: '9007199254740993' }]) {
    assert.throws(() => archiveScripts(archive({ 'a.js': record })), /Invalid script range/);
  }
  const malformed = archive({}); malformed.writeUInt32LE(LIMITS.header + 1, 12);
  assert.throws(() => archiveScripts(malformed), /Invalid archive header/);
});

test('archive and member paths are mandatory, bounded and pinned before any member read', async () => {
  const f = fixture({ 'a.js': entry() });
  await assert.rejects(collectClientCode({ ...f.options, archiveSha256: '0'.repeat(64) }), /hash mismatch/);
  assert.deepEqual(f.reads, [archivePath]);
  for (const bad of ['relative/application.asar', path.resolve('sessions.json')]) {
    await assert.rejects(collectClientCode({ ...f.options, archivePath: bad }), /attestation required/);
  }
});

test('only bounded static marker context is collected, with member and content hashes', async () => {
  const source = Buffer.from('/* client */ svc.addBuddy(context, request, bytes);');
  const f = fixture({ 'a.js': entry(), 'unrelated.js': entry() }, {
    'a.js': source, 'unrelated.js': Buffer.from('const unrelated = "DO_NOT_COPY_UNRELATED_ASSET";'),
  });
  const report = await collectClientCode(f.options);
  assert.equal(report.phase, 'complete'); assert.equal(report.plaintextCount, 2);
  assert.equal(report.entries.length, 1); assert.equal(report.entries[0].path, 'a.js');
  assert.equal(report.entries[0].sha256, sha256(source));
  assert.equal(report.entries[0].matches[0].marker, 'addBuddy');
  assert.equal(JSON.stringify(report).includes('DO_NOT_COPY_UNRELATED_ASSET'), false);
});

test('Electron archive hashes use original-fs while virtual members use patched fs', async () => {
  const f = fixture({ 'a.js': entry() }, { 'a.js': Buffer.from('svc.addBuddy(x,y,z)') });
  const originalFs = f.options.fsApi;
  const stages = [];
  const patchedFs = { readFileSync(file) {
    if (file === archivePath) throw Object.assign(new Error('Archive is a virtual directory'), { code: 'EISDIR' });
    return originalFs.readFileSync(file);
  } };
  const report = await collectClientCode({ ...f.options, fsApi: patchedFs, archiveFs: originalFs, onStage: stage => stages.push(stage) });
  assert.equal(report.entries.length, 1);
  assert.deepEqual(stages, ['archive-stat', 'archive-read', 'archive-hash', 'archive-index', 'scan-members']);
  assert.deepEqual(f.reads, [archivePath, path.join(archivePath, 'a.js')]);
});

test('static code is never evaluated and binary/encrypted members are counted without copying', async () => {
  const f = fixture({ 'a.js': entry(), 'b.js': entry(), 'c.js': entry() }, {
    'a.js': Buffer.from('throw new Error("do not execute"); svc.addBuddy(x,y,z);'),
    'b.js': Buffer.from([0xff, 0x00, 0xfe]), 'c.js': Buffer.from('addBuddy\0binary'),
  });
  const report = await collectClientCode(f.options);
  assert.equal(report.entries.length, 1); assert.equal(report.nonTextCount, 2);
});

test('I/O errors are counted without leaking exception content', async () => {
  const f = fixture({ 'a.js': entry() });
  const report = await collectClientCode(f.options);
  assert.equal(report.readErrors, 1); assert.equal(JSON.stringify(report).includes('PRIVATE_IO_ERROR'), false);
});

test('stop before inspection performs no I/O; stop between members prevents further reads', async () => {
  const f = fixture({ 'a.js': entry(), 'b.js': entry() }, { 'a.js': Buffer.from('addBuddy()') });
  const before = await collectClientCode({ ...f.options, shouldContinue: () => false });
  assert.equal(before.phase, 'cancelled'); assert.equal(f.reads.length, 0);
  let ticks = 0;
  const during = await collectClientCode({ ...f.options, yieldTick: async () => { ticks++; }, shouldContinue: () => ticks < 2 });
  assert.equal(during.phase, 'cancelled'); assert.equal(during.readCount, 1);
  assert.equal(f.reads.some(file => file.endsWith('b.js')), false);
});

test('exact marker matching and per-report cap prevent unbounded output', async () => {
  assert.deepEqual(snippets('myaddBuddyX fake_getBuddySettingSuffix'), []);
  const source = Buffer.from('svc.addBuddy(x,y,z);'.repeat(2000));
  const f = fixture({ 'a.js': entry(), 'b.js': entry() }, { 'a.js': source });
  const report = await collectClientCode(f.options);
  assert.equal(report.entries[0].matches.length, LIMITS.matches);
  assert.equal(report.truncated, true); assert.equal(report.readCount, 1);
  assert.ok(report.entries[0].matches.every(m => m.source.length <= LIMITS.radius * 2 + 32));
});

test('oversized member content is not copied into a report', async () => {
  const f = fixture({ 'a.js': entry() }, { 'a.js': Buffer.alloc(LIMITS.fileBytes + 1, 97) });
  const report = await collectClientCode(f.options);
  assert.equal(report.truncated, true); assert.deepEqual(report.entries, []);
});
