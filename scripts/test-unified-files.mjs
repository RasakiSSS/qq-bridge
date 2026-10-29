import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedScenes } from '../src/unified/scenes.js';
import { UnifiedActions } from '../src/unified/actions.js';
import { UnifiedTools } from '../src/unified/tools.js';
import { UnifiedFiles, workspaceServer } from '../src/unified/files.js';

function fixture(t, realServer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-files-'));
  const root = path.join(dir, 'workspace'); fs.mkdirSync(root);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new UnifiedStore(); t.after(() => store.close());
  store.account('100'); store.db.prepare("UPDATE accounts SET session_id='main'").run();
  const ctx = { account: '100', enabled: true }, calls = [];
  const scenes = new UnifiedScenes({ store, getContext: () => ctx, isAllowed: () => true });
  let hook = () => {}, allowed = true, response = { content: [{ type: 'text', text: 'ok' }] };
  const server = { command: process.execPath, script: realServer || 'fixture-script', roots: [root] };
  const files = new UnifiedFiles({ getServer: () => server, policy: () => { if (!allowed) throw Error('disabled'); },
    ...(!realServer ? { connectServer: async () => { await hook(); return {
      call: async input => { calls.push(input); return response; }, close: async () => {} };
    } } : {}),
  });
  const actions = new UnifiedActions({ store, scenes, handlers: { workspaceFile: files.handler() } });
  const tools = new UnifiedTools({ scenes, actions }), token = tools.issueMainCredential();
  return { dir, root, scenes, ctx, calls, tools, server, files, hook: fn => hook = fn, disable: () => allowed = false,
    response: value => response = value,
    call: (args, id = 'call-1') => tools.call(token, 'qq_workspace_file', args, { sessionId: 'main', callId: id }) };
}

test('workspace operations are global v3, exact-call deduped, bounded and reject unsupported fields', async t => {
  const f = fixture(t);
  f.scenes.setPermission('v2');
  await assert.rejects(f.call({ operation: 'list_allowed_directories' }), { code: 'PERMISSION_DENIED' });
  f.scenes.setPermission('v3');
  assert.equal((await f.call({ operation: 'list_allowed_directories' })).status, 'succeeded');
  const input = { operation: 'write_file', path: 'note.txt', content: 'hello' };
  assert.equal((await f.call(input, 'write')).status, 'succeeded'); await f.call(input, 'write');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].arguments.path, path.join(f.root, 'note.txt'));
  assert.equal(f.scenes.current(), null);
  await assert.rejects(f.call({ operation: 'delete_file', path: 'note.txt' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(f.call({ operation: 'read_text_file', path: 'note.txt', content: 'bad' }, 'extra'), { code: 'INVALID_ARGUMENTS' });
  f.response({ content: [{ type: 'text', text: '大'.repeat(30000) }] });
  const output = await f.call({ operation: 'read_text_file', path: 'note.txt' }, 'read');
  assert.equal(output.result.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(output)) < 32768);
});

test('relative paths cannot traverse, select drives, use device names, links or hardlinks', async t => {
  const f = fixture(t);
  for (const value of ['../secret', '..\\secret', 'C:\\secret', 'a:stream', 'NUL', 'a/../secret', 'folder. /secret']) {
    await assert.rejects(f.call({ operation: 'read_text_file', path: value }, value), { code: 'FILE_PATH_DENIED' });
  }
  const outside = path.join(f.dir, 'secret.txt'); fs.writeFileSync(outside, 'secret');
  fs.linkSync(outside, path.join(f.root, 'hardlink'));
  await assert.rejects(f.call({ operation: 'read_text_file', path: 'hardlink' }, 'hardlink'), { code: 'FILE_PATH_DENIED' });
  const outsideDir = path.join(f.dir, 'outside'); fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, path.join(f.root, 'linked'), 'junction');
  await assert.rejects(f.call({ operation: 'write_file', path: 'linked/new.txt', content: 'bad' }, 'link'), { code: 'FILE_PATH_DENIED' });
  assert.equal(f.calls.length, 0);
});

