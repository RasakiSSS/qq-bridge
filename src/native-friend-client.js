import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function resolveNativeFriendUid({ homeDir, accountUin, userId, groupId }) {
  for (const value of [accountUin, userId, groupId]) if (!/^[1-9]\d{4,15}$/.test(String(value))) throw new Error('身份参数无效');
  const file = path.join(homeDir, 'data', String(accountUin), 'snowluma_identity.db');
  if (!fs.existsSync(file)) throw new Error('SnowLuma 身份库不存在');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT uid FROM users WHERE uin = ? UNION SELECT uid FROM group_members WHERE group_id = ? AND uin = ? AND active = 1').all(Number(userId), Number(groupId), Number(userId));
    const uids = [...new Set(rows.map(x => x.uid).filter(Boolean))];
    if (uids.length !== 1 || !/^u_[A-Za-z0-9_-]{5,128}$/.test(uids[0])) throw new Error('目标 UID 缺失或存在冲突');
    return uids[0];
  } finally { db.close(); }
}

export async function nativeFriendRequest({ configFile, input, key, agentToken, assertAllowed, fetchImpl = fetch }) {
  assertAllowed();
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const endpoint = JSON.parse(fs.readFileSync(path.join(config.reportDir, 'service.json'), 'utf8'));
  if (config.mode !== 'production' || config.enabled !== true || !endpoint.active
    || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
    || !/^[a-f0-9]{64}$/.test(config.controlToken ?? '')) throw new Error('主动好友服务尚未就绪');
  const targetUid = resolveNativeFriendUid({ homeDir: config.snowlumaHome, accountUin: config.expectedUin, userId: input.userId, groupId: input.groupId });
  assertAllowed();
  const response = await fetchImpl(`http://127.0.0.1:${endpoint.port}/request`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-native-friend-token': config.controlToken },
    body: JSON.stringify({ ...input, targetUid, key, agentToken }), redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`主动好友服务拒绝调用（${response.status}）`);
  const result = await response.json();
  const successful = result.status === 'native_returned' && result.outcome?.result === 0
    && result.outcome?.responseResult === 0 && result.outcome?.errorCode === 0;
  return { action: 'request_friend', status: successful ? 'succeeded' : result.nativeInvoked ? 'unknown' : 'failed',
    data: { submitted: successful, friendshipEstablished: false, code: result.code } };
}
