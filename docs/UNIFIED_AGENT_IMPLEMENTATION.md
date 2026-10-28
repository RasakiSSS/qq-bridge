# 统一主体实施状态

更新：2026-10-29。需求见 [v1.0](UNIFIED_AGENT_REQUIREMENTS.md)，协议依据见 [P1 报告](UNIFIED_AGENT_P1_REPORT.md)。

当前完成 P2 基础模块、六工具工厂、DSH 会话适配/回合证据恢复、动作账本、管理入口、独占运行身份及运行组件组合；**没有挂载生产入口，没有启用统一模式，没有迁移或重启任何生产会话**。现有二代仿真、管理员文件 preset 和 QQ 空间仍按原代码运行。

## 已实现

| 文件 | 内容 |
| --- | --- |
| `src/unified/store.js` | 独立 SQLite 账本；账号级权限和暂停、当前场景代次、偏好、事件去重、真实未读、消息范围回执、总结结果、持久化投递身份；事务、WAL、FULL 同步；错误数据库/版本拒绝打开 |
| `src/unified/scenes.js` | 主菜单、join/quit、场景凭证、逐条动作资格检查、全局等级检查、读取/略过/总结后确认；可信上下文注入；复用 `model-prices.js` 峰谷判断 |
| `src/unified/scheduler.js` | 一个账号一个在途主请求；持久化 sessionId/requestId；准备与投递前复查；明确拒绝退避、未知结果保留、回执关联；有界提示预览 |
| `scripts/test-unified-foundation.mjs` | 模拟时间、模拟 DSH、临时 SQLite 的 46 项基础回归 |
| `src/unified/tools.js` | 主身份凭证签发/撤销、严格参数和固定六工具入口、MCP server 工厂；没有自动启动 transport |
| `scripts/test-unified-tools.mjs` | 7 项认证/异步撤权/MCP 内存 transport 回归 |
| `src/unified/dsh-session.js` | 当前 preset 投影、共享工作区归属、创建意图持久化、真实 request/turn 证据、固定历史截点分页恢复 |
| `src/unified/actions.js` | 动作执行前记账、调用 ID 去重、成功/拒绝/未知回执、执行前权限复查 |
| `src/unified/management.js` | 原始 owner 私聊 `/permission` 与控制台内部入口，认证回调必填，事务审计 |
| `src/unified/owner.js` | 账号独占运行身份；旧进程存活或无法验证时不抢占，代次检查阻止旧实例继续写出 |
| `src/unified/runtime.js` | 组合上述组件，接收消息、显式 tick、绑定主工具、恢复已有 session、处理 DSH 帧；没有自动启动监听或定时器 |

数据库仅在显式实例化 `UnifiedStore(file)` 时打开。默认内存数据库供隔离测试；生产适配必须传入受保护的独立文件路径，不能误用内存模式。模块没有导入时启动的定时器或网络客户端。

### 行为与数据

- 峰期新进入普通群/私聊/空间返回 `PEAK_SCENE_ENTRY_BLOCKED`。当前已进入场景可继续多轮，失败 join 保留原场景；quit 或成功切换后原资格失效。管理员豁免精确匹配可信 `ownerQQ` 的私聊 key。
- 手动暂停及禁用优先；ACL 撤销使当前场景失效。正常回合结束不自动 quit。可靠重启后恢复已保存场景并重新核验准入；旧凭证不恢复，重新签发。
- 主菜单返回真实未读数量和用于明确略过的回执。读取/总结默认 30 条；批量原文同时受字节预算约束，可返回更小的一页及剩余数，不截断原文后冒充完整已读。
- 回执关联精确消息集合，不靠最大序号清空。新到消息、其他场景、未完成总结和部分总结未覆盖的消息保持未读；重复确认不重复消费。
- 总结结果先保存，只有当前可见且已递送后才能确认。峰期隐藏场景的旧菜单回执和晚到总结不可使用；低谷后可以继续。辅助模型 worker 本身尚未接入。
- 事件以账号、场景、上游标识和种类去重，重复来信不复活已读状态；入库事件数不受 30 条限制。现有偏好可按场景保存，不因峰谷和重启重置。
- 投递 `accepted` 与“已读”分开。收到 DSH 接收回执只设置已通知，不清未读；必须再用对应回执明确处理。
- 每个账号最多一个 preparing / dispatching / accepted / unknown 请求。并发 scheduler 对象及两个 SQLite 连接的抢占已验证；这不是生产多进程发送权租约，后者由迁移/运行适配层实现。
- sessionId 在准备前写入；创建响应丢失后仍使用同一身份。实际 prompt 请求使用持久 requestId。明确拒绝按 1 分钟起指数退避，最多 1 小时；时间到仍重新检查峰谷和暂停。
- 请求已发但响应丢失、响应结构不可信或接收后本地确认失败，均保留 uncertain 状态，不自动换编号重发。迟到的接收/错误不能覆盖已确认的完成结果。
- 提示中的长消息/媒体只给有界预览；不完整预览没有已读回执，需读取原文或由主菜单明确略过。原始事件保留。

