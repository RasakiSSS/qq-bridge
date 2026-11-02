'use strict';

// Trusted local loader for the isolated send-once runtime. Watching a QQ-owned
// session never creates a session, calls a service getter, or sends an action.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { startProbe } = require('./probe.cjs');
const { QQ_VERSION, WRAPPER_SHA256, MAJOR_SHA256 } = require('./friend-adapter.cjs');

function startFriendBinding({ expectedUin, wrapperPath, timeoutMs = 120000,
  onReport = () => {}, onBuddyBinding = null, persistent = false, acquireAddService = false, runtime = process, cache = require.cache } = {}) {
  if (runtime.platform !== 'win32' || !runtime.versions?.electron || runtime.type !== 'browser') {
    throw new Error('ERR_UNSUPPORTED_RUNTIME');
  }
  if (typeof wrapperPath !== 'string' || !path.isAbsolute(wrapperPath)
    || path.basename(wrapperPath).toLowerCase() !== 'wrapper.node') throw new Error('ERR_INVALID_WRAPPER_PATH');
  if (typeof onReport !== 'function') throw new Error('ERR_INVALID_REPORTER');
  if (onBuddyBinding !== null && typeof onBuddyBinding !== 'function') throw new Error('ERR_INVALID_REPORTER');
  const expectedPath = path.resolve(wrapperPath);
  const appDir = path.dirname(expectedPath);
  if (path.basename(appDir) !== 'app' || path.basename(path.dirname(appDir)) !== 'resources'
    || path.basename(path.dirname(path.dirname(appDir))) !== QQ_VERSION) throw new Error('ERR_INVALID_WRAPPER_PATH');
  let pinsVerified = false;
  let current = null;
  function verifyFile(filename, expectedHash) {
    const resolved = fs.realpathSync(filename);
    // No symlink alias to an unrelated installation or substituted backup.
    if (path.relative(path.resolve(filename), resolved) !== '') return false;
    const info = fs.statSync(resolved);
    return info.isFile() && info.size > 0 && info.size <= 512 * 1024 * 1024
      && createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') === expectedHash;
  }
  const observer = startProbe({ runtime, cache, expectedUin, timeoutMs, persistent, acquireAddService,
    attestWrapper(filename) {
      pinsVerified = false;
      if (path.relative(expectedPath, path.resolve(filename)) !== '') return false;
      if (!verifyFile(expectedPath, WRAPPER_SHA256)
        || !verifyFile(path.join(appDir, 'major.node'), MAJOR_SHA256)) return false;
      const metadata = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      if (metadata.version !== QQ_VERSION) return false;
      pinsVerified = true;
      return true;
    },
    onBinding(binding) {
      current = null;
      if (!binding || !pinsVerified || binding.accountUin !== expectedUin) return;
      current = Object.freeze({ ...binding, qqVersion: QQ_VERSION,
        wrapperSha256: WRAPPER_SHA256, majorSha256: MAJOR_SHA256 });
    },
    onBuddyBinding: onBuddyBinding === null ? null : binding => {
      onBuddyBinding(binding && pinsVerified && binding.accountUin === expectedUin
        ? Object.freeze({ ...binding, qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256, majorSha256: MAJOR_SHA256 }) : null);
    },
    onReport,
  });
  return Object.freeze({
    getBinding() {
      if (!current || !pinsVerified || !current.isCurrent()) return null;
      return current;
    },
    snapshot: observer.snapshot,
    stop() { current = null; pinsVerified = false; return observer.stop(); },
  });
}

module.exports = { startFriendBinding };
