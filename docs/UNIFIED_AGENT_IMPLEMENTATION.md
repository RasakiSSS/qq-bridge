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

## 2026-10-29 MCP 通信层与主预设

在 `0a6e503` 基础上继续，开工备份为 `codex/backup-unified-transport-20261029`。新增显式启动的 `startUnifiedMcpHttp`，只绑定回环地址，校验 Host、拒绝浏览器 Origin，限制请求体 64 KiB。发现工具也必须通过主 bearer 与已绑定 session 核验；执行请求必须携带宿主工具调用 ID。没有新增生产监听或启动它的配置。

已安装 DSH 自带 MCP 客户端不转发 execution.callId，因此新增只供主预设使用的 `qq-unified-client`。它从真实 ToolRuntime 的 `exec.agent.session.id` 和 `exec.callId` 构造 MCP 元数据，不从模型参数获取身份；禁止 HTTP 重定向，不自动重试工具调用，连接异常不输出 endpoint 或凭据。六工具的 DSH 参数 schema 从同一份 Zod schema 生成。HTTP request ID 不作为动作去重 ID。

主预设 `qq-unified` 已加入 bundle，专用守卫只允许这六个工具以及 todo/四个上下文工具，拒绝旧 SnowLuma、Filesystem、子 Agent、宿主执行工具绕过统一入口。预设标明开发中、动作尚未提供。既有人格源文件与个人角色文件未修改，旧 preset patch 未重新生成；最终人格衔接仍需上线集成时完成。

连接器约定宿主绑定文件为 `state/unified-mcp.json`，结构 `{version:1, sessionId, endpoint, token}`。**尚未编写绑定发布/清理器，未生成真实凭据文件**。后续宿主必须在已验证主身份后原子发布，确认 state 权限及文件工具不可访问该文件；关闭/换身份撤销并清理自己的绑定，不能把凭据放入提示词、模型参数或子 Agent 环境。仅凭此约定不代表权限和生产部署已完成。

完整相关回归 **159 项通过**，新增 6 项覆盖真实回环 MCP、连接器身份传递、取消、主/子会话隔离、吊销、无凭据发现、Origin/Host、请求体预算、静态错误和预设守卫。测试仅使用临时 SQLite、模拟 DSH execution 与回环 HTTP；尚未在真实 DSH 加载新预设，也未发送 QQ。

下一步：完成宿主凭据发布器与生命周期，将 runtime/transport 接入 bridge 的显式统一模式开关，并隔离旧模式调度；接真实动作处理器、管理入口、等待/睡眠、总结、空间通知与历史导入。六工具通信已通，不能将其描述为全功能单 session 已上线。

## 2026-10-29 宿主生命周期与发送链路交接

开工基线 `27796da`，备份 `codex/backup-unified-host-20261029`。本节覆盖前一节已完成项，尚未启动生产统一模式。用户修改的人格源文件及个人角色文件仍未纳入提交。额度从剩余 58% 开始，最后阶段剩余约 25%，预留交接空间，不使用重置权益。

### 本次完成

- `UnifiedMainBinding`：固定宿主路径、当前安装实例所有权回调、文件工具排除回调、目录及文件权限检查；临时文件先为空，权限确认后才写入 secret，fsync 后原子替换。拒绝硬链接、异常路径和非回环 endpoint。清理只删除属于自己 publisher 的绑定。允许取代旧文件的前提是宿主已验证整个安装实例独占，不能仅凭某个账号的 SQLite owner 锁宣称拥有固定绑定文件。
- `startUnifiedHost`：组合 runtime、MCP listener、凭据发布器；不自动 tick/restore、改模式或发送消息。关闭先拒绝新工作、撤销工具凭据，等所有运行方法及 MCP 内部操作结束，再清理自己的绑定、释放数据库 owner。HTTP 客户端断开不代表动作结束；有专项测试覆盖。失去安装所有权时不擅自删除可能属于后继实例的文件，关闭会报告失败，旧 token 已撤销。
- `qq_send_message` 成为第七个主工具，只能持当前场景凭证发送到群聊或私聊，不接收模型填写目标。它使用可信 DSH callId 进入持久动作账本；重复调用返回原回执，参数冲突拒绝，断线/异常保留 unknown，不换 ID 自动补发。普通发送不推进已读。动作执行增加 caller 复核，在异步 prepare 后和最终写入 guard 中均可检测 bearer 撤销。
- `createUnifiedSendHandler` 只组合宿主 prepare/send 回调，**不直接调用 OneBot**。真实回调仍须保留原有工具开关、白名单、静默、敏感信息过滤、审计、限频预占、引用归属、共同发送队列及发送记录，并在每条实际发送前调用 assertCurrent。生产 `bridge.js` 尚未注册这些回调，不要把模拟发送通过描述成 QQ 实发成功。
- 本机 DSH 0.2.1-rc.2 的 schema 校验器不接受 pattern/minLength/maxLength/minimum/maximum/minItems/maxItems。已将 DSH 展示 schema 转为支持的子集，并保留约束说明；MCP 执行仍使用原始严格 Zod 校验。已用安装版真实校验器验过全部输入/输出 schema，不是只用 stub register 接受对象。主预设继续保留“开发中”。

