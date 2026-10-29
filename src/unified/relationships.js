import { createHash, randomBytes } from 'node:crypto';
import { normalizeFriendRequestEvent, normalizeRelationshipAction, RELATION_ACTIONS } from '../relationship-control.js';
import { fail, json } from './store.js';

const requestActions = new Set([RELATION_ACTIONS.ACCEPT_REQUEST, RELATION_ACTIONS.REJECT_REQUEST]);
const hash = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const nativeFields = x => [x.key, x.userId, x.groupId, x.answer, x.operationId];

// A short-lived grant authorizes only a concrete native invocation. It never
// exposes the main MCP bearer or impersonates an old per-chat session.
export class UnifiedNativeGrants {
  #grants = new Map();
  constructor(now = Date.now) { this.now = now; }
  issue(input, check) {
    check(); const token = randomBytes(32).toString('hex');
    this.#grants.set(hash(token), { fingerprint: hash(nativeFields(input)), check, expires: this.now() + 120000 });
    return { token, revoke: () => this.#grants.delete(hash(token)) };
  }
  authorize(input, token) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
    const key = hash(token), grant = this.#grants.get(key);
    if (!grant) return false;
    if (this.now() >= grant.expires) { this.#grants.delete(key); return false; }
    if (hash(nativeFields(input)) !== grant.fingerprint) return false;
    try { grant.check(); return true; } catch { return false; }
  }
}

export class UnifiedRelationships {
  constructor({ scenes, policy, request, nativeRequest, now = Date.now }) {
    this.scenes = scenes; this.store = scenes.store; this.policy = policy;
    this.request = request; this.nativeRequest = nativeRequest; this.now = now;
  }
  ingest(event) {
    const ctx = this.scenes.context();
    if (String(event?.self_id) !== ctx.account) throw fail('IDENTITY_CHANGED');
    const normalized = normalizeFriendRequestEvent(event, { now: this.now });
    const id = hash([ctx.account, normalized.flag]);
    this.store.account(ctx.account);
    this.store.db.prepare(`INSERT OR IGNORE INTO friend_requests(account,id,payload,status,created) VALUES(?,?,?,'pending',?)`)
      .run(ctx.account, id, json(normalized, 8192), this.now());
    return { id, status: this.store.db.prepare('SELECT status FROM friend_requests WHERE account=? AND id=?').get(ctx.account, id).status };
  }
  list(limit = 30) {
    const ctx = this.scenes.context(); this.scenes.active(ctx, 'v2'); this.policy(null);
    const rows = this.store.db.prepare("SELECT * FROM friend_requests WHERE account=? AND status='pending' ORDER BY created,id LIMIT ?").all(ctx.account, limit);
    // Raw gateway flags stay host-side; the model only gets opaque references.
    return { requests: rows.map(row => {
      const value = JSON.parse(row.payload);
      return { id: row.id, userId: value.userId, comment: value.comment, receivedAt: value.receivedAt };
    }), total: this.store.db.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE account=? AND status='pending'").get(ctx.account).n };
  }
  handler(action) {
    if (!Object.values(RELATION_ACTIONS).includes(action)) throw fail('ACTION_DENIED');
    return {
      scope: 'global', level: 'v2',
      prepare: ({ account, payload }) => {
        this.policy(action);
        if (requestActions.has(action)) {
          const row = this.store.db.prepare('SELECT * FROM friend_requests WHERE account=? AND id=?').get(account, payload.requestId);
          if (!row || row.status !== 'pending') throw fail('REQUEST_UNAVAILABLE');
          const request = JSON.parse(row.payload);
          const normalized = normalizeRelationshipAction(action, { flag: request.flag, reason: payload.reason });
          return { ...normalized, requestId: row.id };
        }
        // Native operation identity is assigned below, never chosen by a model.
        return normalizeRelationshipAction(action, action === RELATION_ACTIONS.REQUEST_FRIEND
          ? { ...payload, operationId: 'placeholder' } : payload);
      },
      dispatch: async ({ account, sessionId, callId, payload, assertCurrent }) => {
        const check = () => { assertCurrent(); this.policy(action); };
        check();
        // Verify the gateway's live account after async I/O and before writing.
        const login = await this.request('get_login_info', {});
        check();
        if (login?.status !== 'ok' || login.retcode !== 0 || String(login.data?.user_id) !== account) throw fail('IDENTITY_CHANGED');
        if (requestActions.has(action)) {
          const claimed = this.store.db.prepare("UPDATE friend_requests SET status='unknown' WHERE account=? AND id=? AND status='pending'").run(account, payload.requestId);
          if (claimed.changes !== 1) return { status: 'rejected', result: { code: 'REQUEST_UNAVAILABLE' } };
        }
        let outcome;
        if (action === RELATION_ACTIONS.REQUEST_FRIEND) {
          if (!this.nativeRequest) throw fail('ACTION_DENIED');
          const { userId, groupId, answer } = payload;
          const result = await this.nativeRequest({ account, input: { userId, groupId, answer,
            operationId: hash([account, sessionId, callId]) }, assertCurrent: check });
          outcome = result?.status === 'succeeded' ? 'succeeded' : result?.status === 'failed' ? 'rejected' : 'unknown';
        } else {
          check();
          const result = await this.request(payload.onebotAction, payload.onebotParams);
          outcome = result?.status === 'ok' && result.retcode === 0 ? 'succeeded' : 'unknown';
        }
        if (requestActions.has(action)) this.store.db.prepare('UPDATE friend_requests SET status=? WHERE account=? AND id=?')
          .run(outcome === 'succeeded' ? action === RELATION_ACTIONS.ACCEPT_REQUEST ? 'accepted' : 'rejected' : 'unknown', account, payload.requestId);
        return { status: outcome, result: { action, target: payload.userId || payload.groupId || null,
          ...(action === RELATION_ACTIONS.REQUEST_FRIEND ? { friendshipEstablished: false } : {}) } };
      },
    };
  }
}
