import { UnifiedStore, fail } from './store.js';
import { UnifiedScenes } from './scenes.js';
import { UnifiedScheduler } from './scheduler.js';
import { UnifiedTools } from './tools.js';
import { UnifiedDshSession, UnifiedDshEvidence, recoverDshDispatch } from './dsh-session.js';
import { UnifiedActions } from './actions.js';
import { UnifiedManagement } from './management.js';
import { UnifiedOwner } from './owner.js';

// Explicit host composition. Merely importing this module does nothing. This
// has account ownership fencing, but no production transport or legacy migration.
export class UnifiedRuntime {
  #credentialBinding;
  #bindingTail = Promise.resolve();
  #frameTail = Promise.resolve();
  #closed = false;
  constructor({ file, getContext, isAllowed, isWakeAllowed, api, workspaceId,
    readWorkspaces, configureModel, bindMainTools, authenticateQQ, authenticateConsole,
    handlers = {}, prepareScene, now = Date.now }) {
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
      this.bindMainTools = bindMainTools;
      this.scenes = new UnifiedScenes({ store: this.store, getContext: ownedContext, isAllowed, now, prepare: prepareScene });
      this.tools = new UnifiedTools({ scenes: this.scenes });
      this.evidence = new UnifiedDshEvidence({ store: this.store });
      this.dsh = new UnifiedDshSession({ store: this.store, scenes: this.scenes, api, workspaceId, readWorkspaces });
      this.actions = new UnifiedActions({ store: this.store, scenes: this.scenes, handlers, now });
      this.management = new UnifiedManagement({ scenes: this.scenes, authenticateQQ, authenticateConsole, now });
      this.scheduler = new UnifiedScheduler({ store: this.store, scenes: this.scenes, isWakeAllowed, now,
        ensureSession: async identity => {
          const before = this.#context();
          const check = () => {
            const ctx = this.#context(); this.scenes.active(ctx);
            if (ctx.account !== before.account || ctx.ownerQQ !== before.ownerQQ || ctx.identityEpoch !== before.identityEpoch
              || this.store.account(ctx.account).session_id !== identity.sessionId) throw fail('IDENTITY_CHANGED');
          };
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
  tick() { this.#context(); return this.scheduler.tick(); }
  onDshFrame(payload, options = {}) {
    const operation = this.#frameTail.then(() => this.#onDshFrame(payload, options));
    this.#frameTail = operation.catch(() => {});
    return operation;
  }
  async #onDshFrame(payload, { signal } = {}) {
    const ctx = this.#context();
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