## 内部接口约束

这些类是内部组件，**不是已经完成鉴权的 HTTP/MCP API**。不能将其方法直接暴露给模型。

1. `getContext()` 由桥接提供可信的账号、ownerQQ、启用/暂停、峰谷配置和 `identityEpoch`；账号及 QQ 号用字符串。账号、owner 或授权上下文切换时，宿主递增 epoch，以识别异步等待期间发生又恢复的身份变化。外部消息不能填写这些值。
2. `isAllowed(key, context)`、`isWakeAllowed(event, context)` 为宿主同步检查。后者需接入现有潜水/唤醒偏好，在准备结束后再次计算；入库的 wake 标记只是候选，不替代实时规则。配置/ACL 撤销时须主动调用状态复核，不能等权限重新开放后才通知组件。
3. 管理权限设置、人工暂停、`saveSummary` 和投递 `confirm` 均只允许可信宿主调用。后续入口分别核验管理员来源、worker 作业归属及真实 DSH 请求/回合证据。
4. `ensureSession` 必须核验已有 session 的 preset、账号和工作区，并返回指定的同一个 sessionId；不能为“修复错误”新建任意 session。已有适配见 `dsh-session.js`，生产入口尚未挂载。
5. `confirm` 要同时关联 requestId 与 sessionId。不能拿任意历史 turn/end 解锁当前请求。`recoverPreparing` 仅供确认旧进程已停止后的独占启动；dispatching/unknown 不因超时自动解锁。
6. `send` 只是逐条场景资格检查辅助函数，回调由宿主提供。**它不替代持久动作账本**；生产回调须在调用 QQ 前以稳定工具调用 ID 记账，区分成功/拒绝/未知，并保留原有出站审计、配额、工具开关。回调抛错后返回 `uncertain: true`，不承诺没有发送。
7. 新模式使用固定工具面，通过 `active(context, 'v2'/'v3')` 等在执行入口检查等级；当前尚无文件代理和关系操作适配，不能声称它们已由新权限体系控制。

当前事件单条序列化上限 128 KiB，偏好 8 KiB，总结结果 24 KiB，原文批次约 192 KiB，唤醒正文 32 KiB；这些是输入稳定性预算，不是社交次数限制。超限显式报错，不把失败入库当作成功接收。生产接入时须将过大的原始消息/媒体保存在原有历史或附件通道，以句柄分页提供，不能静默丢弃。

## 本轮验证

执行：

```text
node --test --test-reporter=spec scripts/test-unified-foundation.mjs
node --test --test-reporter=spec scripts/test-unified-dsh-contract.mjs scripts/test-dsh-inbox-projection.mjs
node --check src/unified/store.js
node --check src/unified/scenes.js
node --check src/unified/scheduler.js
git diff --check
```

基础测试 46/46，通过的既有协议/投影测试 26/26；合计 72 项。只有临时数据和模拟调用，没有向真实 QQ/DSH 投递。新增代码通过语法检查；本轮未运行或修改 P1 已记录的旧提示词失败用例。

重点覆盖：工作日六个峰谷边界、周末/已确认节假日、owner 私聊与群内冒充、关闭峰谷、跨峰异步 join、峰期多轮、暂停、身份变化、并发切换、分条动作撤权、85 条未读分批、快照新增、总结部分成功/晚到/重启、数据库拒绝损坏、并发调度、丢失创建响应、未知投递及重启、提前终态、字节预算和真实偏好复核。

## 下一步及上线前缺口

按顺序接入，避免把基础测试当作完整产品验收：

1. 将运行组件和六工具工厂挂载到可信生产 transport，创建主 preset/专用守卫，接入当前 DSH 客户端事件流；保持旧模式分支，显式选择才启用。
2. 为动作账本注册真实发送/文件/关系处理器，接原发送审计、ACL、路径限制、配额及工具开关；从可信 DSH 工具调用元数据取得稳定 callId。完成全局等待、当前场景短等待、有限睡眠和关注项调度。
3. 将管理入口接到已验证的 OneBot 连接和控制台请求认证；接桥接管理的总结 worker 与全局文件/关系工具；不把内部管理方法暴露给模型。
4. 将空间通知采集与模型决策拆开，主 Agent 执行空间动作；共同记忆衔接，保留既有历史。
5. 补齐账本回执/终态记录的安全清理策略、上游事件缺口与超大内容处理、完整 DSH 冷恢复验证、旧状态导入和回滚演练，最后才安排生产重载。