### 验证与限制

完整相关回归 **174 项通过**：原 159，加宿主/绑定/发送 12、安装版 schema 2、断开客户端关闭 1。全部仅为临时数据、模拟 DSH 执行上下文、回环 HTTP 和模拟发送；没有真实 QQ/DSH 请求，没有生产凭据文件或监听，没有修改 ACL。ACL 测试注入检查/加固函数，真实 Windows 权限及真实 DSH preset 加载仍需后续隔离验证。

运行命令是在原 159 项组合后加入 `scripts/test-unified-host.mjs` 和 `scripts/test-unified-plugin-contract.mjs`；`scripts/test-unified-mcp-http.mjs` 已增加断线关闭用例。新源文件应通过 node --check、git diff --check。远端继续仅推送脱敏导出分支，生产 main 历史禁止直接 push。

### 下一次直接从这里继续

1. **生产 bridge 接线是首要未完成项。** 现有安装锁在 `bridge.js` 的 `acquireLock` 附近（搜索 `LOCK_FILE`），统一 host 的 `assertInstallationOwner` 必须验证真实安装独占与旧自动调度已停；固定凭据路径不能被多个账号 host 同时使用。还需保证 workspace 文件工具不能触达 `state/unified-mcp.json` 及临时文件。不要用恒返回 true 的回调接生产。
2. 复用 `/api/socialV2/send-message` 内既有检查与 `sendMessagesV2`/`onebotSend` 共享队列。当前旧发送链没有接受统一场景最终 guard；必须在队列等待和每条实际写入前补入统一 assertCurrent，保留旧检查，不能通过伪造旧 per-chat token 回调旧 HTTP 路由。`onebotSend` 已承担发送后共同记忆记录，避免重复记录。
3. 主运行驱动还缺 OneBot 入站持久化与唤醒判断、DSH 帧转交、定时 tick、手动暂停、管理命令/控制台，以及旧模式定时器/黑话/记忆/空间模型入口的统一互斥。主菜单消息和当前场景等待/有限睡眠尚未实现。
4. 后续接文件、关系、空间、记忆/总结 worker、旧记录导入与回滚演练。旧预设及现有生产功能没有改动，不要通过打开开发中 preset 直接切生产；完整人格衔接也尚未完成。

## 2026-10-29 桥接入口交接

本轮从 `12ef010` 继续，备份 `codex/backup-unified-bridge-20261029`。额度刷新后开始，剩余 22% 时收尾。本节替代上节“bridge 完全未接线”的状态；**仍未启用生产，也不是完整功能验收**。

### 已接线的范围

