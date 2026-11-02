# 群临时对话的双入口观察（2026-10-25）

**最新进展：原生申请已真实送达并由用户确认，正式 MCP 代码、测试和安装包已完成；临时修改已回滚。生产启用仍待批准，继续位置见 [QQ_ADD_BUDDY_MCP.md](QQ_ADD_BUDDY_MCP.md)。下方为历史，不要重复探针或测试发送。**

**2026-10-26 09:55 最新状态：** `f142db0` 的维护包已部署、实测并完整回滚，用户已恢复 QQ。
AddBuddy 绑定成功；请求列表监听被同 session 的重复服务 getter 失效，已离线修复并通过 184 项测试。
未发申请、未执行原生预检查、没有待回滚文件；修正版尚未重打包。
桥接最后检查账号在线但 WS connected=false，不能视为消息链路恢复。额度剩余 17% 开始交接，最终剩余 13%，已停止新工作。
后续以 [最新实测交接](QQ_ADD_BUDDY_VALIDATION.md) 为准，下方“未部署”是早先准备状态。

## 2026-10-26 新进度：单次维护验证包准备完成，尚未部署

额度已刷新，本轮开始时剩余 97%；Git 基线为 `76bef58`，已建备份分支
`codex/addbuddy-before-validation-20261026`。生产 09:26:43（北京时间）检查 DSH 就绪、未暂停，
桥接 connected/accountOnline/good 全 true；没有重启任何生产服务。
新增客户端申请列表回调读取、维护组合入口、本机认证控制命令和准备脚本，183 项相关测试通过。
原 getBuddySetting 不提供 pending 的缺口现由 `getBuddyReq` 的客户端列表视图补充，范围明确，未知仍拒绝。
目标 123456789 再次核验不是好友。当前包与实际验证步骤见
[QQ_ADD_BUDDY_VALIDATION.md](QQ_ADD_BUDDY_VALIDATION.md)。目前未部署、未发送，旧段落的“没有验证入口”已过时。

## 2026-10-26 继续：参数映射已核验，执行器与绑定模块完成离线测试

开始前将既有未提交工作备份为 `a223641`。当前参数登记表已重新解析确认 `callFrom/reqInfo/context`，
`nativeMappingVerified` 现为 true；精确的模块、对象和 opcode 定位见
[QQ_ADD_BUDDY_STATIC_BUILDER.md](QQ_ADD_BUDDY_STATIC_BUILDER.md)。之前“尚未解析缓存”“字段映射未知”段落为历史记录。

新增本地会话绑定和只读设置查询模块，执行器直接使用真实构造器测试，不再只依赖模拟 mapping=true。
运行时核验实际文件 pin，保留 QQ 自己取得的服务引用，异步查询前后和 native 返回后核对代次。
设置查询 `pending:null` 的信息缺口仍需补齐，主动申请尚未接入生产。没有部署新的 QQ 补丁或发送申请。

北京时间 2026-10-26 03:28:25，生产 bridge `connected/accountOnline/good` 全 true，heartbeat 正常，
`silent/degraded` false，DSH 就绪。未重启生产实例；该健康状态不能证明磁盘上的重连修复已经加载。
用户继续指定测试目标 `123456789`；03:45:39 再次只读好友列表确认该账号已不在列表中。
没有由本轮执行删好友，尚未发出新申请。仍使用原指定来源群 `123456789` 的已验证 `5/2` 路径，
不能将其推广为 QQ 搜索来源。下次实际发送前需再次查状态。

### 本轮交接

实现已提交为 `c4609ac`，提交后工作区干净。五小时额度剩余 17% 时开始收尾，最终复查剩余 **7%**，
已低于用户指定的 15% 边界，停止新开发，仅保存本次交接更新；没有开始新的临时维护。
本轮 **166 项相关测试全部通过**：适配器、执行器、绑定、设置查询、原探针、静态扫描、请求契约和请求观察。
修改模块的 `node --check`、`git diff --check` 通过。没有因文档更新重复运行生产或全项目审计。

