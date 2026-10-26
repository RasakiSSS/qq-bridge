import fs from 'node:fs';
import path from 'node:path';

export const RELATION_ACTIONS = Object.freeze({
  ACCEPT_REQUEST: 'accept_request',
  REJECT_REQUEST: 'reject_request',
  DELETE_FRIEND: 'delete_friend',
  LEAVE_GROUP: 'leave_group',
  REQUEST_FRIEND: 'request_friend',
});

const REQUEST_STATUSES = new Set(['pending', 'accepted', 'rejected', 'failed', 'unknown']);
const ACTION_STATUSES = new Set(['succeeded', 'failed', 'unknown']);
const MAX_ID_DIGITS = 16;
const MAX_FLAG_CHARS = 512;
const MAX_COMMENT_CHARS = 500;
const MAX_HISTORY = 500;
const MAX_PENDING = 200;

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return true;
  return Object.getPrototypeOf(proto) === null && proto?.constructor?.name === 'Object';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeText(value, max, sanitize) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  try { text = String(sanitize(text)); } catch {}
  return text.slice(0, max);
}

export function parseRelationshipId(value, field = 'id') {
  let text;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} 必须是正整数`);
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
    if (!/^\d+$/.test(text) || text.length === 0 || text.length > MAX_ID_DIGITS || /^0+$/.test(text)) {
      throw new Error(`${field} 必须是正十进制整数`);
    }
    const number = Number(text);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${field} 超出安全整数范围`);
    text = String(number);
  } else {
    throw new Error(`${field} 必须是正整数`);
  }
  return { text, number: Number(text) };
}

export function relationshipConfig(raw = {}) {
  const source = isPlainRecord(raw) ? raw : {};
  const actions = isPlainRecord(source.actions) ? source.actions : {};
  const maxPending = Number(source.maxPending);
  const maxHistory = Number(source.maxHistory);
  return Object.freeze({
    enabled: source.enabled === true,
    promptPendingRequests: source.promptPendingRequests !== false,
    maxPending: Number.isSafeInteger(maxPending) ? Math.min(MAX_PENDING, Math.max(20, maxPending)) : MAX_PENDING,
    maxHistory: Number.isSafeInteger(maxHistory) ? Math.min(MAX_HISTORY, Math.max(50, maxHistory)) : MAX_HISTORY,
    actions: Object.freeze({
      acceptRequests: actions.acceptRequests !== false,
      rejectRequests: actions.rejectRequests !== false,
      deleteFriends: actions.deleteFriends !== false,
      leaveGroups: actions.leaveGroups !== false,
      nativeFriendRequest: actions.nativeFriendRequest === true,
    }),
  });
}

export function relationshipToolFlag(action) {
  switch (action) {
    case 'list_requests':
    case RELATION_ACTIONS.ACCEPT_REQUEST:
    case RELATION_ACTIONS.REJECT_REQUEST:
    case RELATION_ACTIONS.DELETE_FRIEND:
    case RELATION_ACTIONS.LEAVE_GROUP:
    case RELATION_ACTIONS.REQUEST_FRIEND:
      return 'relationships';
    default:
      return null;
  }
}

export function normalizeFriendRequestEvent(event, { now = Date.now, sanitize = (value) => value } = {}) {
  if (!isPlainRecord(event)) throw new Error('好友申请事件必须是对象');
  if (String(event.post_type ?? '') !== 'request' || String(event.request_type ?? '') !== 'friend') {
    throw new Error('只接受 request_type=friend 的好友申请事件');
  }
  const flag = safeText(event.flag, MAX_FLAG_CHARS, sanitize);
  if (!flag) throw new Error('好友申请缺少 flag');
  const user = parseRelationshipId(event.user_id, 'user_id');
  const timestamp = Number(event.time);
  const receivedAt = Number.isFinite(timestamp) && timestamp > 0 ? Math.round(timestamp * 1000) : Number(now());
  return {
    id: `friend-request:${flag}`,
    type: 'friend_request',
    requestType: 'friend',
    flag,
    userId: user.text,
    subType: safeText(event.sub_type, 40, sanitize) || null,
    comment: safeText(event.comment, MAX_COMMENT_CHARS, sanitize),
    receivedAt,
    status: 'pending',
    updatedAt: Number(now()),
  };
}

