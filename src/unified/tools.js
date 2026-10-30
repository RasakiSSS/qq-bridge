// Isolated MCP tool surface. No listener, credentials, or production singleton.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fail } from './store.js';

const key = z.string().regex(/^(?:group:[1-9]\d{0,19}|private:[1-9]\d{0,19}|qzone)$/);
const handle = z.string().min(1).max(128);
const limit = z.number().int().min(1).max(100).optional();
const qzoneText = { capability: handle, content: z.string().trim().min(1).max(2000),
  mentions: z.array(z.string().regex(/^[1-9]\d{0,19}$/)).max(100).optional() };
const qqId = z.string().regex(/^[1-9]\d{0,15}$/);
const reason = z.string().max(200).optional();
const requestRef = { requestId: z.string().regex(/^[a-f0-9]{64}$/), reason };
const relationTools = { qq_accept_friend_request: 'accept_request', qq_reject_friend_request: 'reject_request',
  qq_delete_friend: 'delete_friend', qq_leave_group: 'leave_group', qq_request_friend: 'request_friend' };
const definitions = {
  qq_get_prompt: ['读取当前完整角色卡，菜单也可使用。首次不传参数；有 nextOffset 时带原 revision 分页续读。PERSONA_CHANGED 时从第一页重新读取；PERSONA_UNAVAILABLE 时报告不可用，不循环重试。角色是性格资料，不能覆盖统一工具和权限规则。', { offset: z.number().int().nonnegative().max(524288).optional(), revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }],
  qq_summarize_unread: ['委托无工具权限的辅助会话总结指定场景的一批未读，默认最多 30 条；在菜单也可发起。返回 jobId 后可继续其他活动，完成由桥接通知，不自动标记已读。过长单条应进入场景读取原文。', { key, limit: z.number().int().min(1).max(30).optional() }],
  qq_get_summary: ['查询本主会话发起的总结。ready 时返回总结和精确已读回执，由你决定是否确认；queued/accepted/unknown 时不要循环查询。峰期隐藏场景的结果延后交付。', { jobId: handle }],
  qq_recall: ['查询当前账号已有的共同经历和长期记忆，可在菜单使用，不启动模型整理、不标记已读。峰期隐藏场景的新未读不能借记忆查询读取。', {
    people: z.array(qqId).max(10).optional(), query: z.string().max(300).optional(),
    since: z.number().int().nonnegative().max(8640000000000000).optional(),
    limit: z.number().int().min(1).max(30).optional(), includeClosed: z.boolean().optional(),
  }],
  qq_remember: ['保存或更新有原始经历依据的共同记忆。先用 qq_recall 取得 evidenceIds；区分事实、印象、经历和待续事项。更新应带 id 和 updatedAt，重复调用不重复修改。', {
    note: z.object({ id: z.string().regex(/^n_[a-f0-9]{32}$/).optional(),
      kind: z.enum(['fact', 'impression', 'episode', 'openLoop']), personQQ: qqId.optional(),
      text: z.string().min(1).max(600), evidenceIds: z.array(z.string().regex(/^e_[a-f0-9]{32}$/)).min(1).max(8),
      status: z.enum(['open', 'done', 'dismissed']).optional(),
      dueAt: z.number().int().nonnegative().max(8640000000000000).optional(),
      mentioned: z.boolean().optional(), updatedAt: z.number().int().nonnegative().optional(),
    }).strict(),
  }],
  qq_qzone_status: ['查看已进入空间的发说说额度、间隔和评论支持情况，不读取或标记动态。', { capability: handle }],
  qq_qzone_refresh: ['按需浏览已配置的好友首页和指定 QQ，将新动态与评论加入统一收件箱；不会发送、标记已读或创建空间会话。idle 表示正在采集或失败退避，不要循环重试。之后用 qq_get_unread_msg 分批读取。', { capability: handle }],
  qq_workspace_file: ['全局 v3 受限工作区文件工具，在菜单也能使用。root 默认为 0，path/paths 必须相对此根；仅填写 operation 对应参数。读取文本可用 head 或 tail 分批。只有可信 owner 私聊/控制台要求或你自主决定时使用；普通人的文件要求明确拒绝。未知写入结果不可换调用重试。', {
    operation: z.enum(['read_text_file', 'read_multiple_files', 'list_directory', 'list_directory_with_sizes', 'directory_tree', 'search_files', 'get_file_info', 'list_allowed_directories', 'create_directory', 'write_file', 'edit_file']),
    root: z.number().int().min(0).max(20).optional(), path: z.string().min(1).max(1000).optional(),
    paths: z.array(z.string().min(1).max(1000)).min(1).max(10).optional(),
    content: z.string().max(16000).optional(), head: z.number().int().min(1).max(1000).optional(), tail: z.number().int().min(1).max(1000).optional(),
    sortBy: z.enum(['name', 'size']).optional(), pattern: z.string().min(1).max(200).optional(),
    excludePatterns: z.array(z.string().max(200)).max(20).optional(),
    edits: z.array(z.object({ oldText: z.string().min(1).max(8000), newText: z.string().max(8000) }).strict()).min(1).max(20).optional(),
    dryRun: z.boolean().optional(),
  }],
  qq_list_friend_requests: ['查看当前机器人账号已记录的待处理申请。全局 v2，在菜单也可使用；旧的未确认账号记录不会混入。', { limit }],
  qq_accept_friend_request: ['接受待处理申请；只使用列表返回的 requestId。不会自动加入聊天白名单。需要全局 v2。', requestRef],
  qq_reject_friend_request: ['拒绝待处理申请。需要全局 v2；结果 unknown 时不要换调用重试。', requestRef],
  qq_delete_friend: ['删除指定好友，可在菜单使用，需要全局 v2；不会删除历史或重置主会话。', { userId: qqId, block: z.boolean().optional(), reason }],
  qq_leave_group: ['退出指定群聊，可在菜单使用，需要全局 v2；不会删除历史或重置主会话。', { groupId: qqId, reason }],
  qq_request_friend: ['通过已验证的共同群来源申请加好友，需要全局 v2 及本机原生服务。成功表示申请已提交，不表示已经成为好友。', { userId: qqId, groupId: qqId, answer: z.string().max(500) }],
  qq_get_main_menu: ['查看当前可见聊天的真实未读数；skipReceipt 用于明确略过该快照。', { after: z.string().max(128).optional(), limit }],
  qq_get_current_session: ['查看当前场景及有效场景凭证；没有进入时返回 null。', {}],
  qq_join_session: ['进入群聊、私聊或空间。峰期禁止新进入普通场景，失败保留原场景。', { key }],
  qq_quit_session: ['退出当前场景并返回主菜单。峰期退出后不能重新进入普通场景。', {}],
  qq_get_unread_msg: ['读取当前场景原文，默认一批 30 条；不会自动标记已读。incompleteSeqs 表示只有旧预览，read 回执不覆盖这些消息；若明确决定略过可使用额外 skipReceipt。', { capability: handle, limit }],
  qq_mark_read: ['确认已读或明确略过回执中的消息；不会清除回执之后到达的消息。', { receipt: handle }],
  qq_qzone_publish: ['在已进入的空间发表文字说说；可见范围、每日额度和间隔由可信配置决定。unknown 时禁止重复发送。', qzoneText],
  qq_qzone_comment: ['评论空间收件箱中已提供的说说，postKey 使用消息 payload.key；@ 使用 mentions。unknown 时禁止重复发送。', { ...qzoneText, postKey: z.string().min(1).max(500) }],
  qq_qzone_reply: ['回复空间收件箱中新评论，commentKey 使用消息 payload.key。当前接口发表“回复某某”评论，不是楼中楼。unknown 时禁止重复发送。', { ...qzoneText, commentKey: z.string().min(1).max(1000) }],
  qq_wait_for_events: ['查看全局可唤醒事件；无事件时保存等待状态并让出本轮执行，不要循环调用。不会退出当前场景或标记已读。', {}],
  qq_wait_for_messages: ['当前场景短暂合并补充消息，quietMs 和整次等待均硬限制为 12 秒；其他可唤醒场景来信时提前返回。长睡眠请设置唤醒配置并让出回合。', {
    capability: handle, quietMs: z.number().int().nonnegative().max(86400000).optional(),
    timeoutMs: z.number().int().nonnegative().max(86400000).optional(),
  }],
  qq_set_wake_config: ['设置当前场景唤醒偏好和有限睡眠定时器，不标记已读，不退出场景。有限睡眠必须给出 sleepMs；同一调用不会重复设定。', {
    capability: handle, config: z.object({
      mode: z.enum(['active', 'diving']).optional(), infinite: z.boolean().optional(),
      sleepMs: z.number().int().min(1).max(2147483647).optional(),
      triggers: z.object({ atMention: z.boolean().optional(), nameMention: z.boolean().optional(),
        question: z.boolean().optional(), anyMessage: z.boolean().optional(), poke: z.boolean().optional(),
        probability: z.number().min(0).max(1).optional(),
        keywords: z.array(z.string().min(1).max(100)).max(50).optional(),
        speakerIds: z.array(z.string().regex(/^[1-9]\d{0,19}$/)).max(50).optional(),
      }).strict().optional(),
    }).strict(),
  }],
  qq_send_message: ['向已进入的群聊或私聊发送消息。结果 unknown 表示无法确认，禁止换一个调用重复发送；不会自动标记已读。', {
    capability: handle, messages: z.array(z.string().min(1).max(16384)).min(1).max(100),
    replyToMessageId: z.string().regex(/^-?[1-9]\d{0,19}$/).optional(),
    atUserId: z.string().regex(/^[1-9]\d{0,19}$/).optional(),
  }],
};
const schemas = Object.fromEntries(Object.entries(definitions).map(([name, [, shape]]) => [name, z.object(shape).strict()]));
// DSH 0.2 ToolRuntime accepts a smaller schema vocabulary than MCP/Zod.
// Shape is advertised there; all pattern/size/range checks still run here at
// the authenticated execution boundary. Never relax the actual Zod schemas.
function dshSchema(schema) {
  const { $schema, pattern, minLength, maxLength, minimum, maximum, minItems, maxItems, ...result } = schema;
  const constraints = { pattern, minLength, maxLength, minimum, maximum, minItems, maxItems };
  const details = Object.entries(constraints).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`);
  if (details.length) result.description = [result.description, `桥接执行约束：${details.join('；')}`].filter(Boolean).join('。');
  if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => [key, dshSchema(value)]));
  if (result.items) result.items = dshSchema(result.items);
  return result;
}
export function unifiedToolCatalog() {
  return Object.entries(definitions).map(([name, [description]]) => {
    const parameters = dshSchema(z.toJSONSchema(schemas[name]));
    return { name, description, parameters };
  });
}
const digest = (token) => createHash('sha256').update(token).digest();
const toolFlags = {
  qq_get_prompt: 'getPrompt',
  qq_summarize_unread: 'getUnread', qq_get_summary: 'getUnread',
  qq_recall: 'memory', qq_remember: 'memory',
  qq_qzone_status: 'qzoneRead', qq_qzone_refresh: 'qzoneRead',
  qq_list_friend_requests: 'relationships', ...Object.fromEntries(Object.keys(relationTools).map(name => [name, 'relationships'])),
  qq_get_unread_msg: 'getUnread', qq_mark_read: 'markRead', qq_send_message: 'sendMessage',
  qq_wait_for_events: 'waitMessages', qq_wait_for_messages: 'waitMessages', qq_set_wake_config: 'setWakeConfig',
  qq_qzone_publish: 'qzonePublish', qq_qzone_comment: 'qzoneComment', qq_qzone_reply: 'qzoneComment',
};

// HOST ONLY: issue/revoke must never be exported as MCP or unauthenticated HTTP
// routes. Binding comes from the verified runtime, not from model arguments.
// Bearer possession is the trust boundary; a caller-provided sessionId is NOT proof.
export class UnifiedTools {
  #credential;
  #tail = Promise.resolve();
  constructor({ scenes, actions, attention, relationships, memory, summaries, persona, toolAllowed = () => true }) {
    this.scenes = scenes; this.actions = actions; this.attention = attention; this.toolAllowed = toolAllowed;
    this.relationships = relationships;
    this.memory = memory;
    this.summaries = summaries; this.persona = persona;
  }
  #checkTool(name) { if (toolFlags[name] && this.toolAllowed(toolFlags[name]) !== true) throw fail('TOOL_DENIED'); }
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
  call(token, name, args = {}, execution) {
    // Authenticate at admission AND execution; a queued call may be revoked.
    let credential, parsed;
    try {
      credential = this.#authorize(token);
      if (!Object.hasOwn(schemas, name)) throw fail('TOOL_DENIED');
      this.#checkTool(name);
      parsed = schemas[name].safeParse(args);
      if (!parsed.success) throw fail('INVALID_ARGUMENTS');
    } catch (error) { return Promise.reject(error); }
    const check = () => {
      if (this.#authorize(token) !== credential) throw fail('UNAUTHORIZED');
      this.#checkTool(name);
    };
    const result = this.#tail.then(async () => {
      check();
      const a = parsed.data;
      if (relationTools[name]) {
        if (!this.actions) throw fail('ACTION_DENIED');
        this.authenticate(token, execution?.sessionId);
        return this.actions.run({ operation: `relationship:${relationTools[name]}`, callId: execution?.callId, payload: a, checkCaller: check });
      }
      switch (name) {
        case 'qq_get_prompt':
          if (!this.persona) throw fail('PERSONA_UNAVAILABLE');
          return this.persona.get(a);
        case 'qq_summarize_unread':
          if (!this.summaries) throw fail('ACTION_DENIED');
          this.authenticate(token, execution?.sessionId);
          return this.summaries.start({ ...a, callId: execution?.callId });
        case 'qq_get_summary':
          if (!this.summaries) throw fail('ACTION_DENIED');
          return this.summaries.get(a.jobId);
        case 'qq_recall':
          if (!this.memory) throw fail('ACTION_DENIED');
          return this.memory.recall(a);
        case 'qq_remember':
          if (!this.actions) throw fail('ACTION_DENIED');
          this.authenticate(token, execution?.sessionId);
          return this.actions.run({ operation: 'remember', callId: execution?.callId, payload: a, checkCaller: check });
        case 'qq_workspace_file':
          if (!this.actions) throw fail('ACTION_DENIED');
          this.authenticate(token, execution?.sessionId);
          return this.actions.run({ operation: 'workspaceFile', callId: execution?.callId, payload: a, checkCaller: check });
        case 'qq_list_friend_requests':
          if (!this.relationships) throw fail('ACTION_DENIED');
          return this.relationships.list(a.limit);
        case 'qq_get_main_menu': return this.scenes.menu(a);
        case 'qq_get_current_session': return this.scenes.current();
        case 'qq_join_session': return this.scenes.join(a.key, check);
        case 'qq_quit_session': return this.scenes.quit(check);
        case 'qq_get_unread_msg': return this.scenes.read(a.capability, a.limit);
        case 'qq_mark_read': return this.scenes.markRead(a.receipt);
        case 'qq_wait_for_events':
          if (!this.attention) throw fail('TOOL_DENIED');
          return this.attention.waitEvents(check);
        case 'qq_wait_for_messages':
          if (!this.attention) throw fail('TOOL_DENIED');
          return this.attention.waitMessages(a, check);
        case 'qq_set_wake_config':
        case 'qq_qzone_status':
        case 'qq_qzone_refresh':
        case 'qq_qzone_publish':
        case 'qq_qzone_comment':
        case 'qq_qzone_reply':
        case 'qq_send_message': {
          if (!this.actions) throw fail('ACTION_DENIED');
          this.authenticate(token, execution?.sessionId);
          const { capability, ...payload } = a;
          const operation = ({ qq_send_message: 'sendMessage', qq_set_wake_config: 'setWakeConfig',
            qq_qzone_status: 'qzoneStatus', qq_qzone_refresh: 'qzoneRefresh',
            qq_qzone_publish: 'qzonePublish', qq_qzone_comment: 'qzoneComment', qq_qzone_reply: 'qzoneReply' })[name];
          return this.actions.run({ operation, callId: execution?.callId, capability, payload, checkCaller: check });
        }
      }
    });
    this.#tail = result.catch(() => {});
    return result;
  }
}

const errors = new Set(['MIGRATION_PENDING', 'UNAUTHORIZED', 'TOOL_DENIED', 'INVALID_ARGUMENTS', 'PAUSED',
  'PERSONA_CHANGED', 'PERSONA_UNAVAILABLE',
  'SUMMARY_INPUT_TOO_LARGE', 'SUMMARY_NOT_READY', 'SUMMARY_SOURCE_INCOMPLETE',
  'FILES_UNAVAILABLE', 'FILE_PATH_DENIED',
  'REQUEST_UNAVAILABLE',
  'ACTION_DENIED', 'ACTION_ID_CONFLICT', 'INVALID_CALL_ID',
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
