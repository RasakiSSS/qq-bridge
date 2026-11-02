import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  NAMESPACE, planToolUpdateFallback, applyToolUpdateFallback, restoreToolUpdates,
} from './dsh-tool-update-workaround.mjs';
import { dshModulesDir } from './dsh-modules.mjs';

function fixture(userModels) {
  const original = [{
    id: 'deepseek-flash', name: 'Flash', contextWindow: 1000000,
    inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only',
  }, { id: 'other-model', toolUpdate: 'in-history' }];
  let ns = { ns: NAMESPACE, applies: 'live', revision: 3,
    base: { models: original }, user: { maxTokens: 8192, ...(userModels ? { models: userModels } : {}) },
    value: { models: structuredClone(userModels ?? original), maxTokens: 8192 } };
  const calls = [];
  const rpc = async (method, args) => {
    calls.push({ method, args: structuredClone(args) });
    if (method === 'settings/describe') return { ok: true, value: { namespaces: [structuredClone(ns)] } };
    assert.equal(method, 'settings/mutate');
    assert.equal(args.ns, NAMESPACE);
    if (args.expectedRevision !== ns.revision) return { ok: false, error: { message: 'revision conflict' } };
    const [op] = args.ops;
    assert.equal(args.ops.length, 1);
    assert.deepEqual(op.path, ['models']);
    if (op.op === 'set') ns.user.models = structuredClone(op.value);
    else delete ns.user.models;
    ns.value.models = structuredClone(ns.user.models ?? ns.base.models);
    ns.revision++;
    return { ok: true, value: structuredClone(ns) };
  };
  return { rpc, calls, get ns() { return ns; }, original };
}

test('only removes Flash toolUpdate; preserves model, vision, context, system updates and other models', () => {
  const f = fixture();
  const before = structuredClone(f.ns);
  const p = planToolUpdateFallback(f.ns);
  assert.deepEqual(f.ns, before);
  assert.deepEqual(p.after[0], Object.fromEntries(Object.entries(f.original[0]).filter(([k]) => k !== 'toolUpdate')));
  assert.deepEqual(p.after[1], f.original[1]);
});

test('backs up before a revision-checked write, verifies settings and is idempotent', async () => {
  const f = fixture();
  let backup;
  const result = await applyToolUpdateFallback({ rpc: f.rpc, saveBackup: async p => {
    assert.equal(f.calls.filter(c => c.method === 'settings/mutate').length, 0);
    backup = p;
    return 'fixture.json';
  } });
  assert.deepEqual(result, { changed: true, backup: 'fixture.json' });
  assert.deepEqual(f.ns.value.models, backup.after);
  assert.equal(f.ns.user.maxTokens, 8192);
  assert.deepEqual(await applyToolUpdateFallback({ rpc: f.rpc, saveBackup: () => assert.fail('no second backup') }), { changed: false });
  assert.equal(f.calls.filter(c => c.method === 'settings/mutate').length, 1);
});

test('backup failure and concurrent administrator edits prevent writing', async () => {
  const f = fixture();
  await assert.rejects(applyToolUpdateFallback({ rpc: f.rpc, saveBackup: () => { throw new Error('disk unavailable'); } }), /disk unavailable/);
  assert.equal(f.calls.some(c => c.method === 'settings/mutate'), false);
  await assert.rejects(applyToolUpdateFallback({ rpc: f.rpc, saveBackup: () => {
    f.ns.revision++;
    return 'fixture.json';
  } }), /revision conflict/);
  assert.deepEqual(f.ns.value.models, f.original);
});

for (const customized of [false, true]) {
  test(`restore preserves original user override presence (${customized}) and unrelated settings`, async () => {
    const custom = customized ? [{ id: 'deepseek-flash', name: 'My Flash', toolUpdate: 'in-history' }] : undefined;
    const f = fixture(custom);
    const before = structuredClone(f.ns.user);
    let backup;
    await applyToolUpdateFallback({ rpc: f.rpc, saveBackup: p => { backup = p; return 'fixture.json'; } });
    await restoreToolUpdates({ rpc: f.rpc, plan: backup });
    assert.deepEqual(f.ns.user, before);
    assert.deepEqual(f.ns.value.models, custom ?? f.original);
  });
}

test('refuses stale restore, unavailable routes, invalid catalog and rejected writes', async () => {
  const f = fixture();
  const backup = planToolUpdateFallback(f.ns);
  await assert.rejects(restoreToolUpdates({ rpc: f.rpc, plan: backup }), /配置已经变化/);
  await assert.rejects(restoreToolUpdates({ rpc: f.rpc, plan: {} }), /无效/);
  assert.throws(() => planToolUpdateFallback({ ...f.ns, applies: 'restart' }), /实时/);
  assert.throws(() => planToolUpdateFallback({ ...f.ns, ns: 'llm-deepseek-account' }), /官方/);
  assert.throws(() => planToolUpdateFallback({ ...f.ns, value: { models: [] } }), /不唯一/);
  assert.throws(() => planToolUpdateFallback({ ...f.ns, value: { models: [{ id: 'deepseek-flash', toolUpdate: 'unknown' }] } }), /未知/);
  const reject = async (method, args) => method === 'settings/mutate'
    ? { ok: false, error: { message: 'write refused' } } : f.rpc(method, args);
  await assert.rejects(applyToolUpdateFallback({ rpc: reject, saveBackup: () => 'fixture.json' }), /write refused/);
  assert.deepEqual(f.ns.value.models, f.original);
});

