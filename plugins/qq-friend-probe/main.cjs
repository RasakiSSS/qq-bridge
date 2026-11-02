'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { startProbe } = require('./probe.cjs');
const singleton = Symbol.for('qq-bridge.readonly-friend-probe.v1');

function launch() {
  // A stock checkout is inert. Deployment preparation supplies a local config.
  const configPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.enabled !== true) return null;
  if (process.platform !== 'win32' || !process.versions.electron || process.type !== 'browser') {
    throw new Error('This entry point requires the Windows QQ Electron main process');
  }
  if (!/^[a-f0-9]{64}$/.test(config.wrapperSha256 ?? '') || !path.isAbsolute(config.reportDir ?? '')) {
    throw new Error('Explicit wrapper SHA-256 and absolute reportDir are required');
  }
  if (typeof config.qqVersion !== 'string' || !/^\d+\.\d+\.\d+-\d+$/.test(config.qqVersion)) {
    throw new Error('Explicit QQ version is required');
  }
  const startedAt = new Date().toISOString();
  const reportFile = path.join(config.reportDir, `probe-${process.pid}-${Date.now()}.json`);
  let warned = false;
  let verifiedApp = null;
  let codeScheduled = false;
  let stopped = false;
  if (config.inspectClientCode === true && !/^[a-f0-9]{64}$/.test(config.applicationSha256 ?? '')) {
    throw new Error('Client code inspection requires the archive SHA-256');
  }
  const probe = startProbe({
    runtime: process, cache: require.cache, expectedUin: config.expectedUin,
    requestObservation: config.observeRequestTarget === undefined ? null : {
      targetUin: config.observeRequestTarget, qqVersion: config.qqVersion, wrapperSha256: config.wrapperSha256,
      targetUid: config.observeRequestTargetUid, observeAddBuddy: config.observeAddBuddy,
    },
    timeoutMs: config.timeoutMs,
    attestWrapper(filename) {
      const resolved = fs.realpathSync(filename);
      if (fs.statSync(resolved).size > 512 * 1024 * 1024) return false;
      const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(resolved), 'package.json'), 'utf8'));
      if (metadata.version !== config.qqVersion) return false;
      const matches = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') === config.wrapperSha256;
      if (matches) verifiedApp = path.dirname(resolved);
      return matches;
    },
    onReport(report) {
      if (codeScheduled && (!report.identityMatched || !report.initCallReturned
        || report.phase === 'account-reinitialized')) stopped = true;
      try {
        fs.mkdirSync(config.reportDir, { recursive: true });
        fs.writeFileSync(reportFile, JSON.stringify({ formatVersion: 4, pid: process.pid, startedAt,
          updatedAt: new Date().toISOString(), qqVersion: config.qqVersion, ...report }, null, 2) + '\n');
      } catch {
        if (!warned) console.warn('[QQ Friend Probe] Cannot write the local probe report.');
        warned = true;
      }
      if (!report.active) console.info(`[QQ Friend Probe] Finished: ${report.phase}`);
      if (config.inspectClientCode === true && !codeScheduled && !stopped && verifiedApp
        && report.wrapperVerified && report.identityMatched && report.initCallReturned) {
        codeScheduled = true;
        setImmediate(async () => {
          const deadline = Date.now() + 30000;
          const evidenceFile = path.join(config.reportDir, `client-code-${process.pid}-${Date.now()}.json`);
          let stage = 'load-collector';
          try {
            const { collectClientCode } = require('./client-code-evidence.cjs');
            stage = 'load-original-fs';
            const archiveFs = require('original-fs');
            const evidence = await collectClientCode({ archivePath: path.join(verifiedApp, 'application.asar'),
              archiveSha256: config.applicationSha256, archiveFs, onStage: value => { stage = value; },
              shouldContinue: () => !stopped && Date.now() < deadline });
            stage = 'write-evidence';
            fs.mkdirSync(config.reportDir, { recursive: true });
            fs.writeFileSync(evidenceFile, JSON.stringify({ formatVersion: 1, qqVersion: config.qqVersion,
              updatedAt: new Date().toISOString(), ...evidence }, null, 2) + '\n');
          } catch (error) {
            try {
              const allowedCodes = ['ENOENT', 'EISDIR', 'ENOTDIR', 'EACCES', 'EPERM', 'MODULE_NOT_FOUND',
                'ERR_UNKNOWN_BUILTIN_MODULE', 'ARCHIVE_TOO_LARGE', 'ARCHIVE_HASH_MISMATCH'];
              const code = allowedCodes.includes(error?.code) ? error.code : 'UNCLASSIFIED';
              fs.mkdirSync(config.reportDir, { recursive: true });
              fs.writeFileSync(evidenceFile, JSON.stringify({ formatVersion: 1, phase: 'inspection-failed', stage, code }) + '\n');
            } catch { /* File failures must not affect QQ startup. */ }
          }
        });
      }
    },
  });
  return { stop() { stopped = true; return probe.stop(); } };
}

if (!globalThis[singleton]) {
  try { globalThis[singleton] = launch(); }
  catch { console.warn('[QQ Friend Probe] Disabled: invalid configuration or unsupported environment.'); }
}
module.exports = { stop: () => globalThis[singleton]?.stop() };
