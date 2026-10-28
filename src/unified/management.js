import { fail } from './store.js';

const id = value => typeof value === 'string' ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const levels = {
  v1: '聊天、空间、记忆和总结',
  v2: '聊天、空间、记忆、总结和好友关系操作',
  v3: '聊天、空间、记忆、总结、好友关系及受限工作区文件操作',
};

// Separate HOST ingress, never part of the model's MCP tool surface. Authenticators
// must verify the OneBot connection/console request; payload fields are not proof.
export class UnifiedManagement {
  constructor({ scenes, authenticateQQ, authenticateConsole, now = Date.now }) {
    if (typeof authenticateQQ !== 'function' || typeof authenticateConsole !== 'function') throw fail('MANAGEMENT_AUTH_REQUIRED');
    this.scenes = scenes; this.authenticateQQ = authenticateQQ; this.authenticateConsole = authenticateConsole; this.now = now;
  }
  #contextUnchanged(before) {
    const ctx = this.scenes.context();
    if (ctx.account !== before.account || ctx.ownerQQ !== before.ownerQQ || ctx.identityEpoch !== before.identityEpoch) throw fail('IDENTITY_CHANGED');
    return ctx;
  }
  #apply(ctx, permission, source) {
    if (permission !== undefined && !Object.hasOwn(levels, permission)) throw fail('INVALID_PERMISSION');
    const store = this.scenes.store;
    return store.transaction(() => {
      const before = store.account(ctx.account).permission;
      if (permission !== undefined && before !== permission) {
        store.db.prepare('INSERT INTO permission_audit(account,before_level,after_level,source,at) VALUES(?,?,?,?,?)')
          .run(ctx.account, before, permission, source, this.now());
        this.scenes.setPermission(permission);
      }
      const current = permission ?? before;
      return { permission: current, changed: current !== before, description: levels[current] };
    });
  }
  async fromQQ(connection, event) {
    // Only an original text-only message is a management command. Forwarded,
    // quoted and model-produced content is never extracted and reinterpreted.
    let text;
    if (typeof event?.message === 'string' && !event.message.includes('[CQ:')) text = event.message;
    else if (Array.isArray(event?.message) && event.message.length > 0 && event.message.every(p => p?.type === 'text' && typeof p.data?.text === 'string')) {
      text = event.message.map(p => p.data.text).join('');
    }
    if (typeof text !== 'string' || !/^\/permission(?:\s|$)/.test(text.trim())) return { handled: false };
    const before = this.scenes.context();
    if (await this.authenticateQQ(connection, event) !== true) throw fail('UNAUTHORIZED');
    const ctx = this.#contextUnchanged(before);
    if (event.post_type !== 'message' || event.message_type !== 'private' || id(event.self_id) !== ctx.account
      || !ctx.ownerQQ || id(event.user_id) !== ctx.ownerQQ) {
      return { handled: true, denied: true, response: '只有管理员私聊可以查看或修改全局权限。' };
    }
    const match = /^\/permission(?:\s+(v[123]))?$/.exec(text.trim());
    if (!match) return { handled: true, response: '用法：/permission 或 /permission v1、v2、v3。' };
    const result = this.#apply(ctx, match[1], 'owner-private');
    return { handled: true, ...result, response: `当前全局权限：${result.permission}（${result.description}）。` };
  }
  async fromConsole(request, permission) {
    const before = this.scenes.context();
    if (await this.authenticateConsole(request) !== true) throw fail('UNAUTHORIZED');
    return this.#apply(this.#contextUnchanged(before), permission, 'console');
  }
}
