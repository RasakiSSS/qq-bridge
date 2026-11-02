// Prepare a local, version-pinned package. This does not install anything into QQ.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectWrapper } from './probe-qq-friend-add.mjs';
import { normalizeObservation } from '../plugins/qq-friend-probe/request-observer.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  wrapper: { type: 'string' }, account: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  'observe-request-target': { type: 'string' },
  'observe-add-buddy': { type: 'boolean' }, 'target-identity': { type: 'string' },
  'inspect-client-code': { type: 'boolean' },
} });

if (values.help || !values.wrapper || !values.account) {
  console.log('Usage: node scripts/prepare-qq-friend-probe.mjs --wrapper "<actual QQ app>/wrapper.node" --account <bot QQ>');
  console.log('Creates a private package under state/probes. Does not install, launch, or restart QQ.');
  console.log('Optional: --observe-request-target <QQ> observes one QQ-initiated request (30 minute timeout), never sends one.');
  console.log('Add --observe-add-buddy for both native services; --target-identity <local JSON> supplies a verified UIN/UID mapping.');
  console.log('Optional: --inspect-client-code reads bounded static code from the pinned application.asar after the matching QQ account initializes; no request is required.');
  if (!values.help) process.exitCode = 2;
} else {
  try {
    if (!/^\d{5,20}$/.test(values.account)) throw new Error('An explicit bot QQ account is required');
    const wrapper = inspectWrapper(values.wrapper);
    if (!wrapper.getBuddyServiceMarker || !wrapper.reqToAddFriendsMarker
      || wrapper.argumentCountsInAssertions.length !== 1 || wrapper.argumentCountsInAssertions[0] !== 1
      || !/^\d+\.\d+\.\d+-\d+$/.test(wrapper.packageVersion ?? '')) {
      throw new Error('Wrapper evidence does not match the verified single-argument version family');
    }
    const source = path.join(ROOT, 'plugins', 'qq-friend-probe');
    if (!values['observe-request-target'] && (values['observe-add-buddy'] || values['target-identity'])) {
      throw new Error('An explicit request target is required for request observation options');
    }
    let targetUid;
    if (values['target-identity']) {
      const identity = JSON.parse(fs.readFileSync(values['target-identity'], 'utf8').replace(/^\uFEFF/, ''));
      if (identity.botUin !== values.account || identity.targetUin !== values['observe-request-target'] || !identity.targetUid) {
        throw new Error('Local identity mapping does not match the explicit bot and target');
      }
      targetUid = identity.targetUid;
    }
    const observation = values['observe-request-target'] === undefined ? null : normalizeObservation({
      targetUin: values['observe-request-target'], qqVersion: wrapper.packageVersion, wrapperSha256: wrapper.sha256,
      targetUid, observeAddBuddy: values['observe-add-buddy'],
    });
    const applicationSha256 = values['inspect-client-code']
      ? createHash('sha256').update(fs.readFileSync(path.join(path.dirname(fs.realpathSync(values.wrapper)), 'application.asar'))).digest('hex') : null;
    const files = ['probe.cjs', 'main.cjs', 'request-contract.cjs', 'request-observer.cjs', 'client-code-evidence.cjs', 'manifest.json', 'config.example.json', 'README.md'];
    const content = files.map((name) => ({ name, bytes: fs.readFileSync(path.join(source, name)) }));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    const destination = path.join(ROOT, 'state', 'probes', `qq-friend-probe-${stamp}`);
    const pluginDir = path.join(destination, 'qq-bridge-friend-probe');
    const reportDir = path.join(destination, 'reports');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.mkdirSync(destination);
    fs.mkdirSync(pluginDir);
    for (const { name, bytes } of content) fs.writeFileSync(path.join(pluginDir, name), bytes, { flag: 'wx' });
    const config = { enabled: true, expectedUin: values.account, qqVersion: wrapper.packageVersion,
      wrapperSha256: wrapper.sha256, reportDir, timeoutMs: observation ? 1800000 : 120000,
      ...(applicationSha256 ? { inspectClientCode: true, applicationSha256 } : {}),
      ...(observation ? { observeRequestTarget: observation.targetUin,
        observeAddBuddy: observation.observeAddBuddy,
        ...(observation.targetUid ? { observeRequestTargetUid: observation.targetUid } : {}) } : {}) };
    fs.writeFileSync(path.join(pluginDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    const hashes = Object.fromEntries(content.map(({ name, bytes }) => [name, createHash('sha256').update(bytes).digest('hex')]));
    hashes['config.json'] = createHash('sha256').update(fs.readFileSync(path.join(pluginDir, 'config.json'))).digest('hex');
    fs.writeFileSync(path.join(destination, 'preparation.json'), JSON.stringify({
      preparedAt: new Date().toISOString(), installed: false, runtimeVerified: false,
      qqVersion: wrapper.packageVersion, wrapperSha256: wrapper.sha256, files: hashes,
    }, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ pluginDir, reportDir, installed: false, runtimeVerified: false }, null, 2));
  } catch (error) {
    console.error(`Preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