- `bridge.js` 增加启动时固定选择的开发开关 `socialV2.unified.enabled`，默认缺失即关闭。开启还必须明确填写现有共享 QQ 工作区的 `workspaceId`，不会自动创建/搬迁工作区。没有修改本机 config.json，热保存配置不切换运行所有权。
- 新 `bridge-driver.js` 管理宿主初始化、每秒 tick、首次恢复、帧转交、关闭和一分钟错误日志节流。DSH 离线/人工暂停时可先把新消息保存在统一 SQLite；就绪后启动同一个主会话。tick 合并并发，关闭期间不能继续初始化/投递。主峰谷规则继续由场景/调度层实际执行时检查。
- 可信 OneBot 回调进入统一收件箱，保留消息 ID、发送者、原文和媒体元数据，重复 message_id 去重。沿用旧概率/@/提问/关键词判断，引用机器人也可触发。重连时等待登录身份查询，失败不使用旧账号身份；账号切换后旧 host 拒绝工作，需交接重启。旧模式入站路径保持原样。
- 主 DSH 事件进入原 token 账本及统一运行器；旧 session 的完成事件不再获得 QQ 发送权。`beforeSession` 在创建/恢复前检查旧已知 QQ/空间/学习会话没有运行或排队；未知状态拒绝，不取消、归档或删除旧任务。
- 新 `bridge-send.js` 复用原目标白名单、sendMessage 开关、静默、敏感信息和已知令牌过滤、消息长度/数量、限频、引用归属、共同 sendChain、发送记录与记忆记录。异步引用后/排队后/每条写入前复查权限；新模式批量中途失败后不再发送后续条目，部分成功记录一次，账本 unknown 不自动重发。
- 旧逐聊天创建与最终 prompt、旧唤醒/潜水/主动检查入口、旧后台整理/空间模型被挡住；旧 MCP 的 x-agent-call/x-agent-token 在控制台集中入口拒绝。旧队列、会话映射和未读文件保持原样，不自动消费/迁移它们。
- owner 私聊 `/permission` 和已鉴权 `POST /api/unified/permission` 接通；控制台请求通过现有 token/Host/Origin/content-type 检查后，用宿主 WeakSet 传递身份，模型无法设置它。原人工暂停通过可信 context 约束统一运行，不被低谷恢复覆盖。新模式暂拒绝旧三个 session/workspace/socialV2 reset API，防止旧控制台重置错误的数据集。
- 统一凭据只在验证后的主身份绑定时发布，复核安装 PID 锁、受限工作目录及旧管理员 Filesystem 根不包含凭据路径。正常 SIGINT/SIGTERM 先撤权并等待宿主关闭，再释放安装锁。没有创建真实凭据、调整 ACL 或打开生产新端口。

### 测试与仍需完成

统一组件组合 **188 项通过**（原 174，加真实 bridge 夹具集成 8、发送策略 6）。`audit-bridge-harness` 执行实际 bridge 初始化/处理函数，但替换网络、ACL 和远端 DSH；测试涵盖入站到 MCP 到原发送队列、重复输入/发送、暂停/离线积压、旧调度互斥、权限命令、控制台鉴权/旧入口拒绝、限频与引用、部分发送和保存失败不重复记账。旧 `test-audit-regressions.mjs` **16 项通过**，`test-hardening.mjs` 通过。没有实发 QQ，没有真实加载 DSH 主 preset，没有测 Windows 实际 ACL，也没有做生产切换/回滚演练。

下一步优先实现 **统一等待/唤醒配置和持久定时器**，然后空间通知采集/动作、全局文件/好友工具、共同记忆与按需总结。开发入口目前只接新消息和七个主工具；旧未读/潜水/定时任务尚未导入，旧聊天人格及用户当前角色尚未完整注入主会话。新模式的空间入口当前拒绝，不能声称“已保留全能力”。旧模式在开关未开启时继续原行为。

需要重点补验：完整启动与重连顺序（现有集成夹具在注册消息监听前截断）、旧后台工作身份盘点、凭据 ACL/安装锁在真实 Windows 的失败路径、配置/账号变化时的长期恢复、原 `/role` 等管理命令在新入口的兼容。新入口只特殊处理 `/permission`，其余旧聊天命令当前会作为聊天资料入库，不会执行旧 `/reset`；上线前应明确兼容行为并回归。

供后续开发了解配置形状，**现在不要启用日常运行**：

```json
{"socialV2":{"unified":{"enabled":false,"workspaceId":"现有共享QQ工作区ID"}}}
```

启用/停用需要桥接重启，安装新主预设还需 DSH 加载更新后的 bundle。生产实例本轮没有重启。继续仅将已提交代码导出到远端开发分支，不推生产 main 历史，不加入用户人格修改或个人角色文件。

## 2026-10-29 等待、定时器与空间接线交接

从 `79c570a` 继续，开工备份 `codex/backup-unified-wait-20261029`。本节是最新状态，替代上节“等待与空间完全未接通”的描述。仍保持开发开关关闭，没有修改生产配置、重启进程、加载真实 DSH 预设或实发 QQ/空间内容。

### 已完成

