import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml, PRESET_BLOCKING_SUBSTRINGS_UNIFIED } from '../src/preset-prompt.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const source = fs.readFileSync(new URL('../dsh/agent-presets/qq-unified/agent.cordis.yml', import.meta.url), 'utf8');
test('unified editor validates its own protocol and keeps plugins unchanged', () => {
  const prefix = extractPresetPrefix(source);
  assert.deepEqual(presetPromptBlockers(prefix, 'unified'), []);
  assert.deepEqual(presetPromptWarnings(prefix, 'unified'), []);
  for (const marker of PRESET_BLOCKING_SUBSTRINGS_UNIFIED)
    assert.throws(() => renderPresetPromptYaml(source, prefix.replaceAll(marker, ''), 'unified'));
  const updated = renderPresetPromptYaml(source, prefix + '\n测试语气调整。', 'unified');
  assert.equal(extractPresetPrefix(updated), prefix.trimEnd() + '\n测试语气调整。');
  assert.deepEqual(yaml.load(updated).filter(e => e.id !== 'persona'), yaml.load(source).filter(e => e.id !== 'persona'));
});

test('authenticated console edits unified source without touching legacy preset or creating sessions', async t => {
  const legacy = 'legacy fixture unchanged';
  const home = path.join(os.tmpdir(), 'unified-editor-no-install-' + randomUUID());
  const h = await bridgeHarness({ globals: { os: { ...os, homedir: () => home } }, files: {
    'dsh/agent-presets/qq-unified/agent.cordis.yml': source,
    'dsh/agent-presets/qq-chat-v2/agent.cordis.yml': legacy,
  } });
  t.after(() => h.close());
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/preset/sim-prompt`;
    const headers = { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' };
    const loaded = await (await fetch(endpoint + '?preset=qq-unified', { headers })).json();
    assert.equal(loaded.ok, true); assert.deepEqual(loaded.warnings, []);
    const content = loaded.content + '\n新的语气。';
    const result = await (await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ preset: 'qq-unified', content }) })).json();
    assert.equal(result.ok, true);
    assert.equal(extractPresetPrefix(fs.readFileSync(h.temp + '/dsh/agent-presets/qq-unified/agent.cordis.yml', 'utf8')), content.trimEnd());
    assert.equal(fs.readFileSync(h.temp + '/dsh/agent-presets/qq-chat-v2/agent.cordis.yml', 'utf8'), legacy);
    const backupDir = path.join(h.temp, 'state/preset-backups');
    const backup = fs.readdirSync(backupDir)[0];
    const backupPath = path.join(backupDir, backup);
    const original = fs.readFileSync(backupPath, 'utf8');
    fs.writeFileSync(backupPath, original.replace('qq-unified-guard.mjs', 'different-guard.mjs'));
    const restore = () => fetch(endpoint + '/restore', { method: 'POST', headers, body: JSON.stringify({ preset: 'qq-unified', file: backup }) });
    assert.equal((await restore()).status, 400);
    assert.equal(extractPresetPrefix(fs.readFileSync(h.temp + '/dsh/agent-presets/qq-unified/agent.cordis.yml', 'utf8')), content.trimEnd());
    fs.writeFileSync(backupPath, original);
    assert.equal((await (await restore()).json()).ok, true);
    assert.equal(h.calls.created.length, 0); assert.equal(h.calls.prompts.length, 0);
    assert.equal((await fetch(endpoint + '?preset=qq-unified', { headers: { ...headers, 'x-agent-call': '1' } })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