备份分支 `codex/backup-unified-foundation-20261028` 包含开工时已有的受跟踪修改。本轮未改动用户更新的 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`，也未加入个人角色文件。

## 2026-10-28 主身份与 MCP 入口交接

按用户要求先将此前提交脱敏导出至远端新分支 `codex/unified-agent-20261028`，远端起始提交 `7b090ea`，对应生产源码 `a841595`。生产 main 的旧历史不可直接 push。导出目录及后续远端提交记录见本地忽略文件 `state/probes/remote-backup.json`。继续开发前本地代码备份为 `codex/backup-unified-adapters-20261028`；用户未提交提示词和个人角色文件保持原样。

新增工具：`qq_get_main_menu`、`qq_get_current_session`、`qq_join_session`、`qq_quit_session`、`qq_get_unread_msg`、`qq_mark_read`。MCP 使用实际 SDK 和内存 transport 验证 list/call，尚未连生产 DSH。模型不能通过这些工具设置权限、修改暂停、提交总结、确认 DSH 回合或发送 QQ。

认证是宿主签发的 256 bit bearer，内存仅保存摘要，绑定账号、owner、identityEpoch、已持久化主 sessionId。不能用模型填写的 sessionId/owner 字段冒充；不把凭据放入工具参数、返回、提示或子 Agent。签发、撤销都是宿主内部方法，绝不可做成未鉴权接口。每次排队和执行重新认证；join 的异步准备后及 quit 的场景队列内再认证。重启需新签发，旧 bearer 不恢复。宿主身份变动必须递增 epoch，不能把“变更后又改回”当作未发生。

`createUnifiedMcpServer({dispatch})` 仅创建工具工厂，dispatch 由后续可信 transport 注入。当前没有 HTTP 路由、stdio 启动脚本、凭据部署、主 preset 或 worker 挂载。错误仅返回允许的静态错误码，峰期错误另提示休眠，不外泄任意上游异常文本。

本轮验证：基础 46 + 新入口 7 + 原协议/投影 26，共 79 项；语法检查和 diff 检查通过。未做真实模型或 QQ 操作。

下一步从 DSH 会话适配开始：安装版 `dsh-api-session-controller` 的 `lib/types/list.js` 中 `listFields` 只加入 parentSessionId/origin/cwd，没有直接 agentPreset；完整 summary 含 projections，须核实 preset 的可信投影来源及 workspace 归属，不能直接照搬旧空间模块的 `old.agentPreset` 判断。`sessions.create` 对指定的已使用会话可能新建，因此必须先查找并验证已有身份；列表失败不能解释为不存在。随后接 `source.rpcId` 与 turn 的真实关联、生产 transport、管理命令和持久动作账本。此次没有实现或验证这部分，不能把入口测试当作单 session 已上线。

用户最新额度要求：5 小时剩余低于 20% 做交接，替代此前 15%。本轮在接近阈值时开始收尾，不使用额度重置权益。

## 2026-10-29 运行组件交接

开工基线 `628cded`，备份分支 `codex/backup-unified-dsh-20261029`。用户提示词修改和个人角色文件未纳入开发提交。以下是本次新增，前一节是历史记录。

### 已验证的 DSH 协议

- 已安装 `dsh-agent-preset-registry` 注册 `agentPreset` 投影；`session/list` 的投影可能只是缓存。适配只接受 `session/projections` 返回的 `kind: sequenced` 和 `values.agentPreset === 'qq-unified'`，缺失或需要迁移时停止。
- 工作区归属通过新开的、带认证 Cookie 的 `workspace/follow` baseline 查询，核验目标工作区、唯一成员归属和未归档状态。10 秒超时，可取消；回环模拟 WebSocket 实测了 Cookie、endpoint 和帧格式。没有向真实 DSH 发请求。
- 账号/sessionId/workspaceId/preset/创建意图先持久化；创建前原子占位。创建回执丢失但目标实际存在时可恢复；已尝试创建却仍无法确认目标时返回 `SESSION_CREATION_UNCERTAIN`，不不断重建。不同返回 ID 不采纳，已绑定会话消失不重置。已有会话只读取和验证，不调用 create 来恢复。
- `user/message.data.source.rpcId` 与桥接 requestId 精确匹配，必须处于连续序号的同一个 `turn/start`—`turn/end` 内才认定结束。结束可以是错误/取消；这里只表示尝试已结束，不表示 QQ 动作成功。
- 冷恢复使用 `session/page`，固定 snapshot 的 `throughSeq` 向前读取；只保留 seq/type/turn/rpcId，丢弃正文和工具结果。默认最多 32 页、50,000 条证据记录，超限或缺口保留未知。补查和实时帧串行，补回的正在进行的 turn 可以继续接受实时 end。`restore()` 只复核、绑定工具并 follow 原会话，不重新 prompt 或创建；人工暂停仍拦住恢复活动。

### 动作、权限与运行所有权

- `UnifiedActions.run` 使用 `(account, sessionId, callId)` 持久去重；同 ID 的内容、目标或操作改变会拒绝。prepare 必须没有外部写副作用；调用 dispatch 前记为 dispatching。明确成功/拒绝返回原回执，超时/断线/不明返回保持 unknown；重启不重发 dispatching/unknown。
- **动作账本尚未挂载 QQ、文件或好友真实处理器。** callId 必须来自可信的 DSH 工具调用身份，不能拿每次新生成的 HTTP 请求 ID 替代；该传递链仍待生产 transport 实现。处理器保留既有审计和限制，并在异步过程后的最终写入点调用 `assertCurrent()`。分条发送已发部分不能撤回，后续中断时不将整批重新执行。
- `UnifiedManagement` 的两个认证回调必须来自真实 OneBot/控制台鉴权，模型参数不构成身份。命令要求原始纯文本、`post_type: message`、准确 self_id 和 owner 私聊；引用/转发中不提取命令，群内 owner 不豁免。权限变化和审计同事务；修改权限不解除暂停。尚未改动 `bridge.js` 的命令分发。
- 独占所有权不使用“超时即抢占”。同机旧 PID 明确不存在才能接管；旧 PID 被复用、异机或权限不足无法验证时拒绝。旧 owner 的代次不能继续通过场景/动作检查。仅取得独占所有权后才能把 preparing 恢复为 deferred，其他在途/未知状态保留。关闭前宿主必须等待在途调用结束，不能把 `close()` 当作远程取消。
- `UnifiedRuntime` 组合库有显式 ingest/tick/restore/onDshFrame，使用注入的真实唤醒规则、模型配置和工具绑定回调。工具绑定失败或模型配置失败均不发 prompt。它不自动启动生产服务，不自动调度下一轮；最后这些驱动点需要接 bridge 事件循环。

### 数据、测试与下一次起点

账本从 schema 1 增量迁移到 2，新增 `session_bindings`、`actions`、`permission_audit`、`runtime_owners`。已有消息、权限、暂停、当前场景保留。只有临时测试账本执行过迁移；不要拿旧版程序去打开新版账本，也不要删除生产数据来解决版本错误。

运行以下组合共 **153 项通过**：

```text
node --test --test-reporter=dot scripts/test-unified-foundation.mjs scripts/test-unified-tools.mjs scripts/test-unified-dsh-session.mjs scripts/test-unified-actions.mjs scripts/test-unified-management.mjs scripts/test-unified-owner.mjs scripts/test-unified-runtime.mjs scripts/test-unified-dsh-contract.mjs scripts/test-dsh-inbox-projection.mjs
```

其中原有 79 项，新增 DSH 36、动作 16、管理 10、所有权 3、组合 9。回环网络测试在沙箱内失败，在获批的沙箱外运行通过；未修改网络/文件 ACL。没有测试或修改生产模型、发送真实 QQ、调用真实好友/文件动作。

下一次优先做 **生产 MCP transport + qq-unified preset/守卫 + bridge 入口接线**。先解决稳定 DSH tool-call ID 的传递和主凭据仅注入主会话的问题，再注册真实写动作；不能直接把旧管理员文件 MCP 全局挂到主会话，必须走全局等级代理。随后接等待/睡眠/总结、空间采集拆分、旧模式停止与新模式所有权交接。新运行锁只能隔离统一运行实例，旧 bridge 尚不使用该锁，因此上线前必须明确停止旧模式的自动投递，不能双开。

本轮未实现主 preset、生产工具监听、发送/文件/好友处理器、独立空间采集、总结 worker 或旧会话迁移；还不能声明单 session 版本可上线。生产重载继续留到这些完成并验证后进行。
