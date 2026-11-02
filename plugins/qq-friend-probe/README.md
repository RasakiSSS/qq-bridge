# QQ 好友能力只读探针

2026-10-25 已完成真实验证：QQ `9.9.26-44343` 没有静态 `.create`，`getNTWrapperSession` 是固定属性；通过可撤回的构造函数导出转发取得 QQ 自己的 session，账号初始化匹配，好友服务上的 `reqToAddFriends` 确实存在。报告 `capability-present / cleanupComplete: true`，未调用申请方法。磁盘临时修改全部回滚，SnowLuma 同账号恢复在线。随后已离线核对请求字段和 Promise 结果结构，并准备下述单次请求观察模式；实际参数取值、发送及长期运行尚未验证。当前 78 项模拟测试通过。详细记录见项目 `docs/QQ_FRIEND_ADD_PROBE.md` 和 `docs/QQ_FRIEND_REQUEST_CONTRACT.md`。

这是独立的 QQ 主进程探针，提供 LiteLoaderQQNT 兼容 manifest，也可以由临时 QQ 启动入口直接加载。本次准备的部署包采用后者。它不是已经接通的好友 MCP；源码默认不启用，没有服务端口、网络请求、自动登录或好友操作入口。

## 它如何工作

1. 临时 QQ 启动入口（或已有 LiteLoader）在 QQ 主程序之前加载探针。
2. 观察 QQ 自己加载 `wrapper.node`，核对版本与 SHA-256。
3. 先观察 QQ 自己调用 `.create()`；该方法缺失时观察 `getNTWrapperSession()`，它的参数不读取、不记录，也不用于认定账号。两者都缺失且导出是函数时，才临时包装可修改的构造函数导出，转发 QQ 自己的普通调用或 `new`。所有路线都保留原始 session 实例，不主动创建会话。三条路线分别报告 `static-create`、`static-session-getter`、`native-constructor`。
4. 观察原始 `session.init(...)` 正常返回，只读取第一个参数中的 `selfUin`，核对它是否属于指定机器人账号。其余初始化字段包括凭据，不读取、不记录。
5. 观察 QQ 自己调用 `session.getBuddyService()`，检查返回服务上的 `reqToAddFriends` 是否是普通函数属性；不执行它，也不执行属性 getter。
6. 得到结论或 120 秒超时后，撤回自己的临时函数包装。若另一个扩展后来替换了同一属性，保留对方的包装并将自身逻辑停用，报告 `cleanupComplete: false`。

临时包装保持原始 `this`、参数对象、返回对象/Promise 和异常，不修改 QQ 的登录监听器或回调。构造分支使用仅包装构造函数的 Proxy；直接 `new` 保留原构造器的 `new.target`，子类构造保留子类 `new.target`。原生实例和服务对象不使用 Proxy，原生实例原型不变。构造函数导出的引用在观察期间会改变，停止时恢复；已被 QQ 缓存的包装引用继续转发原调用但不再观察。模拟测试不能替代实际 QQ 兼容性验证。

固定的静态 `getNTWrapperSession` 使用 `static-session-getter-facade` 路线：复制原生构造函数的属性描述符到独立转发函数，只将副本中的该方法转发到原始方法，并暂时替换可修改的模块导出。保留原生构造器及其全部属性不变，不调用构造器属性 getter；静态方法收到原构造器作为默认 this，显式指定其他 this 时保留它。其他属性保持复制时的描述符和引用，并不保证其他代码后来同时修改两个构造函数时仍同步；需真实客户端验证。

探针自身不调用上述 QQ 方法、不创建第二个 session。模块导出若不可替换，或会话实例的方法无法观察，报告不支持并退出；不代理原生会话或服务对象。

**即使报告 `capability-present`，也只证明捕获到了相符账号初始化的 session 和方法对象。它不证明账号仍在线、请求字段正确或好友申请能成功。** `loginOnlineVerified`、`requestSchemaVerified`、`requestSent` 始终为 `false`。在线状态须另用同账号 SnowLuma `get_login_info` / `get_status` 核对。

## 准备本机包

在 qq-bridge 根目录运行：

```powershell
node scripts/prepare-qq-friend-probe.mjs --wrapper '<正在运行的 QQ 版本目录>/resources/app/wrapper.node' --account <机器人QQ号>
```

