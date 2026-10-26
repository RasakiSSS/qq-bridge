// Offline preparation only. All output stays in the existing private probe package.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ORIGINAL_MAIN = './application.asar/app_launcher/index.js';
const PROBE_MAIN = './app_launcher/qq-bridge-probe.cjs';
// Upstream QQNTFileVerifyPatch f62c9bc7bc50cb0655d9a0bd6a4db0d21fc2d8d4.
const SIGNATURE = Buffer.from('4889ce488b114c8b41084929d0488b4918e8', 'hex');

export function makeBootstrap(probeEntry) {
  return `'use strict';\nconst path = require('node:path');\n` +
    `try { require(${JSON.stringify(probeEntry)}); }\n` +
    `catch { console.warn('[QQ Friend Probe] Probe unavailable; continuing QQ startup.'); }\n` +
    `const originalMain = ${JSON.stringify(ORIGINAL_MAIN)};\n` +
    `require(path.join(process.resourcesPath, 'app', originalMain));\n` +
    `setImmediate(() => {\n  const pkg = globalThis.launcher?.installPathPkgJson;\n` +
    `  if (pkg) pkg.main = originalMain;\n});\n`;
}

export function makeCandidateDll(original) {
  if (original.length < 64 || original.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a PE file');
  const pe = original.readUInt32LE(0x3c);
  if (pe + 24 > original.length || original.readUInt32LE(pe) !== 0x4550 || original.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error('Expected an x64 PE file');
  }
  const match = original.indexOf(SIGNATURE);
  if (match < 0 || original.indexOf(SIGNATURE, match + 1) >= 0) throw new Error('Expected exactly one upstream patch signature');
  const offset = match + SIGNATURE.length - 1;
  const sectionCount = original.readUInt16LE(pe + 6);
  const sectionTable = pe + 24 + original.readUInt16LE(pe + 20);
  if (sectionTable + sectionCount * 40 > original.length) throw new Error('Invalid PE section table');
  let executableSection = false;
  for (let i = 0; i < sectionCount; i++) {
    const section = sectionTable + i * 40;
    const size = original.readUInt32LE(section + 16);
    const start = original.readUInt32LE(section + 20);
    const flags = original.readUInt32LE(section + 36);
    if ((flags & 0x20000000) && offset >= start && offset + 5 <= start + size && start + size <= original.length) {
      executableSection = true;
    }
  }
  if (!executableSection) throw new Error('Patch location is not within an executable PE section');
  const candidate = Buffer.from(original);
  Buffer.from('b801000000', 'hex').copy(candidate, offset);
  if (!candidate.subarray(0, offset).equals(original.subarray(0, offset))
    || !candidate.subarray(offset + 5).equals(original.subarray(offset + 5))) throw new Error('Unexpected binary changes');
  return { candidate, offset, before: original.subarray(offset, offset + 5).toString('hex'), after: 'b801000000' };
}

function prepare() {
  const { values } = parseArgs({ options: {
    'qq-app': { type: 'string' }, package: { type: 'string' }, 'dll-sha256': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || !values['qq-app'] || !values.package || !values['dll-sha256']) {
    console.log('Usage: node scripts/prepare-qq-probe-deployment.mjs --qq-app "<QQ resources/app>" --package "<state/probes/package>" --dll-sha256 <verified-original-sha256>');
    if (!values.help) process.exitCode = 2;
    return;
  }
  const packageDir = fs.realpathSync(values.package);
  const allowed = fs.realpathSync(path.join(ROOT, 'state', 'probes')) + path.sep;
  if (!packageDir.toLowerCase().startsWith(allowed.toLowerCase())) throw new Error('Output must be inside project state/probes');
  const app = fs.realpathSync(values['qq-app']);
  const dllPath = path.resolve(app, '..', '..', 'QQNT.dll');
  const metadataPath = path.join(app, 'package.json');
  const bootstrapPath = path.join(app, 'app_launcher', 'qq-bridge-probe.cjs');
  const pluginDir = path.join(packageDir, 'qq-bridge-friend-probe');
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'preparation.json'), 'utf8'));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (path.basename(name) !== name || sha256(fs.readFileSync(path.join(pluginDir, name))) !== expected) {
      throw new Error('Prepared plugin file hash mismatch');
    }
  }
  const config = JSON.parse(fs.readFileSync(path.join(pluginDir, 'config.json'), 'utf8'));
  const originalMetadata = fs.readFileSync(metadataPath);
  const metadata = JSON.parse(originalMetadata.toString('utf8'));
  if (metadata.version !== config.qqVersion || metadata.main !== ORIGINAL_MAIN || fs.existsSync(bootstrapPath)) {
    throw new Error('QQ version/entry differs from the inspected installation');
  }
  if (sha256(fs.readFileSync(path.join(app, 'wrapper.node'))) !== config.wrapperSha256) throw new Error('QQ wrapper changed');
  const originalDll = fs.readFileSync(dllPath);
  if (sha256(originalDll) !== values['dll-sha256']) throw new Error('QQNT.dll changed');
  const { candidate, offset, before, after } = makeCandidateDll(originalDll);
  const candidateMetadata = Buffer.from(JSON.stringify({ ...metadata, main: PROBE_MAIN }, null, 2) + '\n');
  const bootstrap = Buffer.from(makeBootstrap(path.join(pluginDir, 'main.cjs')));
  const deployment = path.join(packageDir, 'deployment');
  // realpath check also prevents an existing deployment directory from redirecting output.
  if (!fs.existsSync(deployment)) fs.mkdirSync(deployment);
  if (fs.realpathSync(deployment) !== deployment) throw new Error('Deployment directory must not redirect elsewhere');
  const backups = path.join(deployment, 'backup');
  const candidates = path.join(deployment, 'candidate');
  if (fs.existsSync(backups) || fs.existsSync(candidates)) throw new Error('Deployment was already prepared; preserve the existing backup');
  fs.mkdirSync(backups); fs.mkdirSync(candidates);
  const changes = [
    { name: 'QQNT.dll', target: dllPath, original: originalDll, proposed: candidate },
    { name: 'package.json', target: metadataPath, original: originalMetadata, proposed: candidateMetadata },
    { name: 'qq-bridge-probe.cjs', target: bootstrapPath, original: null, proposed: bootstrap },
  ];
  const files = changes.map(({ name, target, original, proposed }) => {
    const backup = original ? path.join(backups, name) : null;
    if (backup) fs.writeFileSync(backup, original, { flag: 'wx' });
    const proposedPath = path.join(candidates, name);
    fs.writeFileSync(proposedPath, proposed, { flag: 'wx' });
    return { target, backup, candidate: proposedPath, beforeSha256: original ? sha256(original) : null, afterSha256: sha256(proposed) };
  });
  const planPath = path.join(deployment, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
    preparedAt: new Date().toISOString(), installed: false, runtimeVerified: false,
    strategy: 'temporary-direct-bootstrap', qqVersion: config.qqVersion,
    requiresClosingAllQQInstancesUsingThisInstallation: true,
    patchSource: 'https://github.com/LiteLoaderQQNT/QQNTFileVerifyPatch/blob/f62c9bc7bc50cb0655d9a0bd6a4db0d21fc2d8d4/QQNTPatcher/QQNTPatcher/main.cpp',
    binaryPatch: { offset, before, after, size: 5 }, files,
  }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ planPath, installed: false, binaryPatchBytes: 5, filesToChange: files.length }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { prepare(); } catch (error) { console.error(`Preparation failed: ${error.message}`); process.exitCode = 1; }
}