export function normalizeRelationshipAction(action, input = {}) {
  if (!isPlainRecord(input)) throw new Error('关系操作参数必须是对象');
  const name = String(action ?? '').trim();
  if (name === RELATION_ACTIONS.REQUEST_FRIEND) {
    const user = parseRelationshipId(input.userId, 'userId'), group = parseRelationshipId(input.groupId, 'groupId');
    if (Object.keys(input).some(k => !['userId', 'groupId', 'answer', 'operationId'].includes(k))
      || typeof input.answer !== 'string' || input.answer.length > 500
      || typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.operationId)) throw new Error('主动申请参数无效');
    return { action: name, userId: user.text, groupId: group.text, answer: input.answer, operationId: input.operationId };
  }
  if (name === RELATION_ACTIONS.ACCEPT_REQUEST || name === RELATION_ACTIONS.REJECT_REQUEST) {
    const flag = typeof input.flag === 'string' ? input.flag.trim() : '';
    if (!flag || flag.length > MAX_FLAG_CHARS) throw new Error('好友申请 flag 无效');
    const unknown = Object.keys(input).filter((key) => !['flag', 'requestId', 'reason'].includes(key));
    if (unknown.length) throw new Error(`好友申请操作包含未知参数：${unknown.join(', ')}`);
    return { action: name, flag, requestId: typeof input.requestId === 'string' ? input.requestId.trim().slice(0, 200) : null,
      reason: safeText(input.reason, 200, (value) => value),
      onebotAction: 'set_friend_add_request', onebotParams: { flag, approve: name === RELATION_ACTIONS.ACCEPT_REQUEST } };
  }
  if (name === RELATION_ACTIONS.DELETE_FRIEND) {
    const user = parseRelationshipId(input.user_id ?? input.userId, 'user_id');
    if (input.block !== undefined && typeof input.block !== 'boolean') throw new Error('block 必须是布尔值');
    const unknown = Object.keys(input).filter((key) => !['user_id', 'userId', 'block', 'reason'].includes(key));
    if (unknown.length) throw new Error(`删除好友操作包含未知参数：${unknown.join(', ')}`);
    return { action: name, userId: user.text, reason: safeText(input.reason, 200, (value) => value),
      onebotAction: 'delete_friend', onebotParams: { user_id: user.number, block: input.block === true } };
  }
  if (name === RELATION_ACTIONS.LEAVE_GROUP) {
    const group = parseRelationshipId(input.group_id ?? input.groupId, 'group_id');
    const unknown = Object.keys(input).filter((key) => !['group_id', 'groupId', 'reason'].includes(key));
    if (unknown.length) throw new Error(`退群操作包含未知参数：${unknown.join(', ')}`);
    return { action: name, groupId: group.text, reason: safeText(input.reason, 200, (value) => value),
      onebotAction: 'set_group_leave', onebotParams: { group_id: group.number } };
  }
  throw new Error(`不支持的关系操作：${name || '空'}`);
}

export function relationshipActionResult(action, { ok = false, data = null, error = null, at = Date.now() } = {}) {
  const status = ok ? 'succeeded' : (error?.unknown === true ? 'unknown' : 'failed');
  const result = { action: String(action ?? ''), status, at: Number(at), data: null };
  if (isPlainRecord(data)) {
    const safe = {};
    for (const key of ['result', 'errMsg', 'message_id']) {
      if (typeof data[key] === 'string' || typeof data[key] === 'number' || typeof data[key] === 'boolean') safe[key] = data[key];
    }
    result.data = safe;
  }
  if (status !== 'succeeded' && error) result.error = String(error.message ?? error).slice(0, 500);
  return result;
}

