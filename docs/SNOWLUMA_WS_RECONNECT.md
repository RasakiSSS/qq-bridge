# SnowLuma WebSocket 重连修复（2026-10-25）

2026-10-26 09:55:27（北京时间）：主动加好友临时维护已完整回滚，用户已恢复 QQ。
生产状态 DSH 就绪、paused=false、accountOnline/good=true，但 connected=false。
需重新确认 WS 是否自动恢复；没有重启桥接或 SnowLuma，不能只凭账号在线报告消息链路正常。
09:56:53 再查仍 connected=false，accountOnline/good=true，silent/degraded=false。因额度剩余 13% 已交接，未开始新的修复。

2026-10-26 03:28:25（北京时间）继续工作的只读核验：生产连接、账号在线、good 均为 true，
最近事件约 8 秒前、来源 heartbeat，silent/degraded 均 false，DSH 就绪。本轮没有重启生产服务；
仅凭在线状态不能判断磁盘修复是否已被现有进程加载，以下修复测试与原部署记录仍分别保留。

握手失败不再永久挂起 `connect()`；旧 socket 的迟到事件不会清空新连接。
实现位于 [snowluma-websocket.js](../src/snowluma-websocket.js)，
[桥接入口](../src/bridge.js) 已接入这个适配器。SDK 的消息解析、OneBot 请求和事件中间件继续复用。

## 证据和运行状态

- 在 Node **v22.23.2**、`@snowluma/sdk` **1.14.20** 下，用本机临时 HTTP 服务返回
  `401 Unauthorized`。原 SDK 250 毫秒后只有 `error`，没有 `close`；连接 Promise
  未结算、`connectPromise` 仍存在、没有重连计时器，socket 为 CONNECTING。
  这验证了一个真实停滞机制，不能单独证明之前每次生产断线都由它引起。
- 2026-10-25 **22:37:30（北京时间）**，生产 `/api/status` 已显示
  `connected=true / accountOnline=true / good=true / silent=false / degraded=false`，
  最近群消息约 6 秒前。生产链路自行恢复，本轮没有重启 QQ、SnowLuma、桥接或 DSH。
- **22:49:42**，修复客户端对真实网关完成只读验证：先核对机器人身份，连接并调用
  `get_login_info`，立即关闭/重连，再核对同一账号，随后收到
  `online=true / good=true` 的 heartbeat。未发送聊天消息或好友申请。
- 真实探针验证在最后的竞态补充前完成；最后补充由以下隔离测试验证。
  现有生产进程仍使用启动时加载的旧代码，**本修复尚未在生产进程中加载**。

## 连接生命周期

`ReliableSnowLumaWebSocketClient` 继承 SDK 客户端，接收原构造参数；新增
`connectTimeoutMs`，默认 **10000** 毫秒，必须为正的有限数值。
该参数用于客户端构造，不是新增的生产配置项。

- 同一建连中的调用复用 Promise；握手 `error`、`close`、超时和构造失败都结束当前尝试。
- 失败会释放旧监听器、拒绝当前连接及待响应 API 请求，然后按原 SDK 重连配置退避。
  默认 1 秒起步、最多 30 秒，成功后清零重试次数；`reconnect=false` 不自动重连。
- `close()` 取消重试、结算仍在握手的等待者。之后显式 `connect()` 可以重新连接。
- OPEN 转为 CLOSING、但关闭事件尚未到达时，新请求必须先清理旧尝试。
  即使 `requestTimeoutMs=0`，旧 API 请求也不会一直挂起。
- 每个回调校验所属尝试；旧连接的迟到 open/message/error/close 不能处理新请求。
  监听器移除方法可选，移除失败也不能阻止 Promise 结算。
- 先发出旧连接的 close，再通知 transport error，避免错误回调重连后出现迟到 close。
  如果 close 回调已经创建替代连接，则不再通知旧 transport error。
- 解析错误仍由 SDK 处理，不误判为传输故障；传输失败使用固定错误文本，不输出含凭据 URL。

桥接的 token 自愈仍分别处理 HTTP 与 WS 凭据。即时重连改为显式捕获 Promise 拒绝，
错误由已有订阅记录；不会依靠同步 `try/catch` 去捕获异步失败。

## 验证

[生命周期测试](../scripts/test-snowluma-websocket.mjs) 有 **20 项**，包括真实 Node
WebSocket 握手拒绝，以及超时、重连、并发等待、待响应请求、重入回调、旧事件隔离。
加上上游健康 9 项、关系接口/存储 9 项，本轮 **38 项通过**。

```powershell
npm run test:snowluma-websocket
node --test scripts/test-relationship-api.mjs scripts/test-relationship-control.mjs
node --check src/bridge.js
node --check src/snowluma-websocket.js
git diff --check
```

生命周期测试也已加入 [离线审计入口](../scripts/test-audit.mjs)。本轮没有为此重复执行
全部项目审计；其他历史测试结果不计入上述 38 项。

生产加载需另行安排一次经用户确认的桥接重启；恢复后以新连接日志、身份和 heartbeat
核验实际生效。没有修改生产配置、白名单、会话或记忆。
