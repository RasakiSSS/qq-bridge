'use strict';

// Read only the pinned QQ installation archive. No native method, IPC, network,
// eval, user profile, request payload, or login state is inspected here.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isUtf8 } = require('node:buffer');

const MARKERS = Object.freeze(['getAddBuddyService', 'addBuddy', 'getAddBuddyRequestTag',
  'getBuddySetting', 'requestInfoByAccount', 'queryUinSafetyFlag']);
const LIMITS = Object.freeze({ archive: 128 * 1024 * 1024, header: 4 * 1024 * 1024,
  entries: 10000, files: 1000, fileBytes: 4 * 1024 * 1024, totalBytes: 40 * 1024 * 1024,
  matches: 48, radius: 1800, depth: 24 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function archiveScripts(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > LIMITS.archive
    || bytes.readUInt32LE(0) !== 4) throw new Error('Unsupported archive');
  const headerSize = bytes.readUInt32LE(4);
  const jsonSize = bytes.readUInt32LE(12);
  const dataOffset = 8 + headerSize;
  if (headerSize < 8 || jsonSize > LIMITS.header || jsonSize > headerSize - 8
    || dataOffset > bytes.length) throw new Error('Invalid archive header');
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8'));
  const scripts = [];
  let count = 0;
  function walk(directory, prefix = '', depth = 0) {
    if (depth > LIMITS.depth || !directory?.files || typeof directory.files !== 'object'
      || Array.isArray(directory.files)) throw new Error('Invalid archive directory');
    for (const [name, entry] of Object.entries(directory.files)) {
      if (++count > LIMITS.entries || !/^[A-Za-z0-9_.@-]+$/.test(name) || name === '.' || name === '..'
        || !entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid archive entry');
      // Never follow links or read unpacked files outside the attested archive.
      if (Object.hasOwn(entry, 'link') || entry.unpacked) continue;
      const relative = prefix + name;
      if (entry.files) { walk(entry, relative + '/', depth + 1); continue; }
      if (!/\.(?:c|m)?js$/i.test(name)) continue;
      const offset = Number(entry.offset);
      if (typeof entry.offset !== 'string' || !/^\d+$/.test(entry.offset)
        || !Number.isSafeInteger(offset) || !Number.isSafeInteger(entry.size) || entry.size < 0
        || offset + entry.size > bytes.length - dataOffset) throw new Error('Invalid script range');
      scripts.push({ path: relative, size: entry.size });
    }
  }
  walk(header);
  return scripts.sort((a, b) => a.path.localeCompare(b.path));
}

function snippets(source, maxMatches = LIMITS.matches) {
  const found = [];
  // Source is static program text, never executed. Store bounded context around
  // exact identifiers; no arbitrary keyword or path is accepted from a model.
  const pattern = /\b(getAddBuddyService|addBuddy|getAddBuddyRequestTag|getBuddySetting|requestInfoByAccount|queryUinSafetyFlag)\b/g;
  for (const match of source.matchAll(pattern)) {
    if (found.length >= maxMatches) break;
    const start = Math.max(0, match.index - LIMITS.radius);
    const end = Math.min(source.length, match.index + match[0].length + LIMITS.radius);
    found.push({ marker: match[0], offset: match.index, start, end, source: source.slice(start, end) });
  }
  return found;
}

async function collectClientCode({ archivePath, archiveSha256, fsApi = fs, archiveFs = fsApi, onStage = () => {},
  shouldContinue = () => true, yieldTick = () => new Promise(resolve => setImmediate(resolve)) }) {
  if (!path.isAbsolute(archivePath ?? '') || path.basename(archivePath) !== 'application.asar'
    || !/^[a-f0-9]{64}$/.test(archiveSha256 ?? '')) throw new Error('Explicit archive attestation required');
  if (!shouldContinue()) return { phase: 'cancelled', entries: [] };
  // Electron's patched fs treats the archive itself as a directory. Raw hash
  // and header reads must use original-fs, while member reads use patched fs.
  onStage('archive-stat');
  if (archiveFs.statSync(archivePath).size > LIMITS.archive) throw Object.assign(new Error('Archive too large'), { code: 'ARCHIVE_TOO_LARGE' });
  onStage('archive-read');
  const bytes = archiveFs.readFileSync(archivePath);
  onStage('archive-hash');
  if (sha256(bytes) !== archiveSha256) throw Object.assign(new Error('Archive hash mismatch'), { code: 'ARCHIVE_HASH_MISMATCH' });
  onStage('archive-index');
  const scripts = archiveScripts(bytes);
  const report = { kind: 'static-qq-client-code-evidence', phase: 'complete', archiveSha256,
    scriptCount: scripts.length, readCount: 0, plaintextCount: 0, readErrors: 0,
    nonTextCount: 0, skippedLarge: 0, bytesRead: 0, truncated: false, entries: [] };
  let matches = 0;
  onStage('scan-members');
  for (const script of scripts) {
    await yieldTick(); // Do not monopolize QQ's main loop while scanning assets.
    if (!shouldContinue()) { report.phase = 'cancelled'; break; }
    if (report.readCount >= LIMITS.files || matches >= LIMITS.matches) { report.truncated = true; break; }
    if (script.size > LIMITS.fileBytes) { report.skippedLarge++; continue; }
    if (report.bytesRead + script.size > LIMITS.totalBytes) { report.truncated = true; break; }
    let content;
    report.readCount++;
    try {
      // Electron's own filesystem resolves ASAR members. Ordinary Node cannot
      // decrypt this QQ archive; unreadable/binary assets are reported, not run.
      content = fsApi.readFileSync(path.join(archivePath, ...script.path.split('/')));
    } catch { report.readErrors++; continue; }
    if (!Buffer.isBuffer(content)) { report.nonTextCount++; continue; }
    report.bytesRead += content.length;
    if (content.length > LIMITS.fileBytes || report.bytesRead > LIMITS.totalBytes) { report.truncated = true; break; }
    if (!isUtf8(content) || content.includes(0)) { report.nonTextCount++; continue; }
    report.plaintextCount++;
    const remaining = LIMITS.matches - matches;
    const found = snippets(content.toString('utf8'), remaining + 1);
    if (found.length > remaining) { found.length = remaining; report.truncated = true; }
    if (found.length) report.entries.push({ path: script.path, sha256: sha256(content), matches: found });
    matches += found.length;
  }
  return report;
}

module.exports = { MARKERS, LIMITS, archiveScripts, snippets, collectClientCode };
