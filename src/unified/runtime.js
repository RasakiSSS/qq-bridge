import { UnifiedPersona } from './persona.js';
import { UnifiedStore, fail } from './store.js';
import { UnifiedScenes } from './scenes.js';
import { UnifiedScheduler } from './scheduler.js';
import { UnifiedTools } from './tools.js';
import { UnifiedDshSession, UnifiedDshEvidence, recoverDshDispatch } from './dsh-session.js';
import { UnifiedActions } from './actions.js';
import { UnifiedManagement } from './management.js';
import { UnifiedOwner } from './owner.js';
import { UnifiedAttention } from './attention.js';
import { UnifiedRelationships } from './relationships.js';
import { UnifiedFiles } from './files.js';
import { UnifiedMemory } from './memory.js';
import { UnifiedSummary } from './summary.js';
import { summaryWorkerAdapter } from './summary-dsh.js';

// Explicit host composition. Merely importing this module does nothing. This
// has account ownership fencing, but no production transport or legacy migration.
export class UnifiedRuntime {
  #credentialBinding;
  #bindingTail = Promise.resolve();
  #frameTail = Promise.resolve();
  #closed = false;
  constructor({ file, getContext, isAllowed, isWakeAllowed, api, workspaceId,
    readWorkspaces, configureModel, bindMainTools, authenticateQQ, authenticateConsole,
    handlers = {}, prepareScene, beforeSession = async () => {}, initialWakeConfig, toolAllowed, sleepBounds, relationships, files, memory, summaries, readPersona, legacyCommand, now = Date.now }) {
    if (!file || typeof configureModel !== 'function' || typeof bindMainTools !== 'function'
      || typeof isWakeAllowed !== 'function') throw fail('RUNTIME_HOST_ADAPTER_REQUIRED');
    this.store = new UnifiedStore(file);
    try {
      const account = getContext().account;
      this.owner = new UnifiedOwner({ store: this.store, account });
      const ownedContext = () => {
        this.owner.assert();
        const ctx = getContext();
        if (ctx.account !== account) throw fail('IDENTITY_CHANGED');
        return ctx;
      };
      this.api = api;
      this.beforeSession = beforeSession;
      this.bindMainTools = bindMainTools;
      this.scenes = new UnifiedScenes({ store: this.store, getContext: ownedContext, isAllowed, now, prepare: prepareScene });
      this.evidence = new UnifiedDshEvidence({ store: this.store });
      this.dsh = new UnifiedDshSession({ store: this.store, scenes: this.scenes, api, workspaceId, readWorkspaces });
      this.attention = new UnifiedAttention({ scenes: this.scenes, isWakeAllowed, initialWakeConfig, toolAllowed, sleepBounds, now });
      if (relationships) {
        this.relationships = new UnifiedRelationships({ ...relationships, scenes: this.scenes, now });
        handlers = { ...handlers };
        for (const action of ['accept_request', 'reject_request', 'delete_friend', 'leave_group', 'request_friend'])
          handlers[`relationship:${action}`] = this.relationships.handler(action);
      }
      if (files) handlers = { ...handlers, workspaceFile: new UnifiedFiles(files).handler() };
      if (memory) {
        this.memory = new UnifiedMemory({ ...memory, scenes: this.scenes });
        handlers = { ...handlers, remember: this.memory.handler() };
      }
      this.actions = new UnifiedActions({ store: this.store, scenes: this.scenes, handlers: { ...handlers, setWakeConfig: this.attention.handler() }, now });
      if (summaries) this.summaries = new UnifiedSummary({ scenes: this.scenes, now, policy: summaries.policy,
        ensureWorker: summaryWorkerAdapter({ store: this.store, api, workspaceId, configureModel, readWorkspaces }),
        prompt: input => { this.#context(); return api.sessions.prompt(input); }, follow: sid => api.events.follow(sid),
        retire: async sid => {
          this.#context();
          const result = await api.workspace.archiveSession({ sessionId: sid });
          if (result?.result?.ok !== true) throw fail('SUMMARY_RETIRE_FAILED');
          this.#context(); api.events.forget?.(sid);
        } });
      if (readPersona) this.persona = new UnifiedPersona({ scenes: this.scenes, read: readPersona });
      this.tools = new UnifiedTools({ scenes: this.scenes, actions: this.actions, attention: this.attention, relationships: this.relationships, memory: this.memory, summaries: this.summaries, persona: this.persona, toolAllowed });
      this.management = new UnifiedManagement({ scenes: this.scenes, authenticateQQ, authenticateConsole, legacyCommand, now });
      this.scheduler = new UnifiedScheduler({ store: this.store, scenes: this.scenes, isWakeAllowed, now, personaStatus: () => this.persona?.status(),
        ensureSession: async identity => {
          const before = this.#context();
          const check = () => {
            const ctx = this.#context(); this.scenes.active(ctx);
            if (ctx.account !== before.account || ctx.ownerQQ !== before.ownerQQ || ctx.identityEpoch !== before.identityEpoch
              || this.store.account(ctx.account).session_id !== identity.sessionId) throw fail('IDENTITY_CHANGED');
          };
          await this.beforeSession(identity); check();
          const sid = await this.dsh.ensure(identity); check();
          if (await configureModel({ ...identity }) !== true) throw fail('MODEL_CONFIGURATION_FAILED');
          check();
          await this.#bind(identity, before); check();
          this.api.events.follow(sid); check();
          return sid;
        },
        prompt: input => { this.#context(); return this.api.sessions.prompt(input); },
      });
      this.scheduler.recoverPreparing(account);
      this.actions.recoverPreparing(account);
    } catch (error) { this.owner?.release(); this.store.close(); throw error; }
  }
  #context() {
    if (this.#closed) throw fail('RUNTIME_CLOSED');
    return this.scenes.context();
  }
  #bind(identity, before) {
    const operation = this.#bindingTail.then(async () => {
      const check = () => {
        const ctx = this.#context(); this.scenes.active(ctx);
        if (ctx.account !== before.account || ctx.ownerQQ !== before.ownerQQ || ctx.identityEpoch !== before.identityEpoch
          || this.store.account(ctx.account).session_id !== identity.sessionId) throw fail('IDENTITY_CHANGED');
      };
      check();
      const binding = JSON.stringify([identity.account, identity.sessionId, before.ownerQQ, before.identityEpoch]);
      if (this.#credentialBinding === binding) return;
      const token = this.tools.issueMainCredential();
      try {
        if (await this.bindMainTools({ ...identity, token }) !== true) throw fail('MAIN_TOOLS_NOT_BOUND');
        check(); this.#credentialBinding = binding;
      } catch (error) { this.tools.revoke(); this.#credentialBinding = undefined; throw error; }
    });
    this.#bindingTail = operation.catch(() => {});
    return operation;
  }
  async restore() {
    const before = this.#context(); this.scenes.active(before);
    const sessionId = this.store.account(before.account).session_id;
    if (!sessionId) return { status: 'idle' };
    const identity = { account: before.account, sessionId };
    await this.beforeSession(identity);
    await this.dsh.ensure(identity, { existingOnly: true, allowBusy: true });
    await this.#bind(identity, before);
    this.api.events.follow(sessionId);
    return { status: 'following', sessionId };
  }
  ingest({ key, sourceId, kind, payload, at, wake }) {
    const ctx = this.#context();
    if (!this.scenes.allowed(key, ctx)) throw fail('SCENE_DENIED');
    // Pause/peak suppress model activity, not durable incoming messages.
    return this.store.append({ account: ctx.account, scene: key, sourceId, kind, payload, at, wake });
  }
  // Operator-only snapshot: no inbox receipts, model wake or state normalization.
  status() {
    const ctx = this.#context(), db = this.store.db;
    const state = db.prepare('SELECT permission,paused,current_scene,session_id,retry_at FROM accounts WHERE account=?').get(ctx.account);
    const counts = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(unread),0) AS unread FROM events WHERE account=?').get(ctx.account);
    const phases = db.prepare('SELECT phase,COUNT(*) AS count FROM summary_jobs WHERE account=? GROUP BY phase').all(ctx.account);
    return { ready: true, account: ctx.account, permission: state.permission,
      paused: !!(ctx.paused || state.paused || ctx.enabled === false), peak: this.scenes.peak(ctx),
      currentScene: state.current_scene, sessionId: state.session_id, retryAt: state.retry_at,
      dispatch: this.store.active(ctx.account)?.status || 'idle',
      counts: { ...counts }, summaries: Object.fromEntries(phases.map(row => [row.phase, row.count])),
      migration: db.prepare('SELECT phase FROM migration_imports WHERE account=?').get(ctx.account)?.phase ?? null,
      pendingTimers: db.prepare('SELECT COUNT(*) AS count FROM wake_timers WHERE account=? AND event_seq IS NULL').get(ctx.account).count };
  }
  wakeConfig(key) { this.#context(); return this.attention.config(key); }
  friendRequest(event) { this.#context(); if (!this.relationships) throw fail('ACTION_DENIED'); return this.relationships.ingest(event); }
  tick() {
    this.#context(); this.attention.materialize();
    return this.scheduler.tick().then(async result => {
      await this.summaries?.tick();
      return result;
    });
  }
  onDshFrame(payload, options = {}) {
    const operation = this.#frameTail.then(() => this.#onDshFrame(payload, options));
    this.#frameTail = operation.catch(() => {});
    return operation;
  }
  async #onDshFrame(payload, { signal } = {}) {
    const ctx = this.#context();
    if (this.summaries && payload?.type === 'session/event' && this.summaries.event(payload.sessionId, payload.event)) return { handled: true, summary: true };
    if (this.summaries && payload?.type === 'session/snapshot' && await this.summaries.recover(payload.sessionId, payload.snapshot, async args => {
      const result = await this.api.callUnary('session/page', args, signal);
      if (result?.result?.ok !== true) throw fail('DSH_READ_FAILED');
      return result.result.value;
    })) return { handled: true, summary: true };
    if (payload?.sessionId !== this.store.account(ctx.account).session_id) return { handled: false };
    if (payload.type === 'session/event') {
      const completed = this.evidence.event(payload.sessionId, payload.event);
      return { handled: true, completed };
    }
    if (payload.type === 'session/snapshot') {
      this.evidence.snapshot(payload.sessionId, payload.snapshot);
      const result = await recoverDshDispatch({ store: this.store, api: this.api,
        sessionId: payload.sessionId, snapshot: payload.snapshot, signal, evidence: this.evidence });
      return { handled: true, recovery: result };
    }
    return { handled: false };
  }
  close() {
    if (this.#closed) return;
    this.#closed = true; this.tools.revoke();
    // Host must await in-flight runtime calls before closing. Closing never
    // clears persisted unknown dispatches/actions or cancels a remote turn.
    try { this.owner.release(); } finally { this.store.close(); }
  }
}
