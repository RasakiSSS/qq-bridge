import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnifiedPersona } from '../src/unified/persona.js';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';

test('full persona pages are revision-bound, preserve content and respect pause', t => {
  const store = new UnifiedStore(); t.after(() => store.close());
  const scenes = new UnifiedScenes({ store, getContext: () => ({ account: '100', ownerQQ: '200', identityEpoch: 1 }), isAllowed: () => true });
  let card = { name: 'fixture', mode: 'active', text: '角色内容'.repeat(3000) };
  const persona = new UnifiedPersona({ scenes, read: () => card });
  const first = persona.get();
  let text = first.text, page = first;
  while (page.nextOffset !== null) { page = persona.get({ offset: page.nextOffset, revision: first.revision }); text += page.text; }
  assert.equal(text, card.text);
  assert.throws(() => persona.get({ offset: 4000 }), { code: 'PERSONA_CHANGED' });
  card = { ...card, text: card.text.replace('角', '新') };
  assert.throws(() => persona.get({ offset: 4000, revision: first.revision }), { code: 'PERSONA_CHANGED' });
  card = { ...card, text: 'x'.repeat(3999) + '🐟tail' };
  assert.equal(persona.get().nextOffset, 3999);
  card = { name: '', mode: 'active', text: '' };
  assert.equal(persona.get().nextOffset, null);
  assert.notEqual(persona.status().revision, first.revision);
  scenes.setPaused(true);
  assert.throws(() => persona.get(), { code: 'PAUSED' });
});