下次继续顺序：

1. 检查额度、Git 和 bridge 实时状态，保留用户指定目标 123456789；实际申请前重新查好友状态。
2. 补完整的 `lookupRelationship` 提供者：实际好友列表验证 membership，原生只读查询验证当前设置；
   另需确认待处理申请数据的可用接口与范围。`isContactFriend` 的语义未核实，**不能替代好友列表**；
   `friend-setting` 返回 friend/pending 为 null，不可硬改 false 来让测试通过。
3. 目前新模块没有 main/IPC/MCP 接入，原 `prepare-qq-friend-probe` 仍只准备旧的只读探针文件。
   应先完成独立的验证入口、配置/报告边界及离线组合测试，再准备包含新模块的临时验证包；
   不要直接部署旧包并期待新执行器已启动。用户尚未被要求退出 QQ，本轮没有待回滚文件。
4. 单次验证成功后再设计生产生命周期与既有权限/峰谷/人工暂停接入。send-once 的永久目标预留只是维护验证策略，
   不应作为用户所要求的自主添加、删除、重新添加行为的永久产品限制。新好友仍不自动加入聊天白名单。

## 最新状态：明文扫描完成，改为离线字节码分析

以下较早的“尚未部署”“尚无报告”均是历史状态。修复提交 `612ef10` 的实际包为 `state/probes/qq-friend-PACKAGE`。

- `reports/client-code-36280-1792935734885.json` 于北京时间 21:42:15 完成：137 个 JS 文件全部读为文本，共 11,255,761 字节；读取错误、非文本、跳过大文件均为 0，没有截断，但六个指定标识符均未命中。说明文件读取有效，不能据此认定接口不存在。
- 同轮能力报告 `probe-36280-1792935731789.json` 为 `capability-present`，wrapper 和账号校验成功，`active=false / cleanupComplete=true`。没有发送申请。
- 用户退出 QQ 后，21:57:00 执行 Rollback；独立 Status 确认零 QQ 进程、三个目标均为 original。`deployment/maintenance-state.json` 为 `installed=false / rollbackRequired=false / hashesVerified=true`。用户随后回复已恢复，**当前没有待回滚修改**。
- 恢复后 SnowLuma HTTP 身份验证成功，机器人账号相符。22:11:49 桥接只读状态：`dshReady=true / accountOnline=true / good=true`，但 `connected=false / silent=true / degraded=true`，最近事件仍为约 37 分钟前的 lifecycle。不能把 HTTP 在线当作桥接消息链路已经恢复；未重启任何生产服务。后续需重新核验此状态。

### 已落实的离线 envelope

已根据 `application-service.linear.txt:1307-1382` 的逐条字节码证据加入默认安全的
`buildObservedAddBuddyEnvelope()`。它只生成 `GuildContactAddApplication` 的单参数
客户端 envelope：`targetInfo.uin`、`addFriendSetting=1`、`myAllowFlag=1`、
`showMyCard=1`、`sourceId=5`、`sourceSubId=2`、`myFriendGroupId=defaultCategory`、
空 `Uint8Array` context，以及经 `TextEncoder` 编码的 `name/name1/remark/permissionInfo`。
它没有 native 调用入口，`requestSent=false`，不接入 bridge/MCP。实现和证据边界见
[QQ_ADD_BUDDY_STATIC_BUILDER.md](QQ_ADD_BUDDY_STATIC_BUILDER.md)。

wrapper.node 的 AddBuddy 绑定也已只读确认要求三参数，顺序为 `(string, AddBuddyReq, bytes)`；
离线计划现在同时输出客户端 envelope 和对应三参数值。业务返回码、服务端验证要求和
关系变化仍未确认，不能上线真实发送。


`major.node` 为 89,300,520 字节，SHA-256 `aa23a73baf7cd41ad28969ce0f227789b936093838bb398e16e3e24672ac16f3`。仅从磁盘读取 PE 数据，没有 require/dlopen、执行缓存或调用好友接口。它包含可识别的 V8 缓存头和相关函数/字段字符串；普通 ASAR 中的多个核心 JS 只有几十到几百字节，故继续重跑相同文本扫描没有意义。