从 SnowLuma 当前 `get_login_info` 确定机器人账号，不使用 ownerQQ。脚本生成 `state/probes/qq-friend-probe-*/qq-bridge-friend-probe/`，包括单独的 `config.json`、代码和说明；同级 `preparation.json` 记录文件哈希。该目录已由项目的 `state/` 规则排除在 Git 外。

源码目录没有 `config.json` 时不启用。生成包中的 `enabled: true` 只在该包以后被 QQ 加载时生效。准备脚本不会安装加载器、修改 QQ、连接服务或重启程序。120 秒内尚未登录则会超时退出；可在后续准备时明确修改本地超时配置，范围 1–300 秒。

## 可选：观察一次指定目标的 QQ 界面申请

准备时添加 `--observe-request-target <测试QQ>`，仅对已经指定的测试对象使用。此模式锁定 `9.9.26-44343` 及已经核验的 SHA-256，将等待时间设为 30 分钟；本机 config 增加 `observeRequestTarget`。报告提供 `observationWindowMs` 和绝对时间 `observationExpiresAt`，实际发送前应确认仍 active 且剩余足够操作。匹配结果、身份失效或异常仍会提前结束，不会持续发送。未提供此参数仍是原能力探针，其最长 300 秒限制不变。

它观察 QQ 自己的第一次匹配申请，保持参数、this、Promise 和异常，不自动发送、重试或改写请求。登录账号不符、重新初始化或超时会停止；某组接口无法包装时报告原因，双入口模式可继续观察另一组。同账号多个已观察的服务引用均有效，重新初始化时统一失效。报告只记录固定字段类型、少数整数/布尔选项和返回码，不保存任何请求文本或验证票据。Promise 拒绝仍传给调用者；观察器附加拒绝回调会影响未处理拒绝统计。

此模式使用格式 4；`waiting-target-request` 表示已有请求观察器可用；`waiting-request-result` 表示已观察到调用，等待本地 Promise；`request-result-observed` 表示取得返回码，**不等价于已成功发送或成为好友**。`requestSent` 为 null，`probeInitiatedRequest` 始终 false。其余故障 phase 以 `request-` 或 `unsupported-request-hook` 标识。能力模式的状态含义保持原样。

添加 `--observe-add-buddy` 可同时观察 `getAddBuddyService().addBuddy(context, req, bytes)`，等待 QQ 自己取得服务，不主动调用 getter。报告以 `requestRoute` 和 `requestDiagnostics` 区分两组接口及未匹配原因。可用 `--target-identity <本机JSON>` 提供经只读核对的 `{botUin,targetUin,targetUid}`，让 UID 目标在 UIN 缺省/为零时仍能匹配；明确身份冲突则不捕获。UID 和请求上下文/票据不进入报告，固定计数每项最多 1000。新版全部 90 项模拟测试通过，详见项目 `docs/QQ_ADD_BUDDY_ROUTE.md`。

字段契约和维护前后操作详见项目 `docs/QQ_FRIEND_REQUEST_CONTRACT.md`。请求契约模块不会自行校验磁盘或取得 session；真正运行时仍由 `main.cjs` 校验模块哈希和版本。不能把传入契约函数的 context 当作独立的安全认证。

## 当前离线适配边界

### 可选：只读检查同版本客户端代码

准备时添加 `--inspect-client-code`，无需 `--observe-request-target`。准备脚本记录同目录 `application.asar` 的 SHA-256。QQ 主进程匹配 wrapper、版本和指定账号后，逐文件读取这个归档中的静态 JavaScript，只保存 `addBuddy` 等六个固定标识符附近的代码片段，写入单独的 `client-code-*.json`。不执行静态文本、不读取用户目录、不调用原生业务方法、不发申请。此报告含客户端静态源码片段，存放在被 Git 忽略的本机包目录，区别于只含类型元数据的请求报告。

整个归档的哈希和索引使用 Electron `original-fs` 读取，成员使用普通 fs 的 ASAR 支持；不切换全局 `process.noAsar`。失败报告只保留固定阶段和允许列表内的错误码，不输出异常正文或路径。这样可区分归档读取、哈希、索引和成员读取问题。

读取会让出主循环，并受 30 秒、1000 文件、40 MiB 总读取量、4 MiB 单文件和 48 个片段限制。链接、unpacked 文件、路径穿越和归档哈希变化均拒绝。若 QQ 文件接口仍返回密文，报告会记录二进制/失败计数；没有片段不能证明方法不存在。真实可读性尚待验证，离线测试不作保证。包依然通过原三文件临时维护部署，结束后回滚，不永久改变 QQ 的校验和启动方式。

