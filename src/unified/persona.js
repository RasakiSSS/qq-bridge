import { createHash } from 'node:crypto';
import { fail } from './store.js';

// Trusted host text only. Never accepts a filename or a model-supplied persona.
// Pages bind to a revision so editing a card mid-read cannot mix two versions.
export class UnifiedPersona {
  constructor({ scenes, read }) { this.scenes = scenes; this.read = read; }
  snapshot() {
    this.scenes.active(this.scenes.context());
    const value = this.read();
    if (!value || typeof value.text !== 'string' || Buffer.byteLength(value.text) > 512 * 1024) throw fail('PERSONA_UNAVAILABLE');
    const name = String(value.name || ''), mode = String(value.mode || 'active');
    const revision = createHash('sha256').update(JSON.stringify([name, mode, value.text])).digest('hex');
    return { name, mode, revision, text: value.text };
  }
  status() { const { text, ...status } = this.snapshot(); return { ...status, totalChars: text.length }; }
  get({ offset = 0, revision } = {}) {
    const value = this.snapshot();
    if ((offset > 0 && !revision) || (revision && revision !== value.revision)) throw fail('PERSONA_CHANGED');
    if (offset > value.text.length) throw fail('INVALID_ARGUMENTS');
    let end = Math.min(offset + 4000, value.text.length);
    if (end < value.text.length && /[\uD800-\uDBFF]/.test(value.text[end - 1])) end--;
    return { ...value, text: value.text.slice(offset, end), offset, totalChars: value.text.length,
      nextOffset: end < value.text.length ? end : null };
  }
}