- 同一缓存头前缀 `7a05dec00358f272` 在文件中找到 706 处边界内候选；版本哈希 `0x72f25803` 与 **13.8.258.18** 的版本哈希计算相符，QQNT.dll 的静态版本字符串为 Electron 37.1.0 / Chrome 138.0.7204.35。缓存构建标志和 snapshot 仍需匹配，不能强行套用旧版本。
- `[ApplicationService] addBuddy` 位于文件偏移 27,670,237；所在候选缓存偏移 **27,659,536**，payload 长度 **64,544**，32 字节头。附近包含 targetInfo、addFriendSetting、answer、sourceId、sourceSubId、myAllowFlag、permissionInfo、nodeIKernelAddBuddyService、callFrom 等字符串。
- `[BuddyAdderService]` 位于 46,533,155；所在候选缓存偏移 **46,529,136**，payload 长度 **29,528**。附近包含 curContactSetting、formValue、sourceId、subSourceId 等字符串。
- 这些字符串只能定位构造代码，**不能证明第一参数内容、第三参数构造或默认字段值**。主动申请 MCP 仍未开放。

下一步可完全离线推进：按固定哈希提取上述两个缓存；依据精确 V8 tag 生成对应的 serializer/opcode/root 布局，再解析常量池与参数构造。研究工具 [aynakeya/v8asm](https://github.com/aynakeya/v8asm) 已下载至忽略目录 `state/probes/v8asm`，提交 `0d1e8a9d05618f459c96b1e1eddb2bf6b95bc8f5`；其 Python 路径是静态解析，不初始化 V8，但现成 profiles 最高只到 13.6，**尚未解析成功，也没有拿旧 profile 冒充兼容**。应审查并使用精确 13.8.258.18 源码生成 profile，必要时匹配原始 snapshot。不能使用会执行缓存的普通 vm.Script/runInThisContext 来试运行 QQ 模块。

本轮修正版 117 项相关测试已通过；本段之后仅新增离线研究记录，没有再改生产逻辑、配置、白名单、会话或记忆。22:16 再查五小时剩余 **12%**，按用户要求停止新开发、保存交接。

22:16:21 用核验过机器人身份的当前 WS 凭据独立建连成功（仅握手后关闭，没有发送消息或业务 action），说明上游 WS 当前可用；生产桥接断开应另查其重连状态。只读源码显示 SDK 的 `connect()` 在建连 error 时仅发出 error，靠 close 才清除 connectPromise、触发重试；桥接自愈在 URL/token 未变化时不会主动重连。这是后续应验证的停滞路径，**尚未复现确认根因、未修改 SDK/桥接、未重启服务**。现有日志最后一次连接错误为 21:34:50，随后没有新的连接成功日志。HTTP 与 WS token 不同是正常设计，不要据此改错配置。后续先核验生产连接是否恢复，再决定如何修复；必须遵守不擅自重启生产实例的约束。

## 继续验证：静态读取修正

2026-10-25 21:33（北京时间）额度刷新后继续：桥接 `connected/accountOnline/good` 均 true，正在收到群消息，DSH 就绪。原五小时交接时短暂未重连的状态已恢复；没有据此修改 token，HTTP 与 WS token 本来不同。

已部署并运行 `08-47-35-276Z-8374485b` 静态检查包：wrapper/身份校验成功、能力观察正常结束，但独立静态报告为 `inspection-failed`，没有代码片段。用户退出后执行 Rollback，独立 Status 核验三个目标全为 original、QQ 进程为 0。该旧包不再用于下一次验证。

检查器原先错误地用 Electron 的普通 fs 读取整个 ASAR；[Electron 官方文档](https://www.electronjs.org/docs/latest/tutorial/asar-archives#treating-an-asar-archive-as-a-normal-file) 说明该层把 ASAR 当虚拟目录，原始归档校验应使用 `original-fs`。修正后原始哈希/索引读取使用 `original-fs`，成员读取仍使用 Electron fs，不更改全局 `process.noAsar`。另补充固定失败阶段和允许列表内的错误码，不写异常正文。117 项测试通过，新增测试模拟真实 Electron 的两套文件系统；旧报告未记录阶段，不能再从中恢复具体异常。

## 最新核验：已捕获真实 AddBuddy 调用

以下历史记录中的“未捕获”和“新包尚未安装”已被后续实测更新。包 `state/probes/qq-friend-PACKAGE` 的报告 `probe-44140-1792902521548.json` 显示：2026-10-25 12:35:21（北京时间）捕获一次匹配的 `add-buddy` 调用，`result: 0`、`errorMessagePresent: false`，观察器已清理。旧 `buddy` 入口计数为 0，新入口计数和匹配数均为 1。

本次记录的数值为 `addFriendSetting=1`、`myAllowFlag=1`、`sourceId=5`、`sourceSubId=2`、`isContactFriend=false`、`showMyCard=1`、`myFriendGroupId=0`；目标使用非空 `targetInfo.uin` 字符串，未提供 uid。第一参数是非空字符串，第三参数是对象，尚不能据此确认它是空字节数组或推导上下文内容。上述数值只描述本次界面路径，不是所有来源与账号通用的默认值。

12:37:48 回滚完成；随后独立哈希校验确认原始 DLL 和 package.json 已恢复、临时入口不存在。2026-10-25 本轮继续前，SnowLuma 同账号在线，指定测试账号已在好友列表中。`result: 0` 与当前好友状态分别是两个观察事实，不能单凭返回码推定所有申请都会成功。不删除现有好友来重复测试。

关系管理已备份为 `86dc6d1`：接受/拒绝申请、删除好友、退群的桥接接口正在运行，独立 MCP 客户端能列出五个工具并以管理员会话读取状态。主动发申请仍未接入，版本锁定的适配器仍只支持 observe/dry-run。

## 当前下一步：读取客户端静态实现

新 `--inspect-client-code` 准备选项锁定 `application.asar` 的 SHA-256；QQ 主进程通过既有 wrapper/版本/账号校验后，使用自己的文件系统读取安装包内 JavaScript。只保留六个 AddBuddy 相关标识符附近的有限静态代码片段，逐文件让出主循环，最长 30 秒。不执行读到的代码，不读取用户资料，不调用原生业务方法，也不要求再次发送申请。

`client-code-evidence.cjs` 排除 archive 链接、unpacked 文件和不安全路径；最多读取 1000 个脚本、40 MiB，单文件最多 4 MiB，输出最多 48 个片段。哈希变化直接失败；QQ 如果没有通过该文件接口解密，报告会列出二进制或读取失败计数，不把空结果当成接口不存在。静态证据写入单独的 `client-code-*.json`，不会覆盖原请求观察报告。

这一方案尚需真实客户端验证。先完成离线测试和三文件回滚包，再沿用已授权的临时维护流程；只需退出 QQ、部署、启动登录、取得结果、退出并回滚。DSH、桥接和 SnowLuma 不重启。115 项相关测试通过，包含新增 11 项静态读取和入口检查。

本次已准备但尚未部署的静态代码包：`state/probes/qq-friend-PACKAGE`。它未配置申请观察目标，只启用静态代码检查。`deployment/` 内已有原件、候选件、计划和已核对的维护脚本。重新继续前检查该包的 maintenance-state 和实际文件状态，不能仅凭本段判断是否已回滚。无需删除 `123456789` 或再次发申请。

## 当前额度交接：15% 边界，未开始部署

2026-10-25，用户已按请求退出 QQ。独立 `maintain.ps1 -TaskAction Status` 核验 QQ 进程数为 0，DLL、package.json 和临时入口的状态均为 original。随后额度查询确认五小时已用 85%、剩余 15%，按用户要求进入收尾，**未执行 Apply，没有待回滚修改**。请正常启动 QQ 和恢复 SnowLuma 机器人连接；恢复后的在线核验结果需另行记录，不把旧的在线状态当作当前结果。

- Git：`86dc6d1` 备份现有关系管理；`083c158` 保存本轮只读静态代码检查器、准备脚本、测试和最新证据。115 项测试、相关语法检查及 diff 检查通过。
- 新包已验证 9 个文件哈希及 `application.asar` 哈希，归档内有 137 个 JavaScript 文件。包路径见上一段，**尚无真实 client-code 报告**。
- 当前实际主动申请 MCP 仍不存在；不要把原请求返回 0 或静态检查器的离线测试当成可发送契约。已有五个关系工具经独立 MCP 客户端列举和管理员只读状态调用验证，DSH 自身缓存的清单仍未单独核验。
- 下次先检查额度和 Git；核验 QQ 实际版本、原件及包哈希，再协调一次退出、Apply、只启动机器人 QQ 并登录。读取 `reports/client-code-*.json` 的计数和相关静态片段，查明上下文和第三参数的构造。此步骤无需删除好友或发申请。
- 如果 QQ 的文件接口仍返回密文，只能说明这条静态读取方式不可用；不要据空结果认定接口不存在，也不要猜参数发包。记录具体计数后先退出 QQ、Rollback、独立 Status 核验，再恢复正常登录。
- DSH、桥接和 SnowLuma 服务没有由本轮重启；会话、记忆、白名单、生产配置均未改动。继续遵守五小时剩余低于 15% 时完成回滚和交接的要求。

从干净的 `39da06d` 继续。用户澄清：上次从群 `123456789` 进入与 `123456789` 的临时对话后添加好友，并非 QQ 号搜索。随后只读好友列表确认目标已经是好友，因而原探针漏捕获不能视作申请失败。用户又表示“现在不是好友了，你试试”，重新只读确认目标不在好友列表；本轮没有执行删好友。

## 本机第二组接口证据

沿用已核验的 QQ `9.9.26-44343` / wrapper SHA-256 `29de02c5bec028643fc5d597e269f15be8bc75f7ea1620e53b50c6ff900288f2`。仅读取 PE 字节，没有猜参数调用原生方法。

| 位置（RVA，image base 为 0x180000000） | 内容 |
| --- | --- |
| `0xBB1476–0xBB15A8` | `session.getAddBuddyService()`，0 参数 |
| `0xBE714A–0xBE743A` | `AddBuddyService.addBuddy()`，3 参数并创建 Promise |
| `0xBE74EC–0xBE8203` | 第二个参数的 `AddBuddyReq` 转换器 |
| `0xBE644C–0xBE6715` | `targetInfo` 转换器 |
| `0xA0FAC3–0xA0FC9C` | 二进制向量转换，处理字符串及对象；不应猜成普通 string 参数 |
| `0x1C36887–0x1C36AD6` | Promise 结果包含 result、errMsg、context、req、rsp |

三个参数依次经过字符串、AddBuddyReq、字节向量转换。第一参数业务含义未确认；不将它猜作目标 QQ 或 UID。第二参数包含以下 25 个字段：

`targetInfo, addFriendSetting, myAllowFlag, answer, srcFlag, autoSend, sig, sourceId, sourceSubId, name, srcDescription, friendSrcDesc, isContactFriend, remark, name1, showMyCard, token, verify, deviceInfo, bSupportSecureTips, bSupportAddRelief, extInfo, secSign, permissionInfo, myFriendGroupId`。

`targetInfo` 包含 uid、uin、phoneNum、openid，均有 null/undefined 分支；uin 的非空值仍经过字符串转换再解析为 uint64。`sourceId/sourceSubId` 的大小写不同于旧 ReqToFriend；二者及 addFriendSetting/showMyCard 为 int32，myFriendGroupId 为 uint32。myAllowFlag/srcFlag/autoSend 为可选 uint32。其他字节字段、签名和设备数据的业务要求尚未完全核对，**未为新接口创建可发送请求构建器或猜测默认值**。

结果对象的 result 为 int32，errMsg 为 string，但 context/req/rsp 可能携带上下文、完整请求和业务载荷，观察器不复制、不遍历其内容。Promise fulfilled 不代表添加成功或成为好友。

[NapCat 同名接口声明](https://github.com/NapNeko/NapCatQQ/blob/3420f0b76d7dc0ac92cde1663f21ea27f61e13bb/packages/napcat-core/services/NodeIKernelAddBuddyService.ts) 也列出三个参数，但后两个为 unknown；本次字段结论来自本机转换代码。

## 新观察器

- 原有能力模式和仅观察 reqToAddFriends 的模式仍保留。
- `--observe-add-buddy` 同时观察 QQ 自己取得的两组服务；不额外调用服务 getter，不发送请求。
- 同一轮只保存第一次匹配的请求结果，两组入口不能互相覆盖。
- 同一已确认身份的 session 可能返回多个服务包装对象；用 WeakSet 去重并继续观察其缓存引用，不把“不是最后一次返回的对象”误判为身份失效。重新初始化仍立即停用全部观察，迟到结果不再采集。
- 每组入口有固定诊断计数：调用次数、receiver 不符、参数数量不符、对象无法检查、目标不符、QQ 号和 UID 冲突、已经捕获、匹配、观察异常，以及目标字段类型。单项计数最多 1000，不存参数值或历史请求列表。
- 使用明确目标 UIN；可通过 `--target-identity <本机JSON>` 补充经只读查证的 UID。准备脚本要求文件中的 botUin 和 targetUin 与命令的账号匹配，UID 不写命令行或报告。
- 本机 OneBot 陌生人/群成员响应没有可用 UID；只读打开机器人账号的 `snowluma_identity.db`，仅查询指定 UIN 及指定群成员，得到唯一、无冲突的 UID，保存于忽略的 `state/probes/friend-test-target.json`。未打印 UID、昵称、聊天内容或凭据。
- UID 匹配时允许请求中的 UIN 缺失或为零；存在相互冲突的明确 UIN/UID 时拒绝捕获。不从“owner”声明或任意未验证请求学习目标身份。
- 新请求的 contractMatched 为 null，表示完整发送契约仍未验证。旧请求继续使用原严格契约校验。报告格式为 4，requestRoute 区分 buddy/add-buddy。

准备示例（不部署、不发送）：

```powershell
node scripts/prepare-qq-friend-probe.mjs --wrapper '<当前实际wrapper.node>' --account <机器人QQ> --observe-request-target <测试QQ> --observe-add-buddy --target-identity '<本机核验的身份JSON>'
```

全部 90 项模拟测试通过：原有能力探针 51、请求契约 11、请求观察 28。新测试覆盖双入口、目标 UID 匹配和冲突、参数/this/Promise 保留、字段脱敏、遗漏原因计数、无权限账号、同账号多个服务引用、重新初始化和停止后的迟到结果。

真实验证前保留 Git 备份及三处原文件备份，沿用用户已授权的临时维护；由用户退出 QQ 后应用，登录后确认两组入口状态，再通过同一群临时对话路径手动提交一次。结束后恢复原文件并核验上游。当前未接入生产 MCP，不更改聊天白名单或持久会话。

## 本轮实测及恢复

- 源码备份为 `32e8ce9`；本机包根为 `state/probes/qq-friend-PACKAGE`。
- 2026-10-25 11:34:39（北京时间）探针启动，11:34:42 账号初始化匹配，旧接口已就绪。
- 用户按实际群临时对话路径打开添加好友窗口后，11:38:03 确实观察到 `getAddBuddyService` 返回服务且 `addBuddy` 为函数，观察钩子安装成功，无 hookFailure。这确认了新服务在该窗口路径被使用；尚未证明发送一定调用它。
- 11:39:39 达到原 300 秒超时，phase=timeout、cleanupComplete=true；两组请求计数均为 0。用户随后报告“已发送”，但无法从现有证据确定点击与超时的先后，不能把 0 次计数当作该接口不参与发送的证据。
- 五分钟窗口未给登录和多步手动操作留够余量。源码已修正：请求观察默认/最长 30 分钟，能力探针最长 300 秒不变；报告增加 observationWindowMs/observationExpiresAt，后续发起手动操作前检查 active 和剩余时间。观察成功、身份失效或异常仍提前清理。
- 此修正尚未再次部署；包含新回归测试共 **91 项测试通过**，语法与 diff 检查通过。旧独立包仍保留 300 秒的原 config，不要误用它做下一次测试。
- 用户退出 QQ 后，11:44:02 完成回滚。独立 Status 确认三个目标均 original，maintenance-state 为 installed=false、rollbackRequired=false、hashesVerified=true。
- 用户恢复正常运行，随后只读核验机器人账号相符、online/good 均 true、测试账号仍不在好友列表。未再次发送申请；不能仅凭未成为好友判断前一申请没有发出。
- DSH、桥接、SnowLuma 服务未重启，生产权限、配置、会话和记忆未变更。

## 离线适配边界

在真实观察确认 `AddBuddyService` 入口后，新增 `plugins/qq-friend-probe/friend-adapter.cjs` 作为版本锁定的策略边界，并未接入 bridge 或 QQ 主进程。它固定 QQ `9.9.26-44343` 与 wrapper SHA-256 `29de02c5bec028643fc5d597e269f15be8bc75f7ea1620e53b50c6ff900288f2`；默认 disabled，启用时必须提供非空 `allowedTargetUins`，且只允许 observe/dry-run。它拒绝任意方法名、未知字段、Proxy/accessor、账号不匹配、未授权目标和真实发送；没有 native service 引用、通用调用器或发包入口。dry-run 只产生 `requestSent: false` 的计划，`result: 0` 也保持业务成功和关系变化未知。离线安全测试为 `scripts/test-qq-friend-adapter.mjs`，共 13 项通过。

这一步只固化安全边界，不代表已经得到 AddBuddy 的可发送构建器。第一参数业务含义、第三参数字节向量、签名/验证字段、来源取值和业务返回码仍需版本匹配的只读证据；因此当前不添加 MCP、SnowLuma action 或真实请求路径。

## 下一步

先保存本轮源码和记录，再用新默认时长重新生成独立包。继续使用指定目标的可信身份映射；不要复用旧的五分钟包。下次维护沿原群临时对话路径，先确认新服务已观察且到期时间充足，再安排一次明确的测试；不要在现有证据不明时自动重发或删除好友。

尚未取得真实请求的来源编号、验证方式、上下文及第三参数形状/业务返回码；仍不能上线主动申请 MCP。还需把实际验证结果落实为有限的客户端适配接口，再接入 SnowLuma/桥接的既有权限、峰谷与人工暂停控制。

## 额度交接：剩余 14%

五小时额度剩余 14%，按用户阈值停止新开发，不启动下一轮维护。源码修正提交为 `87c2252`，91 项测试通过；最后一次上游核验在线正常，QQ 文件均已恢复。没有要求用户继续退出或留下待回滚安装。

**下次直接使用的新包**：`C:\QQBridge\state\probes\qq-friend-PACKAGE`。该包来自时限修正后的源码，config 为双入口/指定账号与目标/可信 UID/1,800,000 毫秒。`deployment/plan.json`、原件备份、候选文件及 `maintain.ps1` 均已准备，**未执行 Apply，尚未安装**。

恢复工作时先检查额度、Git 状态及实际 QQ 版本/目标文件哈希，再只读确认测试目标的好友/申请状态。不要重复上一轮已完成的源码研究；也不要把“不是好友”当成“没有未决申请”。若继续真实验证，沿此前临时维护流程与用户协调一次操作，不自动补发。重新部署前确认包文件与 preparation.json 一致，登录后确认账号身份和 addBuddy 接口状态，明确核对 observationExpiresAt 尚有充分余量后才安排点击发送。
