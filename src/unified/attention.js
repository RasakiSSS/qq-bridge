import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { fail, json } from './store.js';

export const MAX_QUIET_MS = 12000;

// Waiting never owns model execution indefinitely, acknowledges messages, or
// quits a scene. The normal scheduler remains the only prompt writer.
export class UnifiedAttention {
  constructor({ scenes, isWakeAllowed = () => true, initialWakeConfig = () => ({}),
    toolAllowed = () => true, sleepBounds = () => ({}), now = Date.now, monotonic = () => performance.now(), sleep = delay }) {
    this.scenes = scenes; this.store = scenes.store; this.isWakeAllowed = isWakeAllowed;
    this.initialWakeConfig = initialWakeConfig; this.toolAllowed = toolAllowed;
    this.now = now; this.monotonic = monotonic; this.sleep = sleep; this.sleepBounds = sleepBounds;
  }
  checkTool(name) { if (this.toolAllowed(name) !== true) throw fail('TOOL_DENIED'); }
  // HOST ingress may read preferences while offline/paused. No model activity.
  config(key) {
    const ctx = this.scenes.context();
    if (!this.scenes.allowed(key, ctx)) throw fail('SCENE_DENIED');
    this.store.scene(ctx.account, key);
    const row = this.store.db.prepare('SELECT preferences FROM scenes WHERE account=? AND scene=?').get(ctx.account, key);
    const preferences = JSON.parse(row.preferences);
    return preferences.wakeConfig ?? JSON.parse(json(this.initialWakeConfig(key), 8192));
  }
  handler() {
    return {
      scope: 'scene', level: 'v1',
      prepare: ({ target, payload }) => {
        this.checkTool('setWakeConfig');
        const current = this.config(target), input = payload.config;
        const next = { ...current, ...input, triggers: { ...current.triggers, ...input.triggers } };
        if (input.mode === 'diving' && input.triggers?.anyMessage === undefined) next.triggers.anyMessage = false;
        if (next.mode === 'active') { next.infinite = true; next.triggers.anyMessage = true; }
        if (next.infinite !== false) { next.infinite = true; next.sleepUntil = null; }
        else if (input.sleepMs !== undefined) {
          const bounds = this.sleepBounds(target);
          let ms = Math.max(input.sleepMs, Number(bounds.sleepMinMs) || 0);
          if (Number(bounds.sleepMaxMs) > 0) ms = Math.min(ms, Number(bounds.sleepMaxMs));
          next.sleepUntil = new Date(this.now() + ms).toISOString();
        }
        if (next.infinite === false && !Number.isFinite(Date.parse(next.sleepUntil))) throw fail('INVALID_ARGUMENTS');
        if (target === 'qzone' && next.infinite === false) throw fail('SCENE_DENIED');
        delete next.sleepMs;
        return next;
      },
      dispatch: ({ account, target, payload, assertCurrent }) => {
        assertCurrent(); this.checkTool('setWakeConfig');
        this.store.transaction(() => {
          const preferences = JSON.parse(this.store.db.prepare('SELECT preferences FROM scenes WHERE account=? AND scene=?').get(account, target).preferences);
          this.store.db.prepare('UPDATE scenes SET preferences=? WHERE account=? AND scene=?')
            .run(json({ ...preferences, wakeConfig: payload }, 8192), account, target);
          const previous = this.store.db.prepare('SELECT due_at FROM wake_timers WHERE account=? AND scene=?').get(account, target);
          // Merely editing triggers must not re-arm an already delivered alarm.
          if (payload.infinite === false && previous?.due_at === Date.parse(payload.sleepUntil)) return;
          // Cancel only the previous synthetic alarm, never incoming messages.
          this.store.db.prepare(`UPDATE events SET unread=0,wake=0 WHERE account=? AND kind='wake-timer'
            AND seq IN (SELECT event_seq FROM wake_timers WHERE account=? AND scene=?) AND notified=0`).run(account, account, target);
          this.store.db.prepare('DELETE FROM wake_timers WHERE account=? AND scene=?').run(account, target);
          if (payload.infinite === false) this.store.db.prepare('INSERT INTO wake_timers(account,scene,token,due_at) VALUES(?,?,?,?)')
            .run(account, target, randomUUID(), Date.parse(payload.sleepUntil));
        });
        return { status: 'succeeded', result: { key: target, config: payload, messagesNotAcknowledged: true } };
      },
    };
  }
  materialize() {
    const ctx = this.scenes.context();
    // Retain overdue alarms through manual pause and peak-hidden scenes.
    try { this.scenes.active(ctx); } catch (e) { if (e.code === 'PAUSED') return; throw e; }
    const rows = this.store.db.prepare('SELECT * FROM wake_timers WHERE account=? AND event_seq IS NULL AND due_at<=? ORDER BY due_at').all(ctx.account, this.now());
    for (const row of rows) {
      if (!this.scenes.visible(row.scene, ctx) || this.isWakeAllowed({ scene: row.scene, kind: 'wake-timer' }, ctx) !== true) continue;
      this.store.transaction(() => {
        const result = this.store.db.prepare(`INSERT OR IGNORE INTO events(account,scene,source_id,kind,payload,at,wake)
          VALUES(?,?,?,'wake-timer',?,?,1)`).run(ctx.account, row.scene, row.token,
          json({ text: '你为此场景设置的有限睡眠已到期，可自行决定是否参与。', dueAt: row.due_at }), this.now());
        const event = this.store.db.prepare("SELECT seq FROM events WHERE account=? AND scene=? AND source_id=? AND kind='wake-timer'").get(ctx.account, row.scene, row.token);
        if (!event || (!result.changes && !event.seq)) throw fail('INVALID_EVENT');
        this.store.db.prepare('UPDATE wake_timers SET event_seq=? WHERE account=? AND scene=? AND token=? AND event_seq IS NULL')
          .run(event.seq, ctx.account, row.scene, row.token);
      });
    }
  }
  pending(except) {
    const ctx = this.scenes.context(); this.scenes.active(ctx);
    const result = new Map();
    for (const row of this.store.db.prepare('SELECT * FROM events WHERE account=? AND unread=1 AND wake=1 AND notified=0 ORDER BY seq').iterate(ctx.account)) {
      if (row.scene === except || !this.scenes.visible(row.scene, ctx) || this.isWakeAllowed(row, ctx) !== true) continue;
      const item = result.get(row.scene) || { key: row.scene, pending: 0, oldestAt: row.at };
      item.pending++; result.set(row.scene, item);
    }
    return [...result.values()];
  }
  waitEvents(check = () => {}) {
    check(); this.checkTool('waitMessages'); this.materialize();
    const pending = this.pending();
    const ctx = this.scenes.context();
    const since = this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE account=?').get(ctx.account).seq;
    this.store.db.prepare(`INSERT INTO attention_waits(account,since_seq,started) VALUES(?,?,?)
      ON CONFLICT(account) DO UPDATE SET since_seq=excluded.since_seq,started=excluded.started`).run(ctx.account, since, this.now());
    return { status: pending.length ? 'ready' : 'yield', pending: pending.slice(0, 50), hasMore: pending.length > 50,
      instruction: pending.length ? '有符合唤醒条件的事件，可查看菜单并选择处理。' : '结束本轮执行；桥接在符合条件的新事件或有限睡眠到期后再次唤醒。不要循环调用等待。' };
  }
  async waitMessages({ capability, quietMs = 1200, timeoutMs = MAX_QUIET_MS }, check = () => {}) {
    this.checkTool('waitMessages'); this.checkTool('getUnread'); check();
    const cap = this.scenes.authorize(capability);
    const quiet = Math.min(MAX_QUIET_MS, Math.max(0, quietMs));
    const budget = Math.min(MAX_QUIET_MS, Math.max(0, timeoutMs));
    const start = this.now(), startMono = this.monotonic(), deadline = startMono + budget;
    let reason = 'timeout';
    while (true) {
      check(); this.checkTool('waitMessages'); this.checkTool('getUnread'); this.scenes.authorize(capability);
      this.materialize();
      if (this.pending(cap.key).length) { reason = 'other-events'; break; }
      const latest = this.store.db.prepare("SELECT at FROM events WHERE account=? AND scene=? AND kind='message' ORDER BY seq DESC LIMIT 1").get(cap.account, cap.key);
      const lastAt = latest ? Math.min(this.now(), latest.at) : start;
      if (this.now() - lastAt >= quiet) { reason = 'quiet'; break; }
      if (this.monotonic() >= deadline) break;
      await this.sleep(Math.min(100, deadline - this.monotonic(), Math.max(1, quiet - (this.now() - lastAt))));
    }
    check(); this.scenes.authorize(capability);
    // Return the actual current unread batch and a receipt, including messages
    // arriving during model thinking. Never require another blind wait to see it.
    return { reason, quietMs: quiet, elapsedMs: Math.round(this.monotonic() - startMono),
      page: this.scenes.read(capability), pending: this.pending(cap.key).slice(0, 50) };
  }
}
