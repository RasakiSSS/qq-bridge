// DSH 0.2.1-rc.2 / DeepSeek Flash 动态工具更新兼容处理。
// 默认只检查；--apply 备份后通过官方设置接口实时切换为完整工具列表。
// --restore <backup.json> 精确恢复原 models 用户覆盖；从不改写会话历史。
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { probeCookie, probeRpc } from './probe-auth.mjs';

export const NAMESPACE = 'llm-deepseek';
const MODEL = 'deepseek-flash';

export function planToolUpdateFallback(namespace) {
  if (namespace?.ns !== NAMESPACE || namespace.applies !== 'live') {
    throw new Error('需要支持实时配置的官方 DeepSeek 路由');
  }
  const before = namespace.value?.models;
  if (!Array.isArray(before) || before.filter(m => m?.id === MODEL).length !== 1) {
    throw new Error('模型列表缺失或 deepseek-flash 不唯一，拒绝修改');
  }
  const model = before.find(m => m.id === MODEL);
  if (model.toolUpdate === undefined) return null;
  if (!['addition-only', 'in-history'].includes(model.toolUpdate)) {
    throw new Error('未知 toolUpdate 能力，拒绝修改');
  }
  const after = structuredClone(before);
  delete after.find(m => m.id === MODEL).toolUpdate;
  const hadUserModels = Object.hasOwn(namespace.user ?? {}, 'models');
  return {
    format: 'qq-bridge-tool-update-fallback-v1',
    namespace: NAMESPACE,
    model: MODEL,
    before: structuredClone(before),
    after,
    hadUserModels,
    ...(hadUserModels ? { userModels: structuredClone(namespace.user.models) } : {}),
  };
}

async function describe(rpc) {
  const result = await rpc('settings/describe', {});
  if (!result?.ok) throw new Error(result?.error?.message ?? '无法读取 DSH 设置');
  const namespace = result.value.namespaces?.find(n => n.ns === NAMESPACE);
  if (!namespace) throw new Error('未找到官方 DeepSeek 路由');
  return namespace;
}

async function mutateModels(rpc, namespace, op) {
  const result = await rpc('settings/mutate', {
    ns: NAMESPACE, ops: [op], expectedRevision: namespace.revision,
  });
  if (!result?.ok) throw new Error(result?.error?.message ?? 'DSH 拒绝修改设置');
  return describe(rpc);
}

export async function applyToolUpdateFallback({ rpc, saveBackup }) {
  const namespace = await describe(rpc);
  const plan = planToolUpdateFallback(namespace);
  if (!plan) return { changed: false };
  // 备份失败时不写设置；修订号防止覆盖并发的管理员修改。
  const backup = await saveBackup(plan);
  const actual = await mutateModels(rpc, namespace, { op: 'set', path: ['models'], value: plan.after });
  if (!isDeepStrictEqual(actual.value?.models, plan.after)) {
    throw new Error(`设置写入后校验失败，请保留备份 ${backup}`);
  }
  return { changed: true, backup };
}

export async function restoreToolUpdates({ rpc, plan }) {
  if (plan?.format !== 'qq-bridge-tool-update-fallback-v1' || plan.namespace !== NAMESPACE
      || plan.model !== MODEL || typeof plan.hadUserModels !== 'boolean'
      || !Array.isArray(plan.before) || !Array.isArray(plan.after)
      || (plan.hadUserModels && !Array.isArray(plan.userModels))) {
    throw new Error('无效的兼容处理备份');
  }
  const namespace = await describe(rpc);
  if (!isDeepStrictEqual(namespace.value?.models, plan.after)) {
    throw new Error('模型配置已经变化，拒绝用旧备份覆盖');
  }
  const op = plan.hadUserModels
    ? { op: 'set', path: ['models'], value: plan.userModels }
    : { op: 'unset', path: ['models'] };
  const actual = await mutateModels(rpc, namespace, op);
  const user = actual.user ?? {};
  if (Object.hasOwn(user, 'models') !== plan.hadUserModels
      || (plan.hadUserModels && !isDeepStrictEqual(user.models, plan.userModels))) {
    throw new Error('原 models 用户覆盖未恢复，请保留备份检查');
  }
  return { changed: true };
}

async function main() {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 1 && ['--check', '--apply'].includes(args[0]))
      || (args.length === 2 && args[0] === '--restore'))) {
    throw new Error('用法：node scripts/dsh-tool-update-workaround.mjs [--check | --apply | --restore <backup.json>]');
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const base = process.env.DSH_BASE_URL || config.dsh?.baseUrl || 'http://127.0.0.1:3080';
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password) throw new Error('本脚本仅支持本机 DSH');
  const rpc = probeRpc(probeCookie({ base }), { base });
  if (args[0] === '--apply') {
    const result = await applyToolUpdateFallback({ rpc, saveBackup: async plan => {
      const dir = path.join(root, 'state', 'dsh-setting-backups');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `tool-updates-${Date.now()}.json`);
      fs.writeFileSync(dest, JSON.stringify({ ...plan, base, createdAt: new Date().toISOString() }, null, 2),
        { flag: 'wx', mode: 0o600 });
      return dest;
    } });
    console.log(result.changed ? `已实时应用完整工具列表方式。备份：${result.backup}` : '已使用完整工具列表，无需修改。');
  } else if (args[0] === '--restore') {
    const plan = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    if (plan.base !== base) throw new Error('备份来自不同 DSH 地址，拒绝恢复');
    await restoreToolUpdates({ rpc, plan });
    console.log('已恢复原 models 用户覆盖。');
  } else {
    console.log(planToolUpdateFallback(await describe(rpc))
      ? '官方 deepseek-flash 启用了动态工具更新，可用 --apply 备份并切换为完整工具列表。'
      : '官方 deepseek-flash 已使用完整工具列表。');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
