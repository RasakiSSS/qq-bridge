# 主动加好友：本机只读验证与后续交接

验证日期：2026-10-24 至 2026-10-25（北京时间）。第一阶段备份为 `84c00b6`；本轮从干净的 `24035a3` 继续。

## 结论与证据级别

**真实运行时访问已验证成功：观察到了指定机器人账号的原生 session、成功返回的 init 及好友服务上的 `reqToAddFriends` 函数。随后离线核对了 14 个请求字段、4 个验证字段和 Promise 结果结构；枚举取值、来源编号和实际发送尚未由探针验证。用户后来报告通过 QQ 界面发送了一次指定测试申请，探针没有捕获匹配调用。QQ 安装文件已全部回滚并核验原始哈希，机器人 QQ 上游恢复在线。**

最新维护收尾和额度交接见 [QQ_FRIEND_REQUEST_HANDOFF.md](QQ_FRIEND_REQUEST_HANDOFF.md)。

当前参数契约、证据地址、指定测试对象及单次请求观察说明见 [QQ_FRIEND_REQUEST_CONTRACT.md](QQ_FRIEND_REQUEST_CONTRACT.md)。下文各阶段的“未验证”描述保留其当时状态。

下表记录第一阶段的静态证据和只读运行状态；真实维护结果见文末。这些结果不是好友功能可用性验收，不能据此上线主动申请功能，也不能把其他项目的声明当成本机调用契约。

| 项目 | 本次结果 |
| --- | --- |
| 当前 QQ 可执行文件 | `C:\Program Files\Tencent\QQNT\QQ.exe` |
| 主进程 | 检查时有两个，均加载 `versions\9.9.26-44343\resources\app\wrapper.node`；PID 会变化 |
| 实际加载的内核版本 | 相邻 package.json 为 `9.9.26-44343`；磁盘上另有 9.9.36，不能把它误认为运行版本 |
| 当前 SnowLuma | 本机 OneBot `get_version_info` 返回 `SnowLuma / 2.1.1-node / v11` |
| 上游状态 | `get_status` 返回 `online: true, good: true`；`get_login_info` 成功，未保存令牌或个人资料 |
| 原生好友服务入口 | 二进制中有 `NodeIQQNTWrapperSession::getBuddyService needs 0 arguments` |
| 主动申请入口 | 有 `NodeIKernelBuddyService::reqToAddFriends`，参数断言为 `argc == 1` |
| C++ 请求类型线索 | 同一模块的修饰符号关联 `reqToAddFriends` 与 `ReqToFriend` |
| 完整 JS 请求对象、返回值、业务结果 | 未验证；不能由 C++ 类型名推导所有字段、默认值、枚举或 Promise 行为 |
| 当前 SnowLuma bundle | 有 `QqHookClient` / `sendRawPacket`，没有 `getBuddyService` / `reqToAddFriends` 字面标记 |
| 运行时访问通道 | 第一阶段未找到；2026-10-25 已通过客户端扩展的 `getNTWrapperSession` 导出转发观察到真实对象，详见文末 |

`wrapper.node` 文件大小为 97,233,448 字节，SHA-256：

`29de02c5bec028643fc5d597e269f15be8bc75f7ea1620e53b50c6ff900288f2`

SnowLuma `index.mjs` SHA-256：

`e23ed3d4aa7e01e7f45400a7ffe6b0c4b67bb6d011f776f2fd04b959510435e6`

## 第一阶段未进行运行时验证的原因

QQ 主进程启动参数中没有发现 `--inspect` 或 `--remote-debugging-port`。对已监听的 9210、9211、8082 端口只读请求 `/json/version`，均没有得到有效的调试元信息。这只能说明本次未发现现成入口，不能证明客户端绝对无法调试。

本机 application.asar 中检查到的启动/preload 文件不是可直接阅读的普通 JavaScript，因此没有从这些文件取得请求对象结构。没有加载、执行或修改这些文件。

SnowLuma 公开连接协议包含发包、收包、登录状态、消息回执等操作，没有公开的通用 QQNT 方法调用操作。其原生组件以二进制分发。增加上层 OneBot action 本身不足以取得 QQ 内的 session 对象。bundle 中未找到字面标记也只是辅助证据，不能单独证明所有底层能力不存在。