function emptyState() {
  return { version: 1, pending: [], history: [] };
}

function validState(value) {
  return isPlainRecord(value) && value.version === 1 && Array.isArray(value.pending) && Array.isArray(value.history);
}

export function createRelationshipStore({ file, now = Date.now, sanitize = (value) => value, log = () => {}, maxPending = MAX_PENDING, maxHistory = MAX_HISTORY } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('关系状态文件路径不能为空');
  let state = null;
  let writable = true;
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      if (!validState(parsed)) throw new Error('关系状态文件结构无效');
      state = parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') state = emptyState();
      else {
        state = emptyState();
        writable = false;
        log(`⚠️ 关系状态读取失败，已降级为只读不写（不会覆盖原文件）：${error?.message ?? error}`);
      }
    }
  }

  function save() {
    ensureLoaded();
    if (!writable) throw new Error('关系状态处于只读降级状态，拒绝修改');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch {}
      writable = false;
      throw error;
    }
  }

  function snapshot() { ensureLoaded(); return clone(state); }

  function recordRequest(event) {
    ensureLoaded();
    const request = normalizeFriendRequestEvent(event, { now, sanitize });
    const index = state.pending.findIndex((item) => item.id === request.id);
    if (index >= 0) {
      const old = state.pending[index];
      if (old.status === 'pending') {
        state.pending[index] = { ...old, comment: request.comment, updatedAt: request.updatedAt };
        save();
      }
      return clone(state.pending[index]);
    }
    state.pending.unshift(request);
    state.pending = state.pending.slice(0, Math.max(20, Math.min(MAX_PENDING, Number(maxPending) || MAX_PENDING)));
    save();
    return clone(request);
  }

  function listPending(limit = 20) {
    ensureLoaded();
    const count = Math.max(1, Math.min(50, Number(limit) || 20));
    return clone(state.pending.filter((item) => item.status === 'pending').slice(0, count));
  }

  function findRequest(input) {
    ensureLoaded();
    const value = String(input ?? '').trim();
    return state.pending.find((item) => item.id === value || item.flag === value) ?? null;
  }

  function appendHistory(entry) {
    state.history.unshift({ ...entry, at: Number(entry.at) || Number(now()) });
    state.history = state.history.slice(0, Math.max(50, Math.min(MAX_HISTORY, Number(maxHistory) || MAX_HISTORY)));
  }

  function recordAction(entry) {
    ensureLoaded();
    if (!isPlainRecord(entry) || typeof entry.action !== 'string') throw new Error('关系操作记录无效');
    const result = relationshipActionResult(entry.action, entry);
    const requestId = typeof entry.requestId === 'string' ? entry.requestId : null;
    if (requestId) {
      const item = state.pending.find((candidate) => candidate.id === requestId || candidate.flag === requestId);
      if (item && (entry.action === RELATION_ACTIONS.ACCEPT_REQUEST || entry.action === RELATION_ACTIONS.REJECT_REQUEST)) {
        item.status = result.status === 'succeeded'
          ? (entry.action === RELATION_ACTIONS.ACCEPT_REQUEST ? 'accepted' : 'rejected')
          : result.status;
        item.updatedAt = result.at;
      }
    }
    appendHistory({
      type: 'relationship_action', action: result.action, status: result.status,
      target: entry.target ?? null, requestId, reason: safeText(entry.reason, 200, sanitize),
      error: result.error ?? null,
    });
    save();
    return result;
  }

  function status() {
    ensureLoaded();
    return { writable, pending: state.pending.filter((item) => item.status === 'pending').length,
      history: state.history.length, recent: clone(state.history.slice(0, 20)) };
  }

  return Object.freeze({
    listPending,
    recordAction,
    recordRequest,
    findRequest: (value) => clone(findRequest(value)),
    snapshot,
    status,
    isWritable: () => { ensureLoaded(); return writable; },
  });
}
