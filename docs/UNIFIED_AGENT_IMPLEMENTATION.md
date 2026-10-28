# 统一主体实施状态

更新：2026-10-28。需求见 [v1.0](UNIFIED_AGENT_REQUIREMENTS.md)，协议依据见 [P1 报告](UNIFIED_AGENT_P1_REPORT.md)。

当前完成 P2 的基础模块、隔离主身份认证及六个 MCP 工具工厂；**没有挂载生产入口，没有启用统一模式，没有迁移或重启任何会话**。现有二代仿真、管理员文件 preset 和 QQ 空间仍按原代码运行。

## 已实现

| 文件 | 内容 |
| --- | --- |
| `src/unified/store.js` | 独立 SQLite 账本；账号级权限和暂停、当前场景代次、偏好、事件去重、真实未读、消息范围回执、总结结果、持久化投递身份；事务、WAL、FULL 同步；错误数据库/版本拒绝打开 |
| `src/unified/scenes.js` | 主菜单、join/quit、场景凭证、逐条动作资格检查、全局等级检查、读取/略过/总结后确认；可信上下文注入；复用 `model-prices.js` 峰谷判断 |
| `src/unified/scheduler.js` | 一个账号一个在途主请求；持久化 sessionId/requestId；准备与投递前复查；明确拒绝退避、未知结果保留、回执关联；有界提示预览 |
| `scripts/test-unified-foundation.mjs` | 模拟时间、模拟 DSH、临时 SQLite 的 46 项基础回归 |
| `src/unified/tools.js` | 主身份凭证签发/撤销、严格参数和固定六工具入口、MCP server 工厂；没有自动启动 transport |
| `scripts/test-unified-tools.mjs` | 7 项认证/异步撤权/MCP 内存 transport 回归 |

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
4. `ensureSession` 必须核验已有 session 的 preset、账号和工作区，并返回指定的同一个 sessionId；不能为“修复错误”新建任意 session。具体生产 DSH 适配尚未实现。
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

1. 将已完成的隔离主身份认证和六工具工厂挂载到可信生产 transport；实现主 preset、主 session/事件关联适配；保持旧模式分支，显式选择才启用。
2. 持久动作账本、运行代次与唯一发送权；接原发送审计/权限/配额，覆盖崩溃后成功与未知结果。完成全局等待、当前场景短等待、有限睡眠和关注项调度。
3. 桥接管理的总结 worker 与全局文件/关系适配；实现管理员 `/permission` 命令的真实入口鉴权，不让模型直接调用内部管理方法。
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