参考来源（本次核对）：

- [SnowLuma QQ hook 协议](https://github.com/SnowLuma/SnowLuma/blob/main/packages/bridge/src/qq-hook-client.ts)
- [NapCat 好友服务类型声明](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-core/services/NodeIKernelBuddyService.ts)：声明为两个参数，与本机原生断言不符，不直接采用。
- [SnowLuma 主动加好友提案](https://github.com/SnowLuma/SnowLuma/issues/480)：公开版维护者决定不加入该功能；该决定不是技术上不可实现的证明。

## 可复现的离线检查

```powershell
node scripts/probe-qq-friend-add.mjs --wrapper 'C:\Program Files\Tencent\QQNT\versions\9.9.26-44343\resources\app\wrapper.node' --snowluma-home 'C:\Apps\SnowLuma-v2.1.1-win-x64'
```

脚本只读取文件并打印哈希与标记，不加载原生模块、不连接网络、不读取配置令牌、不附加进程、不发送任何申请。路径应从实际运行进程加载的模块确认；离线脚本本身不会判断哪个版本正在运行。退出成功表示检查完成，不表示主动加好友可用。输出明确保留运行时访问、请求结构均未验证的状态。

已执行脚本语法检查、实际模块扫描，以及四项人工构造数据检查：缺少绑定标记、重复断言去重、冲突参数数量、C++ 类型标记。生产业务代码未调整。

## 后续实现路线

1. 已定位旧探针失败原因：本机构造函数无 `.create()`；QQ 使用的静态 `getNTWrapperSession` 又是固定属性。通过替换可修改的模块导出、保留原生函数的转发方案完成了真实验证，不需要继续重复这轮入口探测。
2. 已观察到 QQ 自己取得并初始化的 session，校验 `selfUin` 与指定机器人相符后才检查好友服务。没有额外创建 session、调用 `reqToAddFriends` 或修改登录监听器。探针只保存能力元数据，结束后不保留可供外部调用的 session/服务对象；它还不是长期运行的好友适配服务。
3. 已从本机转换实现确定单个对象的字段、类型和返回结构；继续观察 QQ 界面针对指定测试对象的真实调用，确认枚举、来源编号和结果。不要用猜测字段/空参数调用生产服务来试错；不能直接套用 Android 结构或 NapCat 的两参数声明。
4. 确定契约后，才实现 `qq-bridge → 自用 SnowLuma action → 客户端适配模块`。仅暴露专用功能，不给 bot 开放任意方法执行或任意发包能力。
5. 用户已指定 `123456789` 为单次真实申请测试对象；准备时确认不在机器人好友列表。随后用户在 QQ 界面操作一次，探针未捕获匹配调用，详见最新交接。后续先确认申请/好友状态，区分“请求发送成功”和“对方接受成为好友”，不重复发送。

按客户端扩展路线部署通常涉及 QQ 维护重启。本次用户明确同意临时修改文件完整性校验与启动配置，并亲自退出、启动登录及再次退出 QQ；DSH 和桥接未重启。此次维护后已恢复原文件，不应把它理解为允许永久安装或自动发送申请。

## 已确定的产品约束

- bot 可主动申请好友，并自行接受或拒绝收到的申请。
- 新好友仍需管理员手动加入聊天白名单，不自动获得聊天准入。
- 自主删除好友与退出群聊不设保护对象，包括 ownerQQ；这不改变配置中的管理员身份。
- 既有权限、峰谷休眠、人工暂停和会话/记忆持久化规则继续适用。
- 不重置数据或会话，不执行真实删好友、退群或申请操作作为只读探测。
- 五小时额度剩余不足 15% 时做好交接；本文件和离线脚本可作为后续工作的起点。

## 第二阶段：探针准备及模拟测试

继续工作前已将第一阶段报告和离线脚本提交为 `fdae8a5`。

新增 `plugins/qq-friend-probe/`，这是独立的 QQ 主进程探针，同时提供 LiteLoaderQQNT 兼容 manifest。它只观察 QQ 自己的模块加载、session 创建、初始化和好友服务获取；不额外调用任何 QQ 服务方法。观察到的 `selfUin` 只用于和指定机器人账号比较，不进入报告。版本和原生模块哈希不符、账号不符、属性无法观察或超时都会停止探针。

新增工具：

- `scripts/prepare-qq-friend-probe.mjs`：按明确指定的账号及实际模块生成本机独立包，只写项目 `state/probes/`，不安装或启动任何程序。
- `scripts/test-qq-friend-probe.mjs`：29 项测试通过，覆盖调用参数/this/返回值/Promise/异常保持、不同调用顺序、账号隔离、未知身份、只读属性、原型方法、其他扩展钩子保护、超时清理、日志脱敏、版本哈希拦截、入口模拟集成、离线补丁边界及临时启动文件。所有 QQ 对象和原生调用均使用模拟对象；测试没有连接真实 QQ 内核。
- `scripts/prepare-qq-probe-deployment.mjs`：只生成本机副本、原件备份及部署清单，不应用变更、不启动程序。

语法检查通过。已生成本机包：

`state/probes/qq-friend-PACKAGE/qq-bridge-friend-probe/`

目标为前述 9.9.26-44343 模块，账号根据本次 SnowLuma `get_login_info` 的只读结果确定，不使用 ownerQQ。生成的 `config.json` 及准备清单位于被忽略的本机 state 目录；该包后来在下面记录的维护测试中加载。

已完成客户端加载材料的离线准备。本次采用临时启动入口直接加载探针，无需安装完整 LiteLoader。`deployment/plan.json` 列出三处候选变更：QQNT.dll 的 5 字节校验补丁、package.json 的 main 字段，以及新增启动入口；`deployment/backup/` 保存原始 DLL 和启动配置。补丁特征在本机 DLL 中仅匹配一处，且位于可执行区。该方案会改变 QQ 文件完整性校验行为，因此不能在未获准情况下应用。

已下载 LiteLoader 官方 1.4.1 发布包作加载方式核对，SHA-256 与 GitHub 发布记录一致：`3b2d9b7214bdfef16d5007b1f277a9f70688785ba11fc03ef091aa8214cdc343`，未执行或安装。当前目录内两个 QQ 实例共享安装文件，正式维护测试需二者退出；不重启 DSH 或桥接进程，但其 QQ 上游连接会暂时中断。完整部署前提、报告含义与撤回说明见 `plugins/qq-friend-probe/README.md`。

## 真实维护验证与回滚（2026-10-24，北京时间）

- 14:34:40，临时启动入口成功在 QQ 主进程加载探针，版本为 `9.9.26-44343`。
- 14:34:41，报告 `wrapperVerified: true`、`phase: unsupported-factory-hook`、`cleanupComplete: true`。没有观察到 session，没有读取到账号身份或好友服务，`requestSent: false`。用户确认 QQ 能正常启动登录。
- 此结果可能由工厂导出/属性形状或 create 属性限制触发，不能仅凭它断言 create 一定被冻结，更不能断言没有加好友能力。下一次应先改进描述符诊断，避免重复部署同一探针。
- 用户退出 QQ 后，14:35:24 恢复原始 `QQNT.dll` 与 `resources/app/package.json`，删除本次唯一新增的 `resources/app/app_launcher/qq-bridge-probe.cjs`。独立状态检查确认三个目标均为 `original`，DLL 与 package.json 的 SHA-256 与部署前备份完全一致。
- `maintenance-state.json` 为 `installed: false`、`rollbackRequired: false`、`hashesVerified: true`。不存在待回滚的 QQ 安装改动；本地备份和报告保留。
- 未重启 DSH、qq-bridge 或 SnowLuma 服务；未清理会话、记忆、QQ 数据、白名单；未执行申请、删好友或退群。

本地维护资料根目录：`C:\QQBridge\state\probes\qq-friend-PACKAGE`。报告位于 `reports/`，原件备份、候选哈希和维护状态位于 `deployment/`；这些本机文件由 Git 忽略。`plan.json` 和 `preparation.json` 是准备时快照，实际安装状态以 `maintenance-state.json` 及目标文件哈希为准。

回滚后用户已确认重新登录 QQ 并恢复 SnowLuma 连接。随后只读核验通过：`get_login_info` 与预期机器人账号一致，`get_status` 返回 `online: true, good: true`，桥接的 QQ 上游已恢复在线。没有额外发送聊天消息来测试回复。

上次交接时（2026-10-24）五小时额度剩余 12%，曾按用户要求停止新开发；此处是历史记录，当前状态以下文为准。

## 本轮真实验证（2026-10-25，北京时间）

| 轮次 | 本机包目录后缀（均位于 state/probes/qq-friend-probe- 下） | 实际结果 |
| --- | --- | --- |
| 第二次 | `2026-10-24T17-05-55-085Z-272e9655` | `factoryCreate: missing`；构造函数导出可写、可配置；回滚成功 |
| 第三次 | `2026-10-24T17-21-23-732Z-f5a1cf9c` | 观察构造函数 120 秒未捕获 QQ 调用，`timeout`、清理成功；回滚成功 |
| 第四次 | `2026-10-24T17-31-16-137Z-3e6f77f5` | 静态 `getNTWrapperSession` 确实存在，但 writable/configurable 均 false；回滚成功 |
| 第五次 | `2026-10-24T17-39-51-463Z-0fb09fb4` | 01:41:43 报告 `capability-present`；路线 `static-session-getter-facade`；最终回滚成功 |

目录时间使用 UTC，所以目录日期仍是 10 月 24 日；上表说明时间为北京时间。

成功方案只替换可修改的 `module.exports.NodeIQQNTWrapperSession`。独立转发函数复制原生构造函数的属性描述符，将副本上的静态 getter 转发给原始 getter，保持原生构造函数及其固定属性不变。QQ 自己调用 getter 后，探针取得原生 session；它的 `init` 和 `getBuddyService` 在原型上虽然固定，但实例可扩展，因此能添加临时实例方法，原型不修改，停止时删除临时实例方法。没有代理 session 或好友服务对象。

最终报告的重要字段：

```json
{
  "phase": "capability-present",
  "observationRoute": "static-session-getter-facade",
  "wrapperVerified": true,
  "sessionObserved": true,
  "identityMatched": true,
  "initCallReturned": true,
  "buddyServiceObserved": true,
  "reqToAddFriendsPresent": true,
  "requestSchemaVerified": false,
  "requestSent": false,
  "cleanupComplete": true
}
```

探针的 `loginOnlineVerified` 仍为 false，因为它本身不判断在线状态；另外通过同账号 SnowLuma 的 `get_login_info` 和 `get_status` 确认 `online: true, good: true`，在验证期间和最终回滚后的正常启动均检查通过。这是一次短时共存验证，不代表长期稳定性验收。

01:45:02 完成最终回滚。随后独立状态检查确认 DLL、package.json 及新增启动入口三个目标均为 `original`，`maintenance-state.json` 为 `installed: false / rollbackRequired: false / hashesVerified: true`。用户已恢复正常 QQ 使用；本轮未重启 DSH、qq-bridge 或 SnowLuma 服务，未修改生产业务配置、权限、会话、记忆和 QQ 数据。

源码新增属性诊断、三类入口观察与固定静态 getter 的导出转发。最后补强了重新初始化前失效旧身份和旧服务记录的处理，防止重新初始化抛错后误用旧身份。`node --test scripts/test-qq-friend-probe.mjs` 共 51 项模拟测试通过，源码语法检查及 `git diff --check` 通过。真实成功报告对应第五次独立包（含当时的 50 项测试版本）；最后的重新初始化异常补强由新增回归测试验证，未再次部署 QQ。

本轮结束时的下一步是确定参数契约；后续进展已记录在 [QQ_FRIEND_REQUEST_CONTRACT.md](QQ_FRIEND_REQUEST_CONTRACT.md)。目前仍未接入专用 SnowLuma action 和 qq-bridge MCP。不要用空参数或猜测结构调用原生方法。聊天白名单仍由管理员手动维护，不因好友关系自动放行。
