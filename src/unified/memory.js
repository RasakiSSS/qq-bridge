import { memoryEventId, SHARED_MEMORY_HINT } from '../shared-memory.js';
import { fail } from './store.js';

// Global v1 memory uses the existing account-scoped database, not a new copy.
// Reads neither create model work nor acknowledge messages in the inbox.
export class UnifiedMemory {
  constructor({ scenes, memory, policy }) { this.scenes = scenes; this.store = scenes.store; this.memory = memory; this.policy = policy; }
  access() {
    const ctx = this.scenes.context(); this.scenes.active(ctx); this.policy();
    const hidden = new Map();
    const eventAllowed = event => {
      const key = event.source.startsWith('qzone:') ? 'qzone' : event.source;
      if (!/^(?:qzone|(?:group|private):[1-9]\d{0,19})$/.test(key)) return false;
      if (!this.scenes.allowed(key, ctx)) return false;
      if (this.scenes.visible(key, ctx)) return true;
      if (!hidden.has(key)) {
        const unread = new Set(), read = new Set();
        for (const row of this.store.db.prepare('SELECT source_id,kind,payload,unread FROM events WHERE account=? AND scene=?').iterate(ctx.account, key)) {
          const p = JSON.parse(row.payload);
          let id;
          if (key !== 'qzone') id = memoryEventId(ctx.account, key, row.source_id);
          else if (row.kind === 'qzone-feed') id = memoryEventId(ctx.account, `qzone:${p.authorQQ}`, `post:${p.tid || p.key}`);
          else if (row.kind === 'qzone-comment') id = memoryEventId(ctx.account, `qzone:${p.ownerQQ}:${p.tid}`, `comment:${p.parentId || ''}:${p.commentId}`);
          if (id) (row.unread ? unread : read).add(id);
        }
        hidden.set(key, { unread, read });
      }
      const ids = hidden.get(key);
      // QQ history remains usable; new hidden unread must not leak via recall.
      // Qzone collection records more raw observations than it delivers. When
      // hidden, only acknowledged inbox evidence or our confirmed sends qualify.
      return key === 'qzone' ? event.status === 'sent' || ids.read.has(event.id) : !ids.unread.has(event.id);
    };
    return { account: ctx.account, eventAllowed };
  }
  recall(input) {
    const { account, eventAllowed } = this.access();
    return { ...this.memory.recall(account, { ...input, strictQuery: !!input.query, maxChars: 8000, eventAllowed }), hint: SHARED_MEMORY_HINT };
  }
  handler() {
    return { scope: 'global', level: 'v1', prepare: ({ payload }) => { this.access(); return payload; },
      dispatch: ({ account, payload, assertCurrent }) => {
        assertCurrent(); const access = this.access();
        if (access.account !== account) throw fail('IDENTITY_CHANGED');
        try {
          const id = this.memory.remember(account, payload.note, 'model', access.eventAllowed);
          return { status: 'succeeded', result: { id } };
        } catch (error) {
          if ([400, 409].includes(error.statusCode)) return { status: 'rejected', result: { code: 'MEMORY_EVIDENCE_REJECTED' } };
          throw error;
        }
      } };
  }
}