`friend-adapter.cjs` 只提供一个版本锁定的策略边界，固定 QQ `9.9.26-44343` 和 wrapper SHA-256 `29de02c5bec028643fc5d597e269f15be8bc75f7ea1620e53b50c6ff900288f2`。默认配置是 disabled；启用时必须再次提供这两个 pin、已核验的机器人 QQ 号和非空 `allowedTargetUins`。它只支持 observe 或 dry-run，拒绝 `send` 模式、未知 action、未知字段、Proxy、accessor、越权账号、未限制的目标和不带幂等键的计划。

它没有 native service 引用、通用方法名分发器、`invoke`/`call`/`send` 方法或发包入口。dry-run 只返回 `requestSent: false` 的受限计划；在已确认的群临时对话分支上，`buildEnvelope()` 还可生成离线客户端 envelope，但仍标记 `invocationVerified: false`，不会调用 native。`dryRun: false` 始终因 native AddBuddy 完整请求契约尚未验证而拒绝。返回 `{ result: 0, errMsg: '' }` 仍被标记为 `businessSuccessKnown: false` 和 `relationshipChanged: false`。该模块不接入 bridge、SnowLuma action 或 MCP；离线测试见 `scripts/test-qq-friend-adapter.mjs`，构造证据见 `docs/QQ_ADD_BUDDY_STATIC_BUILDER.md`。

## 本轮继续工作的边界

当前 AddBuddy 观察证明了 QQ 界面使用的服务入口和一次真实返回形状，但尚未证明第三参数字节向量、第一参数业务含义、来源/验证取值或业务码语义。适配边界因此停在只读和 dry-run；任何真实发送、接受/拒绝申请、删除好友或退群都需要独立的版本化契约、结果核验和权限集成。

## 本次准备的直接启动方案

`scripts/prepare-qq-probe-deployment.mjs` 只在已生成包的 `deployment/` 内创建备份、候选文件和 `plan.json`，不写 QQ 安装目录。它要求提供实际 `resources/app` 路径、已准备的包路径，以及预先核对的原始 `QQNT.dll` SHA-256。

候选变更共三处：

1. `QQNT.dll`：按上游公开补丁特征，在唯一匹配的可执行区内将一条 5 字节指令改为校验返回成功。准备脚本只生成修改后的副本，原件逐字节备份。**部署该副本会改变 QQ 文件完整性校验行为。** 本次临时维护已验证能启动 QQ，结束后已恢复原文件。
2. `resources/app/package.json`：只将 `main` 指向 `./app_launcher/qq-bridge-probe.cjs`。
3. 新增 `resources/app/app_launcher/qq-bridge-probe.cjs`：先尝试加载独立探针，再进入 QQ 原启动程序；探针加载失败时仍继续 QQ 启动。原有 QQ 启动文件不修改。

每个文件的原始和候选 SHA-256、实际目标、备份位置及二进制修改偏移都记录在 `plan.json`。部署前必须重新验证实际文件仍与原件哈希一致，若 QQ 升级或文件变化则重新准备。两个 QQ 实例共用同一安装目录时，二者都需在维护时段退出，避免替换正在使用的 DLL。

此方案无需安装完整 LiteLoader，也不会启用其 UI 或其他插件。已下载的官方 LiteLoader 1.4.1 包仅作为加载过程核对材料，未被执行。QQ 与 SnowLuma 的实际共存稳定性仍需维护测试。

## 部署前的必要条件

- 此版本已做一次短时 QQ/SnowLuma 共存验证，不应把它或模拟测试当作跨版本兼容和长期稳定性验收。
- 当前 QQ 启动文件仍是原始 `./application.asar/app_launcher/index.js`，不假设已安装 LiteLoader。
- 已准备 QQ 启动配置及校验 DLL 的原始文件备份、哈希和候选清单；正式应用这三处变更需要明确授权。
- 用户此前要求不要擅自重启生产桥接；QQ 重启也会中断桥接的上游连接，因此本次先准备，再确认维护安排。
- 若 QQ 重启后升级为其他版本，哈希核对失败会停止探针。重新定位实际模块并重新准备；不要取消版本核对来强行运行。

