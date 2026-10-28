import { createHash } from 'node:crypto';
import { fail, json } from './store.js';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;

// Internal action dispatcher. callId MUST be the stable DSH tool invocation ID
// supplied by the trusted transport, not a fresh random ID on every HTTP retry.
// Handlers retain the existing ACL, tool switches, path checks, audit and quota.
// prepare is side-effect-free; dispatch is the only external write boundary.
export class UnifiedActions {
  constructor({ store, scenes, handlers, now = Date.now }) {
    this.store = store; this.scenes = scenes; this.handlers = handlers; this.now = now;
  }
  async run({ callId, operation, capability, payload }) {
    if (typeof callId !== 'string' || !callId || callId.length > 256) throw fail('INVALID_CALL_ID');
    if (!Object.hasOwn(this.handlers, operation)) throw fail('ACTION_DENIED');
    const handler = this.handlers[operation];
    if (!['scene', 'global'].includes(handler.scope) || !['v1', 'v2', 'v3'].includes(handler.level)
      || typeof handler.prepare !== 'function' || typeof handler.dispatch !== 'function') throw fail('INVALID_ACTION_HANDLER');
    // Detach input before any await. The canonical form catches retry conflicts
    // but treats JSON object property order as irrelevant.
    const input = JSON.parse(json(payload));
    const context = this.scenes.context();
    const authorize = () => {
      const ctx = this.scenes.context();
      const state = this.scenes.active(ctx, handler.level);
      if (ctx.account !== context.account || ctx.ownerQQ !== context.ownerQQ || ctx.identityEpoch !== context.identityEpoch) throw fail('IDENTITY_CHANGED');
      if (!state.session_id) throw fail('MAIN_SESSION_NOT_BOUND');
      const target = handler.scope === 'scene' ? this.scenes.authorize(capability, handler.level).key : null;
      return { account: ctx.account, sessionId: state.session_id, target };
    };
    const scope = authorize();
    const assertCurrent = () => {
      const current = authorize();
      if (current.sessionId !== scope.sessionId || current.target !== scope.target) throw fail('IDENTITY_CHANGED');
    };
    const args = [scope.account, scope.sessionId, callId];
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ operation, target: scope.target, input }))).digest('hex');
    const read = () => this.store.db.prepare('SELECT * FROM actions WHERE account=? AND session_id=? AND call_id=?').get(...args);
    const output = row => ({ status: row.status, ...(row.result ? { result: JSON.parse(row.result) } : {}) });
    const claim = this.store.transaction(() => {
      const row = read();
      if (row) {
        if (row.fingerprint !== fingerprint) throw fail('ACTION_ID_CONFLICT');
        if (row.status !== 'deferred') return false;
        this.store.db.prepare("UPDATE actions SET status='preparing',result=NULL WHERE account=? AND session_id=? AND call_id=?").run(...args);
      } else {
        this.store.db.prepare("INSERT INTO actions(account,session_id,call_id,operation,target,fingerprint,status,created) VALUES(?,?,?,?,?,?,'preparing',?)")
          .run(...args, operation, scope.target, fingerprint, this.now());
      }
      return true;
    });
    if (!claim) return output(read());
    let attempted = false;
    try {
      const prepared = await handler.prepare({ ...scope, payload: input });
      assertCurrent();
      // Host validation/audit belongs in prepare; handlers must additionally
      // recheck asynchronous policies at their own final write boundary.
      const updated = this.store.db.prepare("UPDATE actions SET status='dispatching' WHERE account=? AND session_id=? AND call_id=? AND status='preparing'").run(...args);
      if (updated.changes !== 1) throw fail('STALE_ACTION');
      attempted = true;
      const response = await handler.dispatch({ ...scope, payload: prepared, callId, assertCurrent });
      // Only an explicit, trusted adapter receipt proves success or rejection.
      if (response?.status === 'succeeded' || response?.status === 'rejected') {
        const result = json(response.result ?? null, 32768);
        this.store.db.prepare('UPDATE actions SET status=?,result=? WHERE account=? AND session_id=? AND call_id=?')
          .run(response.status, result, ...args);
      } else {
        this.store.db.prepare("UPDATE actions SET status='unknown' WHERE account=? AND session_id=? AND call_id=?").run(...args);
      }
      return output(read());
    } catch (error) {
      // If persistence itself fails, dispatching still blocks replay on restart.
      this.store.db.prepare("UPDATE actions SET status=? WHERE account=? AND session_id=? AND call_id=? AND status IN ('preparing','dispatching')")
        .run(attempted ? 'unknown' : 'deferred', ...args);
      if (!attempted) throw error;
      return output(read());
    }
  }
  recoverPreparing(account) {
    // Exclusive startup only, after the previous owner has been stopped.
    return this.store.db.prepare("UPDATE actions SET status='deferred' WHERE account=? AND status='preparing'").run(account).changes;
  }
}