test('detects an accepted write that did not change effective settings', async () => {
  const f = fixture();
  const ignore = async (method, args) => method === 'settings/mutate'
    ? { ok: true, value: f.ns } : f.rpc(method, args);
  await assert.rejects(applyToolUpdateFallback({ rpc: ignore, saveBackup: () => 'fixture.json' }), /校验失败/);
});

test('existing guards still separate administrator files from ordinary QQ and deny native execution', async () => {
  const capture = async file => {
    const { apply } = await import(new URL(file, import.meta.url));
    let guard;
    apply({ tools: { restrict() {}, guard(fn) { guard = fn; } } });
    return name => guard({ name });
  };
  const ordinary = await capture('../plugins/qq-agent-presets/qq-tool-restrict.mjs');
  const administrator = await capture('../plugins/qq-agent-presets/qq-tool-restrict-files.mjs');
  for (const guard of [ordinary, administrator]) {
    assert.equal(guard('mcp__snowluma__qq_delete_sticker'), undefined);
    for (const denied of ['pwsh', 'bash', 'read', 'write', 'mcp__freeciv_red__get_state']) {
      assert.equal(typeof guard(denied), 'string');
    }
  }
  for (const tool of ['read_text_file', 'write_file']) {
    assert.equal(administrator(`mcp__qq-workspace-files__${tool}`), undefined);
    assert.equal(typeof ordinary(`mcp__qq-workspace-files__${tool}`), 'string');
  }
  assert.equal(typeof administrator('mcp__qq-workspace-files__delete_file'), 'string');
});

let modules;
try { modules = dshModulesDir(); } catch { /* A clean bridge checkout need not install DSH. */ }
test('installed DSH wire serialization: keeps current safe tools and reasoning, omits historical additions without mutating history',
  { skip: !modules && 'DSH not installed; pure settings tests still run' }, async () => {
    const load = name => import(pathToFileURL(path.join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
    const { DeepSeekAdapter, resolveAdapterOptions } = await load('dsh-llm-deepseek');
    const { projectToolUpdates } = await load('dsh-llm');
    const tool = name => ({ name, description: name, parameters: { type: 'object', properties: {} } });
    const retained = tool('mcp__snowluma__qq_get_prompt');
    const added = tool('mcp__snowluma__qq_delete_sticker');
    const files = tool('mcp__qq-workspace-files__read_text_file');
    const removed = tool('mcp__freeciv_red__get_state');
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'Fixture safety rules' }] },
      { role: 'user', content: [{ type: 'text', text: 'Fixture message' }] },
      { id: 'update-1', role: 'developer', content: [
        { type: 'tool-addition', toolName: added.name },
        { type: 'tool-removal', toolName: removed.name },
      ] },
    ];
    const tools = [retained, { ...added, deferLoading: true }, files];
    const history = { tools: [retained, files, removed], updates: [{ messageId: 'update-1', additions: [added] }] };
    const original = structuredClone({ messages, tools, history });
    const f = fixture();
    // Do not include the fixture's unrelated model in this real adapter test.
    const before = [f.original[0]];
    const after = planToolUpdateFallback({ ...f.ns, value: { models: before } }).after;
    const captured = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://deepseek.invalid/anthropic/v1/messages');
      captured.push({ body: JSON.parse(options.body), headers: options.headers });
      throw new Error('fixture transport capture');
    };
    try {
      for (const models of [before, after]) {
        const connection = resolveAdapterOptions({ models, baseURL: 'https://deepseek.invalid/anthropic' });
        const adapter = new DeepSeekAdapter({ options: () => connection,
          resolveAuth: async () => ({ headers: {} }), resolveUserId: () => 'fixture',
          prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
        });
        const prepared = await adapter.prepareCall('deepseek-official', 'deepseek-flash');
        const projection = projectToolUpdates(messages, tools, prepared.model.toolUpdate, history);
        await assert.rejects(async () => {
          for await (const _ of prepared.stream({ provider: 'deepseek-official', model: 'deepseek-flash',
            reasoningEffort: 'max', ...projection })) { /* Transport is captured locally. */ }
        }, /transport failed/);
      }
    } finally { globalThis.fetch = previousFetch; }
    assert.equal(captured.length, 2);
    assert(captured[0].body.messages.some(m => m.role === 'system' && m.content.some(b => b.type === 'tool_addition')));
    const { body, headers } = captured[1];
    assert(body.messages.every(m => m.content.every(b => !['tool_addition', 'tool_removal'].includes(b.type))));
    assert.deepEqual(body.tools.map(t => t.name), tools.map(t => t.name));
    assert(body.tools.every(t => !Object.hasOwn(t, 'defer_loading')));
    assert.equal(headers['anthropic-beta'], undefined);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.output_config.effort, 'max');
    assert.equal(body.system, 'Fixture safety rules');
    assert.deepEqual({ messages, tools, history }, original);
  });