另一种可选加载方式：如果本来已有兼容的 LiteLoader，可将生成的整个 `qq-bridge-friend-probe` 文件夹放入其 `plugins` 目录。在这种情况下，不应再应用上述临时启动方案。不复制到 DSH 的插件目录，也不改 qq-bridge 的模型工具白名单。

## 读取结果

日志只输出完成原因；详细 JSON 位于准备脚本输出的 `reportDir`。每个进程生成独立报告，避免两个 QQ 实例相互覆盖。报告不包含 QQ 号、UID、聊天内容或登录凭据。

| phase | 含义与处理 |
| --- | --- |
| `capability-present` | 已观察到对应账号初始化的 session 和好友方法对象，继续研究请求结构 |
| `account-mismatch` | 此 QQ 进程的初始化账号不符，已退出，不采集其服务能力 |
| `wrapper-attestation-failed` | 版本或模块哈希不符，重新核对实际安装版本 |
| `wrapper-already-loaded` | 插件加载太晚，未捕获 session，不新建会话补救 |
| `unsupported-factory-hook` / `unsupported-session-hook` | 原生属性形状不支持当前观察方式，需要调整适配后再验证 |
| `capability-not-observed` | 返回服务没有可直接读取的目标函数属性；不等价于底层完全没有功能 |
| `timeout` | QQ 没在时限内触发全部观察点，没有运行时验证结果 |
| `observer-error` | 探针内部检查异常，已停止，QQ 原始返回和异常仍照常传递 |

报告格式版本 2 增加 `diagnostics`、`hookFailure` 和 `observationRoute`。报告只包含预先指定的 `dlopen`、module.exports、session 工厂/构造器、create、getNTWrapperSession、init 和 getBuddyService 的类型枚举、原型深度及属性标志。构造函数转发在内存中复制构造器属性描述符，不读取访问器、不枚举会话/凭据对象、不将任意属性名、实际值或异常文本写入报告。

`hookFailure.target` 定位失败步骤，`reason` 区分 `missing`、`accessor`、`not-object`、`not-function`、`fixed-property`、`non-extensible-target`、`inspection-failed`、`define-failed`、`depth-limit` 和 `invalid-target`。非 configurable 但 writable、或非 writable 但 configurable 的方法仍能按原属性描述符观察并恢复；两项皆 false 时停止。

写报告失败不会传播进 QQ 调用。若报告缺失，查看终端固定错误提示和路径可写性，不要转储 session 或整个初始化对象来排错。

## 撤回

运行时成功、失败或超时都会停用探针并尝试恢复自己的包装。**函数包装撤回不会自动恢复磁盘上的启动文件或校验 DLL。** 本次维护验证结束后，需要退出共用该安装目录的 QQ 实例，将 `deployment/backup/` 中的 DLL 和 package.json 按 `plan.json` 恢复，核对原始哈希，并移除本次新增的那一个启动入口文件，再正常启动 QQ。不要删除 QQ 用户数据、登录状态、聊天记录或 SnowLuma 配置。候选方案不是永久部署好友功能。

## 已核对的上游接口

- [LiteLoader 插件 manifest v4](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT/blob/1a8c9707c3673e0491445a1d6d7a86f0a1aa8000/manifest.schema.json)
- [LiteLoader 在 QQ 主程序前加载插件](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT/blob/1a8c9707c3673e0491445a1d6d7a86f0a1aa8000/src/main.js)
- [NapCat 的原生模块加载观察点](https://github.com/NapNeko/NapCatQQ/blob/3420f0b76d7dc0ac92cde1663f21ea27f61e13bb/packages/napcat-framework/napcat.cjs)
- [会话初始化参数中的 selfUin](https://github.com/NapNeko/NapCatQQ/blob/3420f0b76d7dc0ac92cde1663f21ea27f61e13bb/packages/napcat-core/wrapper.ts)
- [QQNTFileVerifyPatch 公开的 x64 校验补丁](https://github.com/LiteLoaderQQNT/QQNTFileVerifyPatch/blob/f62c9bc7bc50cb0655d9a0bd6a4db0d21fc2d8d4/QQNTPatcher/QQNTPatcher/main.cpp)

上述源码只用来确认入口和字段，不代表跨版本兼容承诺。探针独立实现，不额外新建 session；只替换单个可修改的构造函数导出，不代理整个原生模块、session 或服务对象。
