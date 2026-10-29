// Isolated MCP tool surface. No listener, credentials, or production singleton.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fail } from './store.js';

const key = z.string().regex(/^(?:group:[1-9]\d{0,19}|private:[1-9]\d{0,19}|qzone)$/);
const handle = z.string().min(1).max(128);
const limit = z.number().int().min(1).max(100).optional();
const definitions = {
  qq_get_main_menu: ['查看当前可见聊天的真实未读数；skipReceipt 用于明确略过该快照。', { after: z.string().max(128).optional(), limit }],
  qq_get_current_session: ['查看当前场景及有效场景凭证；没有进入时返回 null。', {}],
  qq_join_session: ['进入群聊、私聊或空间。峰期禁止新进入普通场景，失败保留原场景。', { key }],
  qq_quit_session: ['退出当前场景并返回主菜单。峰期退出后不能重新进入普通场景。', {}],
  qq_get_unread_msg: ['读取当前场景原文，默认一批 30 条；不会自动标记已读。', { capability: handle, limit }],
  qq_mark_read: ['确认已读或明确略过回执中的消息；不会清除回执之后到达的消息。', { receipt: handle }],
};
const schemas = Object.fromEntries(Object.entries(definitions).map(([name, [, shape]]) => [name, z.object(shape).strict()]));
export function unifiedToolCatalog() {
  return Object.entries(definitions).map(([name, [description]]) => {
    const { $schema, ...parameters } = z.toJSONSchema(schemas[name]);
    return { name, description, parameters };
  });
}
const digest = (token) => createHash('sha256').update(token).digest();

// HOST ONLY: issue/revoke must never be exported as MCP or unauthenticated HTTP
// routes. Binding comes from the verified runtime, not from model arguments.
// Bearer possession is the trust boundary; a caller-provided sessionId is NOT proof.
export class UnifiedTools {
  #credential;
  #tail = Promise.resolve();
  constructor({ scenes }) { this.scenes = scenes; }
  #binding() {
    const ctx = this.scenes.context();
    const sessionId = this.scenes.store.account(ctx.account).session_id;
    if (!sessionId) throw fail('MAIN_SESSION_NOT_BOUND');
    return JSON.stringify([ctx.account, ctx.ownerQQ, ctx.identityEpoch, sessionId]);
  }
  issueMainCredential() {
    const binding = this.#binding();
    const token = randomBytes(32).toString('hex');
    this.#credential = { binding, hash: digest(token) };
    return token;
  }
  revoke() { this.#credential = undefined; }
  // HOST transport only. Session metadata is checked against the bearer binding.
  authenticate(token, sessionId) {
    this.#authorize(token);
    const ctx = this.scenes.context();
    const bound = this.scenes.store.account(ctx.account).session_id;
    if (sessionId !== bound) throw fail('UNAUTHORIZED');
    return { account: ctx.account, sessionId: bound };
  }
  #authorize(token) {
    const credential = this.#credential;
    if (!credential || typeof token !== 'string' || token.length !== 64
      || !timingSafeEqual(digest(token), credential.hash)) throw fail('UNAUTHORIZED');
    if (credential.binding !== this.#binding()) {
      this.revoke(); throw fail('UNAUTHORIZED');
    }
    this.scenes.active();
    return credential;
  }
  call(token, name, args = {}) {
    // Authenticate at admission AND execution; a queued call may be revoked.
    let credential, parsed;
    try {
      credential = this.#authorize(token);
      if (!Object.hasOwn(schemas, name)) throw fail('TOOL_DENIED');
      parsed = schemas[name].safeParse(args);
      if (!parsed.success) throw fail('INVALID_ARGUMENTS');
    } catch (error) { return Promise.reject(error); }
    const check = () => {
      if (this.#authorize(token) !== credential) throw fail('UNAUTHORIZED');
    };
    const result = this.#tail.then(async () => {
      check();
      const a = parsed.data;
      switch (name) {
        case 'qq_get_main_menu': return this.scenes.menu(a);
        case 'qq_get_current_session': return this.scenes.current();
        case 'qq_join_session': return this.scenes.join(a.key, check);
        case 'qq_quit_session': return this.scenes.quit(check);
        case 'qq_get_unread_msg': return this.scenes.read(a.capability, a.limit);
        case 'qq_mark_read': return this.scenes.markRead(a.receipt);
      }
    });
    this.#tail = result.catch(() => {});
    return result;
  }
}

const errors = new Set(['UNAUTHORIZED', 'TOOL_DENIED', 'INVALID_ARGUMENTS', 'PAUSED',
  'PERMISSION_DENIED', 'STALE_SCENE', 'SCENE_DENIED', 'IDENTITY_CHANGED',
  'INVALID_RECEIPT', 'RECEIPT_NOT_DELIVERED', 'PEAK_SCENE_ENTRY_BLOCKED']);

// The transport adapter provides dispatch with a HOST-held credential. Never
// put the main credential in tool schemas/results, prompts, or helper sessions.
// Constructing the server opens no transport. Production mounting is separate.
export function createUnifiedMcpServer({ dispatch }) {
  const server = new McpServer({ name: 'qq-unified', version: '0.1.0' });
  for (const [name, [description, shape]] of Object.entries(definitions)) {
    server.tool(name, description, shape, async (args, extra) => {
      try {
        const result = await dispatch(name, args, extra?._meta);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const code = errors.has(error?.code) ? error.code : 'UNIFIED_TOOL_FAILED';
        const text = code === 'PEAK_SCENE_ENTRY_BLOCKED'
          ? `${code}：当前处于峰期，可自主休眠；管理员私聊仍可唤醒。` : code;
        return { isError: true, content: [{ type: 'text', text }] };
      }
    });
  }
  return server;
}
