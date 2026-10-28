import { randomUUID } from 'node:crypto';
import { fail, json } from './store.js';

// No timers, network clients or production side effects at import time. The
// adapter supplies ensureSession and prompt, and calls tick on eligible events.
export class UnifiedScheduler {
  constructor({ store, scenes, ensureSession, prompt, isWakeAllowed = () => true, now = Date.now }) {
    this.store = store; this.scenes = scenes; this.ensureSession = ensureSession;
    this.prompt = prompt; this.now = now; this.isWakeAllowed = isWakeAllowed;
  }
  claim(ctx) {
    return this.store.transaction(() => {
      if (this.store.active(ctx.account)) return null;
      const state = this.scenes.active(ctx);
      if (this.now() < state.retry_at) return null;
      // Select only eligible sources. Do not reserve hidden peak-time events.
      const rows = this.store.db.prepare('SELECT * FROM events WHERE account=? AND unread=1 AND wake=1 AND notified=0 ORDER BY seq')
        .iterate(ctx.account);
      const events = [];
      for (const row of rows) {
        if (this.scenes.visible(row.scene, ctx) && this.isWakeAllowed(row, ctx) === true) events.push(row);
        if (events.length === 30) break;
      }
      if (!events.length) return null;
      const sessionId = state.session_id || `session-${randomUUID()}`;
      this.store.db.prepare('UPDATE accounts SET session_id=? WHERE account=?').run(sessionId, ctx.account);
      const id = randomUUID();
      this.store.db.prepare("INSERT INTO dispatches(id,account,session_id,status,created) VALUES(?,?,?,'preparing',?)")
        .run(id, ctx.account, sessionId, this.now());
      const insert = this.store.db.prepare('INSERT INTO dispatch_events(dispatch,seq) VALUES(?,?)');
      for (const event of events) insert.run(id, event.seq);
      return this.store.dispatch(id);
    });
  }
  valid(row, original) {
    const ctx = this.scenes.context();
    if (ctx.account !== row.account || ctx.ownerQQ !== original.ownerQQ
        || ctx.identityEpoch !== original.identityEpoch) throw fail('IDENTITY_CHANGED');
    this.scenes.active(ctx);
    const events = this.store.dispatchEvents(row.id);
    for (const event of events) {
      this.scenes.requireVisible(event.scene, ctx);
      if (!event.unread || !event.wake || event.notified || this.isWakeAllowed(event, ctx) !== true) throw fail('STALE_WAKE');
    }
    return events;
  }
  async tick() {
    const ctx = this.scenes.context();
    try { this.scenes.active(ctx); } catch (error) {
      if (error.code === 'PAUSED') return { status: 'paused' };
      throw error;
    }
    const row = this.claim(ctx);
    if (!row) return { status: this.store.active(ctx.account)?.status || 'idle' };
    let attempted = false;
    try {
      // Stable creation identity is written before this asynchronous call. The
      // adapter validates actual preset/account/workspace before returning it.
      const actual = await this.ensureSession({ account: row.account, sessionId: row.session_id });
      if (actual !== row.session_id) throw fail('SESSION_ID_MISMATCH');
      const events = this.valid(row, ctx);
      const content = this.store.transaction(() => {
        // Only bounded previews go into the model request; full data remains
        // queryable in the inbox. A preview does not authorize acknowledging the
        // unshown tail: the adapter/prompt must direct the model to fetch it.
        const messages = events.map((event) => {
          const payload = JSON.parse(event.payload);
          const raw = typeof payload?.text === 'string' ? payload.text : '';
          return { seq: event.seq, key: event.scene, kind: event.kind,
            text: raw.slice(0, 400), partial: raw.length > 400 || Object.keys(payload || {}).some((key) => key !== 'text') };
        });
        // Byte budget, including JSON escaping and multibyte text. Shrink only
        // previews, never the durable event or its unread state. Leave room for
        // at most 30 receipt handles and the outer prompt envelope.
        while (Buffer.byteLength(JSON.stringify(messages)) > 22000) {
          const longest = messages.reduce((a, b) => a.text.length > b.text.length ? a : b);
          if (!longest.text.length) throw fail('INPUT_TOO_LARGE');
          longest.text = longest.text.slice(0, Math.floor(longest.text.length / 2));
          longest.partial = true;
        }
        const scopes = new Map();
        for (let i = 0; i < events.length; i++) {
          if (messages[i].partial) continue;
          const event = events[i], list = scopes.get(event.scene) || [];
          list.push(event); scopes.set(event.scene, list);
        }
        const receipts = [...scopes].map(([key, batch]) => ({ key,
          receipt: this.store.receipt(row.account, key, 'read', batch, this.now()) }));
        const input = [{ type: 'text', text: json({ requestId: row.id, messages, receipts }, 32768) }];
        this.store.db.prepare("UPDATE dispatches SET status='dispatching',content=? WHERE id=? AND status='preparing'")
          .run(json(input, 40000), row.id);
        return input;
      });
      // No asynchronous work between the last admission check and prompt call.
      this.valid(row, ctx);
      let response;
      try {
        attempted = true;
        response = await this.prompt({ sessionId: row.session_id, requestId: row.id, mode: 'queue', content });
      } catch {
        this.store.db.prepare("UPDATE dispatches SET status='unknown' WHERE id=? AND status='dispatching'").run(row.id);
        return { status: this.store.dispatch(row.id).status, requestId: row.id };
      }
      if (response?.result?.ok === true && response.result.value?.accepted === true) {
        this.store.confirm(row.id, row.session_id, 'accepted');
      } else if (response?.result?.ok === false) {
        this.store.db.prepare("UPDATE dispatches SET status='rejected' WHERE id=? AND status='dispatching'").run(row.id);
        if (this.store.dispatch(row.id).status === 'rejected') this.backoff(row.account);
      } else {
        this.store.db.prepare("UPDATE dispatches SET status='unknown' WHERE id=? AND status='dispatching'").run(row.id);
      }
      return { status: this.store.dispatch(row.id).status, requestId: row.id };
    } catch (error) {
      // Even a local receipt/persistence error AFTER submission is uncertainty,
      // never permission to replay. A dispatching row blocks work after restart.
      this.store.db.prepare("UPDATE dispatches SET status=? WHERE id=? AND status IN ('preparing','dispatching')")
        .run(attempted ? 'unknown' : 'deferred', row.id);
      if (!attempted && !['PAUSED', 'PEAK_SCENE_ENTRY_BLOCKED', 'IDENTITY_CHANGED', 'SCENE_DENIED', 'STALE_WAKE'].includes(error.code)) this.backoff(row.account);
      return { status: this.store.dispatch(row.id).status, requestId: row.id, error: error.code || 'PREFLIGHT_FAILED' };
    }
  }
  // Host recovery must supply evidence tied to BOTH requestId and sessionId.
  // A generic terminal event without that correlation cannot unlock this row.
  confirm({ requestId, sessionId, outcome }) { return this.store.confirm(requestId, sessionId, outcome); }
  backoff(account) {
    const failures = this.store.account(account).failures + 1;
    const retryAt = this.now() + Math.min(3600000, 60000 * 2 ** Math.min(failures - 1, 6));
    this.store.db.prepare('UPDATE accounts SET failures=?,retry_at=? WHERE account=?').run(failures, retryAt, account);
  }
  recoverPreparing(account) {
    // Only for exclusive startup, after the old process is known stopped. This
    // method is not a lease-stealing timeout. "dispatching" remains uncertain.
    return this.store.db.prepare("UPDATE dispatches SET status='deferred' WHERE account=? AND status='preparing'").run(account).changes;
  }
}
