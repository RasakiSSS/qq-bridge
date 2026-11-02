// Offline inspection only: never loads wrapper.node, attaches to QQ, or sends a request.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export function inspectWrapperBytes(bytes) {
  const text = bytes.toString('latin1');
  const assertions = [...text.matchAll(
    /assertion \(argc == (\d+)\) failed: NodeIKernelBuddyService::reqToAddFriends needs \d+ arguments/g,
  )];
  return {
    getBuddyServiceMarker: text.includes('NodeIQQNTWrapperSession::getBuddyService'),
    reqToAddFriendsMarker: text.includes('NodeIKernelBuddyService::reqToAddFriends'),
    argumentCountsInAssertions: [...new Set(assertions.map((m) => Number(m[1])))],
    argumentAssertions: [...new Set(assertions.map((m) => m[0]))],
    cppReqToFriendMarker: /reqToAddFriends@KernelBuddyService@wrapper@nt[^\0]{0,200}ReqToFriend/.test(text),
  };
}

export function inspectWrapper(wrapperPath) {
  const resolved = path.resolve(wrapperPath);
  const size = fs.statSync(resolved).size;
  if (size > 512 * 1024 * 1024) throw new Error('Refusing to read a wrapper larger than 512 MiB');
  const bytes = fs.readFileSync(resolved);
  let packageVersion = null;
  try {
    packageVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(resolved), 'package.json'), 'utf8')).version ?? null;
  } catch { /* An independently copied wrapper may not have adjacent metadata. */ }
  return {
    path: resolved,
    packageVersion,
    bytes: size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...inspectWrapperBytes(bytes),
  };
}

export function inspectSnowLuma(homeDir) {
  const bundlePath = path.join(path.resolve(homeDir), 'index.mjs');
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  return {
    bundlePath,
    sha256: createHash('sha256').update(bundle).digest('hex'),
    markers: Object.fromEntries([
      'QqHookClient', 'sendRawPacket', 'getBuddyService', 'reqToAddFriends',
    ].map((name) => [name, bundle.includes(name)])),
  };
}

function main() {
  const { values } = parseArgs({ options: {
    wrapper: { type: 'string' },
    'snowluma-home': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !values.wrapper) {
    console.log('Usage: node scripts/probe-qq-friend-add.mjs --wrapper "<QQ app>/wrapper.node" [--snowluma-home "<SnowLuma>"]');
    console.log('Offline binary markers only. They do not prove runtime access or successful friend requests.');
    if (!values.help) process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({
    kind: 'offline-static-evidence',
    runtimeSessionAccessVerified: false,
    requestSchemaVerified: false,
    requestSent: false,
    wrapper: inspectWrapper(values.wrapper),
    ...(values['snowluma-home'] ? { snowLuma: inspectSnowLuma(values['snowluma-home']) } : {}),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(`Probe failed: ${error.message}`);
    process.exitCode = 1;
  }
}
