import { randomUUID } from 'node:crypto';
import { isPeakAt, resolvePriceTable } from '../model-prices.js';
import { accountId, sceneKey, fail, json } from './store.js';

const levels = { v1: 1, v2: 2, v3: 3 };
const batchSize = (value = 30) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw fail('INVALID_BATCH_SIZE');
  return value;
};

// All context callbacks and prepare hooks are HOST supplied. These methods are
// not an HTTP/MCP authentication boundary; adapters must authenticate the caller.
export class UnifiedScenes {
  constructor({ store, getContext, isAllowed, now = Date.now, prepare = async () => {} }) {
    this.store = store; this.getContext = getContext; this.isAllowed = isAllowed;
    this.now = now; this.prepare = prepare; this.tail = Promise.resolve(); this.caps = new Map();
  }
  context() {
    const ctx = this.getContext(); accountId(ctx.account);
    if (ctx.ownerQQ != null) accountId(ctx.ownerQQ);
    const identity = JSON.stringify([ctx.account, ctx.ownerQQ ?? null, ctx.identityEpoch ?? 0]);
    if (this.identity !== undefined && this.identity !== identity) this.caps.clear();
    this.identity = identity;
    return { ...ctx, ownerQQ: ctx.ownerQQ ?? null, identityEpoch: ctx.identityEpoch ?? 0 };
  }
  state(ctx = this.context()) {
    const row = this.store.account(ctx.account);
    if (row.current_scene && !this.allowed(row.current_scene, ctx)) {
      this.store.db.prepare('UPDATE accounts SET current_scene=NULL,generation=generation+1 WHERE account=?').run(ctx.account);
      return this.store.account(ctx.account);
    }
    return row;
  }
  allowed(key, ctx) { sceneKey(key); return this.isAllowed(key, ctx) === true; }
  peak(ctx = this.context()) {
    const time = this.now();
    if (!Number.isFinite(time)) throw fail('INVALID_CLOCK');
    return ctx.peakEnabled === true && isPeakAt(time, resolvePriceTable(ctx.priceTable));
  }
  active(ctx = this.context(), required = 'v1') {
    const row = this.state(ctx);
    if (ctx.enabled === false || ctx.paused === true || row.paused) throw fail('PAUSED', '统一活动已暂停');
    if (!Object.hasOwn(levels, required) || levels[row.permission] < levels[required]) throw fail('PERMISSION_DENIED');
    return row;
  }
  visible(key, ctx = this.context()) {
    if (!this.allowed(key, ctx)) return false;
    return !this.peak(ctx) || key === this.state(ctx).current_scene || key === `private:${ctx.ownerQQ}`;
  }
  requireVisible(key, ctx = this.context()) {
    this.active(ctx);
    if (!this.allowed(key, ctx)) throw fail('SCENE_DENIED');
    if (!this.visible(key, ctx)) throw fail('PEAK_SCENE_ENTRY_BLOCKED', '当前处于峰期，可自主休眠；管理员私聊仍可唤醒');
  }
  serial(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  issue(ctx, row) {
    if (!row.current_scene) return null;
    for (const [id, cap] of this.caps) if (cap.account === ctx.account && cap.ownerQQ === ctx.ownerQQ
      && cap.key === row.current_scene && cap.generation === row.generation) {
      return { key: cap.key, capability: id, generation: cap.generation };
    }
    const id = randomUUID();
    // Only the latest issued credential is needed for this scene generation.
    for (const [token, value] of this.caps) if (value.account === ctx.account) this.caps.delete(token);
    this.caps.set(id, { account: ctx.account, ownerQQ: ctx.ownerQQ, key: row.current_scene, generation: row.generation });
    return { key: row.current_scene, capability: id, generation: row.generation };
  }
  current() { const ctx = this.context(); return this.issue(ctx, this.active(ctx)); }
  async join(key, checkCaller = () => {}) {
    checkCaller();
    sceneKey(key);
    const requested = this.context();
    return this.serial(async () => {
      const before = this.context();
      if (before.account !== requested.account || before.ownerQQ !== requested.ownerQQ || before.identityEpoch !== requested.identityEpoch) throw fail('IDENTITY_CHANGED');
      this.requireVisible(key, before);
      await this.prepare(key, before);
      checkCaller();
      const ctx = this.context();
      if (ctx.account !== before.account || ctx.ownerQQ !== before.ownerQQ || ctx.identityEpoch !== before.identityEpoch) throw fail('IDENTITY_CHANGED');
      this.requireVisible(key, ctx);
      const row = this.store.transaction(() => {
        this.store.scene(ctx.account, key);
        this.store.db.prepare('UPDATE accounts SET current_scene=?,generation=generation+1 WHERE account=? AND (current_scene IS NULL OR current_scene<>?)')
          .run(key, ctx.account, key);
        return this.store.account(ctx.account);
      });
      return this.issue(ctx, row);
    });
  }
  quit(checkCaller = () => {}) {
    checkCaller();
    const requested = this.context();
    return this.serial(() => {
      checkCaller();
      const ctx = this.context();
      if (ctx.account !== requested.account || ctx.ownerQQ !== requested.ownerQQ || ctx.identityEpoch !== requested.identityEpoch) throw fail('IDENTITY_CHANGED');
      this.active(ctx);
      this.store.db.prepare('UPDATE accounts SET current_scene=NULL,generation=generation+1 WHERE account=?').run(ctx.account);
      for (const [id, cap] of this.caps) if (cap.account === ctx.account) this.caps.delete(id);
      return this.menu();
    });
  }
  authorize(capability, required = 'v1') {
    const ctx = this.context(), row = this.active(ctx, required), cap = this.caps.get(capability);
    if (!cap || cap.account !== ctx.account || cap.ownerQQ !== ctx.ownerQQ
        || cap.key !== row.current_scene || cap.generation !== row.generation) throw fail('STALE_SCENE');
    if (!this.allowed(cap.key, ctx)) throw fail('SCENE_DENIED');
    return { ...cap };
  }
  // Recheck each externally dispatched piece. Already issued pieces retain their
  // original target; changing scene during await revokes the remaining pieces.
  // This is a permission helper, not the action outbox: dispatch MUST journal
  // intent/unknown results and deduplicate a stable tool-call id before use live.
  async send(capability, messages, dispatch) {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100) throw fail('INVALID_MESSAGES');
    const results = [];
    for (const message of messages) {
      let attempted = false;
      try {
        const cap = this.authorize(capability);
        attempted = true;
        const value = await dispatch({ account: cap.account, key: cap.key, message });
        results.push({ key: cap.key, value });
      } catch (error) { return { results, stopped: true, uncertain: attempted, error: error.code || 'ACTION_FAILED' }; }
    }
    return { results, stopped: false };
  }
  // Trusted management callers only: ingress authentication is implemented by
  // the later bridge adapter, never by a model-supplied "owner" field.
  setPermission(permission) {
    if (!Object.hasOwn(levels, permission)) throw fail('INVALID_PERMISSION');
    const ctx = this.context(); this.store.account(ctx.account);
    this.store.db.prepare('UPDATE accounts SET permission=? WHERE account=?').run(permission, ctx.account);
  }
  setPaused(paused) {
    if (typeof paused !== 'boolean') throw fail('INVALID_PAUSE');
    const ctx = this.context(); this.store.account(ctx.account);
    this.store.db.prepare('UPDATE accounts SET paused=? WHERE account=?').run(Number(paused), ctx.account);
  }
  preferences(key, value) {
    const ctx = this.context(); this.requireVisible(key, ctx);
    this.store.scene(ctx.account, key);
    if (value !== undefined) this.store.db.prepare('UPDATE scenes SET preferences=? WHERE account=? AND scene=?').run(json(value, 8192), ctx.account, key);
    return JSON.parse(this.store.db.prepare('SELECT preferences FROM scenes WHERE account=? AND scene=?').get(ctx.account, key).preferences);
  }
  menu({ after = '', limit = 50 } = {}) {
    const ctx = this.context(); this.active(ctx); batchSize(limit);
    const rows = this.store.counts(ctx.account).filter((x) => x.scene > after && this.visible(x.scene, ctx));
    return this.store.transaction(() => ({
      sessions: rows.slice(0, limit).map((row) => ({ key: row.scene, unread: row.unread,
        skipReceipt: this.store.receipt(ctx.account, row.scene, 'skip', null, this.now()) })),
      hasMore: rows.length > limit,
    }));
  }
  read(capability, limit = 30) {
    const cap = this.authorize(capability); batchSize(limit);
    return this.store.transaction(() => {
      const events = this.store.unread(cap.account, cap.key, limit);
      return { key: cap.key, messages: events.map((e) => ({ seq: e.seq, payload: JSON.parse(e.payload) })),
        remaining: this.store.counts(cap.account).find((x) => x.scene === cap.key).unread - events.length,
        receipt: this.store.receipt(cap.account, cap.key, 'read', events, this.now()) };
    });
  }
  summary(key, limit = 30) {
    const ctx = this.context(); this.requireVisible(key, ctx); batchSize(limit);
    return this.store.transaction(() => {
      const events = this.store.unread(ctx.account, key, limit);
      this.store.scene(ctx.account, key);
      return { key, messages: events.map((e) => ({ seq: e.seq, payload: JSON.parse(e.payload) })),
        remaining: this.store.counts(ctx.account).find((x) => x.scene === key).unread - events.length,
        job: this.store.receipt(ctx.account, key, 'summary', events, this.now(), 'pending') };
    });
  }
  // Worker-only: job id is internal; the host adapter must verify worker ownership.
  saveSummary(job, { result, coveredSeqs }) {
    const body = json(result, 24000);
    if (!Array.isArray(coveredSeqs) || coveredSeqs.length > 100
        || coveredSeqs.some((seq) => !Number.isSafeInteger(seq) || seq <= 0)
        || new Set(coveredSeqs).size !== coveredSeqs.length) throw fail('INVALID_SUMMARY_RANGE');
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT id FROM receipts WHERE id=? AND kind='summary' AND status='pending'").get(job);
      if (!row) return false;
      const cover = this.store.db.prepare('UPDATE receipt_events SET covered=1 WHERE receipt=? AND seq=?');
      for (const seq of coveredSeqs) if (cover.run(job, seq).changes !== 1) throw fail('INVALID_SUMMARY_RANGE');
      this.store.db.prepare("UPDATE receipts SET result=?,status='ready' WHERE id=?").run(body, job);
      return true;
    });
  }
  takeSummary(job) {
    const ctx = this.context();
    const row = this.store.db.prepare("SELECT * FROM receipts WHERE id=? AND account=? AND kind='summary'").get(job, ctx.account);
    if (!row) throw fail('INVALID_RECEIPT');
    this.requireVisible(row.scene, ctx);
    if (!['ready', 'delivered'].includes(row.status)) throw fail('SUMMARY_NOT_READY');
    this.store.db.prepare("UPDATE receipts SET status='delivered' WHERE id=?").run(job);
    return { receipt: job, key: row.scene, result: JSON.parse(row.result) };
  }
  markRead(id) {
    const ctx = this.context();
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM receipts WHERE id=? AND account=?').get(id, ctx.account);
      if (!row) throw fail('INVALID_RECEIPT');
      this.requireVisible(row.scene, ctx);
      if (row.status === 'acked') return { marked: 0 };
      if (row.status !== 'delivered') throw fail('RECEIPT_NOT_DELIVERED');
      const marked = this.store.db.prepare('UPDATE events SET unread=0 WHERE account=? AND scene=? AND unread=1 AND seq IN (SELECT seq FROM receipt_events WHERE receipt=? AND covered=1)')
        .run(ctx.account, row.scene, id).changes;
      this.store.db.prepare("UPDATE receipts SET status='acked' WHERE id=?").run(id);
      return { marked, reason: row.kind === 'skip' ? 'intentional-skip' : row.kind };
    });
  }
}