- 主工具扩为 13 个：原 7 个，加 `qq_wait_for_events`、`qq_wait_for_messages`、`qq_set_wake_config`、`qq_qzone_publish`、`qq_qzone_comment`、`qq_qzone_reply`。安装版 DSH schema 校验通过；只重建新主预设 patch，用户正在修改的旧人格和个人角色没有纳入。
- `attention.js` 将长等待改为持久保存等待状态并返回 `yield`，主预设要求结束回合，不循环调用；模型最终是否遵循让出指令仍需真实 DSH 验证。桥接不会用常驻子 Agent 等消息。
- 当前场景短等待默认合并 1.2 秒，`quietMs` 和整次等待均硬封顶 12 秒；思考期间已经过去的静默时间计入，其他可唤醒场景有事件时立即返回。100 毫秒检查期间持续复核凭据、暂停、场景和工具开关。整次截止使用单调时钟，系统时钟回拨不能延长等待。返回当前真实未读批次及精确回执，不推进已读、不退出场景。
- 新唤醒配置保存在统一 `scenes.preferences.wakeConfig`，未设置时从旧配置读取默认值。真实 bridge 入站已读取新配置后调用原 `evaluateWakeTriggerV2`，不另造概率/关键词算法，不改旧模式配置。私聊原本总能触发的语义保留；有限睡眠上下限复用可信配置。
- SQLite 增量升级到 schema 3，增加 `attention_waits` 和 `wake_timers`。有限睡眠到期仅原子生成一条普通调度事件；手动暂停、峰期隐藏、白名单和静默仍由实际投递时复查。重启/重试不反复生成到期事件，编辑关键词不重新启动已触发的定时器，取消仅取消旧的未通知合成事件，不清除聊天消息。设置配置本身通过可信 DSH callId 动作账本去重。空间不允许设置独立有限模型唤醒定时器。
- `qzoneService.collect` 与旧 `run` 分开。统一模式只构造空间服务，不构造 `qzoneAgent`；30 秒心跳遵循原 `eventPollIntervalMs` 采集，不调用模型决策、不执行自动发送、不推进旧模型定时器。普通好友动态只落库，新评论和 @ 按设置成为全局唤醒事件；自己的说说继续自动已读，评论独立保存。
- 空间采集按稳定原始来源 key 的摘要写入统一收件箱，重复轮询/部分投递失败后重试不会复活已读或重复投递。覆盖全部保留的 pending feeds 和 new comments，不能只交付旧 snapshot 前 20/50 条而导致后续条目饥饿。采集不把原空间评论自动标为已读。DSH 离线和峰期可采集；人工暂停、静默、模式关闭、QQ 身份未就绪则暂停采集。
- 进入 `qzone` 后可由主 Agent 发说说、评论、回复和 @。使用原空间服务的内容审计、好友可见、额度/间隔、已读来源目标、@ 用户范围、预记账与 uncertain 保护；同时进入统一动作账本，调用重试不重复发送。内部 WeakSet 上下文核验与当前场景凭证防止旧入口借道；每次 QQ 读取/写入前复核，账号必须与主运行器一致。旧服务在实际写入后的失败统一保持未知，只有明确写入前的参数/权限/预算拒绝记 rejected，结果不泄漏原始远端错误。
- 主工具现接通旧工具开关，在排队后和最终动作授权时重新校验。空间关闭读取能力会使空间场景失效。关闭统一宿主时先拒绝新工作，同时等空间采集与在途工具结束。

### 验证

统一组件、实际 bridge 测试夹具、旧空间与空间会话组合 **252 项通过**；旧 `test-audit-regressions.mjs` **16 项通过**；`test-hardening.mjs` 通过。测试使用模拟时间、临时数据库/JSON、模拟 QQ 与 DSH、回环 HTTP。沙箱下旧回归曾因回环连接被拒与临时文件替换被拒失败，获批在沙箱外复跑通过；没有为此调整生产权限或文件。

组合为上节 188 项的全部测试文件，加 `scripts/test-unified-attention.mjs`、`scripts/test-qzone.mjs`、`scripts/test-qzone-session.mjs`。既有文件新增桥接/运行器/工具开关用例。注意 `node --test` 的回环测试需允许本机网络，单纯沙箱 EACCES 不应改成弱化测试。仍需真实 DSH 加载、Windows ACL 和完整启动/重连验证。

### 下一步

