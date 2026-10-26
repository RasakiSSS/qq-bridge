// Prepare a maintenance package only. Does not patch, start QQ or send requests.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { QQ_VERSION, WRAPPER_SHA256, MAJOR_SHA256, buildObservedAddBuddyEnvelope } from '../plugins/qq-friend-probe/friend-adapter.cjs';
import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function writeValidationPackage({ wrapperPath, identity, connection, production = false, snowlumaHome, outputParent = path.join(root, 'state', 'probes') }) {
  if (!identity || !/^\d{5,16}$/.test(identity.botUin) || !/^\d{5,16}$/.test(identity.targetUin)
    || !/^\d{5,16}$/.test(String(identity.sourceGroup)) || !/^u_[A-Za-z0-9_-]{5,128}$/.test(identity.targetUid)
    || !connection?.ok || String(connection.self?.user_id) !== identity.botUin
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.baseUrl) || !connection.token) throw Error('Invalid verified account/target/connection');
  const wrapper = fs.realpathSync(wrapperPath), app = path.dirname(wrapper);
  if (path.basename(wrapper) !== 'wrapper.node' || JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version !== QQ_VERSION
    || hash(fs.readFileSync(wrapper)) !== WRAPPER_SHA256 || hash(fs.readFileSync(path.join(app, 'major.node'))) !== MAJOR_SHA256) throw Error('Client pin mismatch');
  const request = { action: 'request', accountUin: identity.botUin, targetUin: identity.targetUin,
    idempotencyKey: 'maintenance-' + randomUUID(), dryRun: true, addFriendSetting: 1,
    answer: '主动加好友接口测试', remark: '', defaultCategory: 0, sourceId: 5, sourceSubId: 2,
    onlyChat: false, qzoneNotWatch: false, qzoneNotWatched: false };
  const pins = { enabled: true, mode: 'dry-run', expectedUin: identity.botUin, allowedTargetUins: [identity.targetUin],
    qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256, majorSha256: MAJOR_SHA256 };
  buildObservedAddBuddyEnvelope(request, pins);
  const dir = path.join(outputParent, 'qq-friend-validation-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  const pluginDir = path.join(dir, 'qq-bridge-friend-probe'), reportDir = path.join(dir, 'reports');
  // Share target reservations across all packages; preparing another package
  // must not silently permit a second attempt after an uncertain native result.
  const journalDir = path.join(outputParent, 'qq-friend-send-once-journal');
  fs.mkdirSync(outputParent, { recursive: true }); fs.mkdirSync(dir); fs.mkdirSync(pluginDir); fs.mkdirSync(reportDir);
  fs.mkdirSync(journalDir, { recursive: true });
  const names = ['probe.cjs', 'friend-binding.cjs', 'friend-adapter.cjs', 'friend-setting.cjs', 'friend-requests.cjs',
    'friend-runtime.cjs', 'friend-validation.cjs', 'request-observer.cjs', 'request-contract.cjs'];
  const files = {};
  for (const name of [...names, 'main.cjs']) {
    const bytes = fs.readFileSync(path.join(root, 'plugins', 'qq-friend-probe', name === 'main.cjs' ? (production ? 'production-main.cjs' : 'validation-main.cjs') : name));
    fs.writeFileSync(path.join(pluginDir, name), bytes, { flag: 'wx' }); files[name] = hash(bytes);
  }
  const config = { ...pins, mode: 'maintenance-send-once', wrapperPath: wrapper, reportDir, journalDir,
    targetUin: identity.targetUin, targetUid: identity.targetUid, sourceGroup: String(identity.sourceGroup),
    controlToken: randomBytes(32).toString('hex'), snowlumaHttpUrl: connection.baseUrl, snowlumaToken: connection.token, request };
  if (production) {
    if (!path.isAbsolute(snowlumaHome ?? '')) throw Error('Explicit SnowLuma home required');
    Object.assign(config, { mode: 'production', bridgeDir: root, snowlumaHome, journalDir: path.join(root, 'state', 'native-friend-operations') });
    for (const key of ['allowedTargetUins', 'targetUin', 'targetUid', 'sourceGroup', 'snowlumaHttpUrl', 'snowlumaToken', 'request']) delete config[key];
  }
  const bytes = Buffer.from(JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(path.join(pluginDir, 'config.json'), bytes, { flag: 'wx', mode: 0o600 }); files['config.json'] = hash(bytes);
  fs.writeFileSync(path.join(dir, 'preparation.json'), JSON.stringify({ kind: production ? 'production-native-friend' : 'maintenance-send-once', preparedAt: new Date().toISOString(),
    installed: false, runtimeVerified: false, qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256, files }, null, 2) + '\n', { flag: 'wx' });
  return { packageDir: dir, pluginDir, reportDir, installed: false, requestSent: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { wrapper: { type: 'string' }, identity: { type: 'string' }, production: { type: 'boolean' } } });
    if (!values.wrapper || !values.identity) throw Error('Use --wrapper <path> --identity <verified local JSON>');
    const identity = JSON.parse(fs.readFileSync(values.identity, 'utf8').replace(/^\uFEFF/, ''));
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const connection = await discoverSnowLumaConnection({ cfg, timeoutMs: 3000 });
    console.log(JSON.stringify(writeValidationPackage({ wrapperPath: values.wrapper, identity, connection, production: values.production, snowlumaHome: cfg.snowluma?.homeDir }), null, 2));
  } catch { console.error('Validation preparation failed; verify explicit paths, identity and account connection.'); process.exitCode = 1; }
}
