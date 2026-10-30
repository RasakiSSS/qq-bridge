import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';
import { apply } from '../plugins/qq-agent-presets/qq-unified-client.mjs';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedTools } from '../src/unified/tools.js';

const { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } = await import(
  pathToFileURL(path.join(dshModulesDir(), '@deepseek-ai/dsh-tools/lib/index.js')));

test('installed DSH validator accepts every unified tool input/output schema', () => {
  const definitions = [];
  apply({ tools: { register: definition => definitions.push(definition) } });
  assert.equal(definitions.length, 22);
  for (const definition of definitions) {
    assert.doesNotThrow(() => assertObjectJsonSchema(definition.parameters), definition.name);
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.output.schema), definition.name);
    assert.deepEqual(validateJsonSchemaValue(definition.output.schema, '{}'), []);
  }
  const send = definitions.find(item => item.name === 'qq_send_message');
  assert.deepEqual(validateJsonSchemaValue(send.parameters, { capability: 'cap', messages: ['hello'] }), []);
  assert.ok(validateJsonSchemaValue(send.parameters, { capability: 'cap', messages: ['hello'], sessionId: 'spoof' }).length);
});

test('DSH schema projection does not weaken execution pattern, size or range validation', async t => {
  const store = new UnifiedStore(); t.after(() => store.close());
  store.account('100'); store.db.prepare("UPDATE accounts SET session_id='main-1'").run();
  const scenes = new UnifiedScenes({ store, getContext: () => ({ account: '100', ownerQQ: '200', enabled: true }), isAllowed: () => true });
  const tools = new UnifiedTools({ scenes }), token = tools.issueMainCredential();
  for (const [name, args] of [
    ['qq_join_session', { key: 'group:0' }], ['qq_get_main_menu', { limit: 101 }],
    ['qq_send_message', { capability: 'c', messages: [] }],
    ['qq_send_message', { capability: 'c', messages: ['x'.repeat(16385)] }],
    ['qq_send_message', { capability: 'c', messages: ['x'], atUserId: 'all' }],
  ]) await assert.rejects(tools.call(token, name, args), { code: 'INVALID_ARGUMENTS' });
});