1. 优先接全局 v2 好友关系工具、v3 受限文件代理；菜单也能调用，权限等级和可信管理员命令规则必须保留。不要把旧管理员 Filesystem MCP 直接挂到主预设，也不要放开宿主执行。
2. 补空间按需主动刷新/状态工具、统一状态在控制台的显示。当前依赖采集周期获取动态，主工具可读已采集内容并行动。空间原状态与统一收件箱各有回执：原 pending/comments 会在以后轮询重复提供，统一层去重；需要后续按精确回执优化，不能通过全量清空旧空间状态解决。
3. 共同记忆、按需总结 worker、完整人格与旧命令兼容还未接通；旧 `/role` 等仍不能按完整新模式验收。
4. **旧未读、历史会话和已经存在的有限睡眠/主动检查任务尚未导入。** 新建统一定时器可恢复，不等于旧定时器已迁移。需制定账号核验、快照备份、精确已读映射与回滚演练；不要删除原 social-v2 或 qzone 状态。全局主动机会、回复检查也尚未替代旧逻辑。
5. 复核完整 QQ 登录/重连和配置变化、真正的主 session 身份、凭据 ACL/安装锁、峰期空间边界、故障下长期恢复。现有 harness 在注册消息回调前截断，不能代替完整生产启动验证。

保留用户未提交的人格与个人角色文件；继续只推脱敏导出分支 `codex/unified-agent-20261028`，不推生产 main 历史。下次先读 `state/probes/remote-backup.json` 和本节，再继续；额度剩余低于 20% 时保存交接并按最新重置时间安排本聊天续作，不使用重置权益，不自动重启生产服务。

## 2026-10-30 全局关系与文件入口交接

从 `10dd9da` 继续，开工备份 `codex/backup-unified-global-20261030`。本节是最新交接。5 小时额度从 98% 开始，剩余 24% 时开始收尾；周额度此时剩余 5%。没有使用重置权益。生产统一开关保持关闭，没有重启 QQ、DSH、桥接或部署原生插件，没有发送真实好友申请、QQ 消息或空间内容。

### 本轮已实现

- 主 MCP 增至 20 个工具。新增全局 v2 的申请列表、接受/拒绝申请、删好友、退群、主动申请，以及全局 v3 的 `qq_workspace_file`；不要求先进入聊天场景。保留原关系总开关、分动作开关、人工暂停、静默、真实登录账号校验和统一动作账本。成为好友不自动修改聊天白名单，关系操作不删除历史或重置主会话。
- `relationships.js` 将可信 OneBot 好友申请按机器人账号落入 SQLite schema 4，使用不透明申请 ID，原始网关 flag 不返回模型。重复事件去重，接受/拒绝前先持久记录 unknown，网络结果丢失后即使换 callId 也不能重复处理同一申请。原来未绑定账号的 JSON 申请记录没有盲目导入。
- 主动申请复用已验证的原生服务和共同群来源。operationId 从真实主 session/callId 派生，不由模型指定。原生回调只得到短期、精确绑定目标/群/说明/operationId 的独立授权；不能取得主 MCP bearer。现有控制台鉴权后再验证授权，每次回调复核权限、账号和开关，调用结束即撤销。原生客户端增加 expectedAccount 校验；旧逐聊天调用保持兼容。
- **原生插件只修改了仓库源码 `production-main.cjs`，未部署到 QQ 安装位置。** 后续启用统一模式前必须按既有维护流程更新实际插件，否则统一主动申请会被旧回调拒绝；本轮绝不为此重启 QQ。
- `files.js` 通过既有管理员 Filesystem 安装提供受控代理，读取可信旧预设中的命令和根目录，不复制或扩大根，不给模型直接 Filesystem/宿主执行权限。每次启动标准输入输出子进程，启动后再次校验 v3、暂停、令牌、配置、路径；结束关闭。模型只能给相对路径和固定操作，不接受命令/端点/额外根目录。拦截越界、盘符/流、设备名、路径中的符号链接/NTFS junction、硬链接；根目录不能覆盖主凭据、Node 可执行文件或 Filesystem 脚本。Fileserver 自身继续执行路径隔离。
- 文件工具支持 11 种操作：文本读取、多文件读取、目录列表及大小、目录树、搜索、元信息、根目录编号、创建目录、写入、编辑。原管理员媒体读取尚未映射到统一工具，不能声称全量旧文件功能已经迁移。返回文本最多 12000 字符且 JSON 字节上限 24000，并明确 truncated；只接受文本返回，原始服务错误不回传模型。写入经真实 callId 账本去重，失败结果保守 unknown。
- 文件请求来源的语义判断仍由主 Agent 按已确认规则执行：普通群友/非管理员私聊的文件要求拒绝；可信 owner 私聊/控制台请求和真正自主操作可用。程序强制全局权限、凭据和资源范围，不增加“证明自主意图”的专项机制。尚未做真实模型行为验收。
- 只重建新 `qq-unified` patch；旧用户人格修改与个人角色文件完整保留在未提交状态。

### 验证结果