test('revocation, pause, root changes and link replacement during server startup stop file I/O', async t => {
  for (const mode of ['downgrade', 'pause', 'revoke', 'disable', 'root', 'link']) {
    const f = fixture(t);
    f.hook(() => {
      if (mode === 'downgrade') f.scenes.setPermission('v2');
      if (mode === 'pause') f.ctx.paused = true;
      if (mode === 'revoke') f.tools.revoke();
      if (mode === 'disable') f.disable();
      if (mode === 'root') f.server.roots = [f.dir];
      if (mode === 'link') fs.symlinkSync(f.dir, path.join(f.root, 'folder'), 'junction');
    });
    const result = await f.call({ operation: 'write_file', path: 'folder/note.txt', content: 'bad' });
    assert.equal(result.status, 'unknown'); assert.equal(f.calls.length, 0);
  }
});

test('uncertain writes remain unknown, server errors are sanitized, and missing required fields fail before startup', async t => {
  const f = fixture(t);
  for (const args of [{ operation: 'write_file', path: 'a' }, { operation: 'edit_file', path: 'a' }, { operation: 'search_files', path: '.' }]) {
    await assert.rejects(f.call(args, args.operation), { code: 'INVALID_ARGUMENTS' });
  }
  f.response({ isError: true, content: [{ type: 'text', text: 'secret path/token' }] });
  const input = { operation: 'write_file', path: 'a', content: 'hello' };
  assert.equal((await f.call(input, 'uncertain')).status, 'unknown');
  assert.equal((await f.call(input, 'uncertain')).status, 'unknown'); assert.equal(f.calls.length, 1);
  const read = await f.call({ operation: 'read_text_file', path: 'a' }, 'read');
  assert.equal(read.status, 'rejected'); assert.equal(JSON.stringify(read).includes('secret'), false);
});

test('trusted preset reuses only declared roots and excludes binding or executable access', t => {
  const f = fixture(t), script = path.join(f.dir, 'server.js'); fs.writeFileSync(script, '');
  const preset = [{ config: { serverName: 'qq-workspace-files', transport: 'stdio', command: process.execPath, args: [script, f.root] } }];
  assert.deepEqual(workspaceServer(preset, path.join(f.dir, 'binding.json')).roots, [fs.realpathSync(f.root)]);
  assert.throws(() => workspaceServer(preset, path.join(f.root, 'binding.json')), { code: 'FILES_UNAVAILABLE' });
  preset[0].config.args[1] = f.dir;
  assert.throws(() => workspaceServer(preset, path.join(f.dir, 'binding.json')), { code: 'FILES_UNAVAILABLE' });
});

test('installed Filesystem MCP performs isolated create/write/edit/read through real stdio', async t => {
  const preset = yaml.load(fs.readFileSync(new URL('../dsh/agent-presets/qq-chat-v2-files/agent.cordis.yml', import.meta.url), 'utf8'));
  const script = preset.find(x => x?.config?.serverName === 'qq-workspace-files')?.config?.args?.[0];
  if (!script || !fs.existsSync(script)) { t.skip('Existing administrator Filesystem installation is unavailable on this machine'); return; }
  const f = fixture(t, script);
  for (const [id, args] of [
    ['mkdir', { operation: 'create_directory', path: 'notes' }],
    ['write', { operation: 'write_file', path: 'notes/test.txt', content: 'hello\nworld\n' }],
    ['edit', { operation: 'edit_file', path: 'notes/test.txt', edits: [{ oldText: 'world', newText: 'fish' }] }],
    ['read', { operation: 'read_text_file', path: 'notes/test.txt', head: 2 }],
  ]) {
    const result = await f.call(args, id); assert.equal(result.status, 'succeeded');
    if (id === 'read') assert.match(result.result.text, /hello\nfish/);
  }
  assert.equal(fs.readFileSync(path.join(f.root, 'notes/test.txt'), 'utf8'), 'hello\nfish\n');
});