相关组合 **282 项一次通过**，随后增加桥接文件入口权限/静默用例，重跑桥接和文件 **21 项通过**，累计 **283 项**。组合是在上一节 252 项基础上增加 `test-unified-relationships.mjs`、`test-unified-files.mjs`、`test-native-friend-mcp.mjs`、`test-qq-friend-production-entry.mjs`、`test-relationship-control.mjs`、`test-relationship-api.mjs`，并扩充 bridge 集成。

覆盖菜单操作、v1/v2/v3、账号交叉事件、重复投递/执行、未知结果不重发、异步期间降权/暂停/撤销、单次授权绑定/过期/撤销、主令牌不能替代授权、真实 bridge 回调、文件路径与链接反例。文件测试实际启动了本机已安装 Filesystem MCP，但根目录只给临时测试目录，完成创建/写入/编辑/读取，未操作生产数据。其余网络均为模拟网关或本机测试回环，DSH 仍是夹具。

旧 `test-audit-regressions.mjs` **16 项通过**，`test-hardening.mjs` 通过；改动脚本 `node --check`、`git diff --check` 通过。仍未验证真实 DSH 加载、主凭据 Windows ACL、完整启动/重连或生产切换。

### 下一轮优先项与限制

1. 补空间按需刷新/状态工具；然后共同记忆、总结 worker、完整人格和旧命令衔接，以及旧未读/历史/定时器迁移方案。上一节未完成项仍适用，不要开启生产统一模式。
2. 好友申请目前由专用列表查询；尚未作为菜单计数/独立唤醒事件呈现。需要制定全局通知与峰期隐藏规则，避免把普通好友申请伪装为 owner 私聊唤醒。删好友/退群保留历史，但成员关系变更后的菜单场景可用性尚需完整刷新机制；不能以清空历史代替。
3. 文件代理目前文本优先，媒体读取未接；大文件虽限制返回上下文，Fileserver 读取本身仍可能耗时，应补按需分段策略。外部本地进程同时修改文件系统不属于模型身份隔离，真实 Windows 链接/ACL 及部署目录仍需隔离验证。
4. 关系原生插件新回调待部署，生产插件状态不能从仓库代码推断。保留旧模式兼容和真实申请已验证事实，不再次发送测试申请。
5. 下次先检查 5 小时及周额度。周额度已接近耗尽，普通使用不允许时等待最新恢复时间，不使用重置权益。继续只推脱敏导出仓库开发分支，生产 main 历史禁止 push。

## 2026-10-30 空间按需读取交接（09:25 续作）

从 `7bcb478` 继续，备份 `codex/backup-unified-qzone-20261030`。开工 5 小时剩余 99%、周剩余 3%；开发期间周剩余降至 2%，因此完成这块后优先保存，避免周额度耗尽丢失交接。未使用重置权益，生产状态未改变。

- 新增 `qq_qzone_status` 与 `qq_qzone_refresh`，主工具合计 22 个。要求已进入 qzone 并持有有效场景凭证，沿用 qzoneRead 开关、暂停、静默、账号核验和动作账本。峰期不能借此新进入空间；已经进入的场景保持既定规则。
- status 只返回账号、发布额度/间隔/不确定状态和评论支持，不暴露旧快照里的动态预览、原始错误或历史写入记录。
- refresh 按已有配置浏览好友首页和指定 QQ，通过与后台采集相同的投递函数进入统一收件箱。明确刷新可越过普通轮询间隔，仍保留采集中互斥、失败退避和人工暂停；idle 不等于成功抓取新内容。不会启动独立空间 Agent，不发送内容，不推进已读。相同 callId 返回原结果；新的刷新调用不会复活已经确认的消息。
- 动态正文仍由 `qq_get_unread_msg` 分批读取和精确回执确认，防止旧 snapshot 的 20/50 条截断被误认成完整未读。

相关桥接、旧空间、工具、MCP HTTP 和 DSH schema **68 项通过**（新增 2 项），语法及差异格式检查通过。所有空间请求为测试夹具，无真实 QQ/DSH 操作。未重复全量其他无改动测试；上一节回归结果继续作为基线。

下一步：共同记忆与按需总结、人格和旧命令兼容、旧数据迁移方案；控制台统一状态仍未实现。全局关系通知、媒体文件读取、原生插件部署与完整生产验证仍按上一节保留。不要开启生产统一模式、重启服务或发送测试内容。下一次先检查周额度；若普通使用不允许，应按周重置时间延期，不消耗重置权益。
