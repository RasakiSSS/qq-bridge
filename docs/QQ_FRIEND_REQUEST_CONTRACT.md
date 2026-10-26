# QQ 9.9.26 主动申请对象：本机转换代码核对

本文件针对 `BuddyService.reqToAddFriends`；本机另有 `AddBuddyService.addBuddy`，不能混用其参数，见 [QQ_ADD_BUDDY_ROUTE.md](QQ_ADD_BUDDY_ROUTE.md)。

2026-10-25，从干净的 `9cc96ba` 继续。这里只确认指定版本的字段转换和 Promise 结果结构，**没有把字段枚举、来源编号或发送成功当作已经验证**。

后续真实观察已完成并回滚：用户报告通过 QQ 界面发送一次，但探针未捕获匹配调用。当前上游已恢复，最新状态和待排查事项见 [QQ_FRIEND_REQUEST_HANDOFF.md](QQ_FRIEND_REQUEST_HANDOFF.md)。以下准备部分保留其当时状态。

## 二进制证据

- 实际模块：`C:\Program Files\Tencent\QQNT\versions\9.9.26-44343\resources\app\wrapper.node`
- 文件大小：97,233,448 字节。
- SHA-256：`29de02c5bec028643fc5d597e269f15be8bc75f7ea1620e53b50c6ff900288f2`
- PE image base：`0x180000000`。下表均使用 RVA，实际静态地址为 image base + RVA。
- 仅读取 PE 字节；没有加载原生模块或调用原生方法。使用本地隔离的 `pefile 2024.8.26` 和 `capstone 5.0.6`，位于忽略的 `state/probes/python-tools/`，不是桥接运行依赖。

| 证据位置（RVA） | 核对内容 |
| --- | --- |
| `0xDBE5D6–0xDBE870` | JS 绑定；断言只接收一个参数，调用对象转换器和 `napi_create_promise` |
| `0xDBE8CE–0xDBEED1` | `ReqToFriend` 转换器，读取下面 14 个顶层字段 |
| `0xDC6FE4–0xDC712F` | `securityVerify` 的 4 个字段 |
| `0xA0F7BC` / `0x628630` | 通用字符串转换 / 十进制 `stoull` |
| `0xA0F8BF` / `0xA0F980` | int32 / uint32 转换 |
| `0xA0F67A` | 判断 undefined/null，可选字段经过此判断 |
| `0x1BE1074` | 原生回调接收返回码和字符串，安排 JS 结果处理 |
| `0x1BE132D–0x1BE14AC` | 构造 `{ result, errMsg }` 并调用 `napi_resolve_deferred` |

本机离线分析助手保存在 `state/probes/inspect_friend_schema.py`（仅本机，不进 Git）。复核时对上述函数范围反汇编，沿 `napi_get_named_property` 后的转换调用追踪字段；不要仅靠字符串在文件中的相邻位置推断结构。QQ 升级后这些地址及结论全部需要重新核验。

## 请求字段

“可选”指转换器对 null/undefined 有明确分支，不代表业务一定接受省略。表中 string 指适配器要求的输入类型；原生转换器有更多隐式转换，适配器不复刻这些隐式行为。

| 字段 | 适配输入类型 | 原生是否有可选分支 | 字段名引用 RVA |
| --- | --- | --- | --- |
| buddyUin | 正的 uint64 十进制字符串 | 否 | `0xDBE913` |
| buddyUid | 非空 string | 否 | `0xDBE96D` |
| phoneNumber | string，可为空 | 否 | `0xDBE9A8` |
| addFriendSetting | int32 | 否 | `0xDBE9DC` |
| answer | string | 是 | `0xDBEA0B` |
| remark | string | 是 | `0xDBEA7F` |
| defaultCatgory | uint32 | 是 | `0xDBEAF3` |
| verifyInfo | string | 是 | `0xDBEB5D` |
| securityVerify | 下述对象 | 是 | `0xDBEBD1` |
| sourceID | uint32 | 否 | `0xDBEC45` |
| sourceSubID | uint32 | 否 | `0xDBEC78` |
| qzoneNotWatch | boolean | 否 | `0xDBECAC` |
| qzoneNotWatched | boolean | 否 | `0xDBECF0` |
| onlyChat | boolean | 否 | `0xDBED27` |

`defaultCatgory` 的拼写是原生接口本身的拼写，不应改成 `defaultCategory`。

`securityVerify` 非空时包含 `type: uint32`、`ticket: string`、`randStr: string`、`token: string`；引用分别为 `0xDC7019 / 0xDC7048 / 0xDC7072 / 0xDC709C`。这些字段内没有可选分支。票据、随机串及令牌不能写入报告。

关键陷阱：`buddyUin` 先走通用字符串转换再转 uint64；通用转换器对 JS number 使用 `napi_get_value_int32`。直接传数字可能截断较大的 QQ 号。因此 `request-contract.cjs` 必须接收字符串，拒绝数字、BigInt、非十进制、前导零和 uint64 越界值。

原生 string 转换还支持 object 的字符串强制转换。适配器更严格：拒绝 getter、Proxy、未知字段及非普通对象，复制新对象，不读取凭据或执行输入对象上的方法。可选字段保留省略/null/undefined 的差别；不补猜测的默认值。

## 返回值

绑定返回 Promise。原生结果处理构造 `{ result: int32, errMsg: string }`，随后 resolve；不能把 Promise fulfilled 直接当成业务成功，更不能当成已成为好友。`result` 名称引用位于 `0x1BE139D`，`errMsg` 位于 `0x1BE1410`。

`readFriendRequestResult()` 只验证并返回这两个字段。真实返回码含义、不同验证方式的结果、对方接受后的关系变化仍需受控验证。

## 后续单次观察

用户已指定 QQ `123456789` 为真实测试对象。准备时只读检查确认：机器人账号匹配、online/good 为 true，目标不在当前好友列表。没有发送任何申请，也没有为了测试删除好友。

新增请求观察模式沿用已经验证的 session 入口，只对指定机器人、指定目标的第一次 QQ 自身调用进行观察：

```powershell
node scripts/prepare-qq-friend-probe.mjs --wrapper '<当前实际 wrapper.node>' --account <机器人QQ> --observe-request-target <测试QQ>
```

该参数只准备探针，不发送申请。准备包仍需按既有维护流程加载；用户在 QQ 界面打开指定账号的加好友页面、确认本次验证内容及开关、点击一次发送。探针保留原始 this、参数、返回 Promise 和异常，观察结束或 300 秒超时撤回包装，不补发、不重试。

报告格式 3 的 `requestObservation` 仅保存：固定字段的类型和字符串是否为空、来源编号/验证方式/分类编号/三个权限开关、嵌套字段形状、未知字段数量，以及是否符合严格契约。不会保存账号、UID、手机号、申请内容、回答、备注、票据或原生错误原文。`requestResult` 仅保存整数返回码与错误消息是否非空。

`requestSent: null` 表示没有证实远端送达；`probeInitiatedRequest: false` 表示探针未发起任何调用；`qqRequestObserved: true` 只表示观察到 QQ 的调用。`requestSchemaVerified` 保持旧能力探针的 false，新的 `requestObservation.contractMatched` 单独表示本次输入是否符合静态契约。一次输入匹配不代表所有取值已通过业务验证。

账号重新初始化、服务更换、超时或无法包装方法时停止观察。Promise 拒绝会保持原始拒绝结果，探针附加的拒绝处理器会影响 JS 的未处理拒绝统计；不改变 QQ 调用者收到的 Promise。

尚未接入长期客户端服务、SnowLuma action 或 qq-bridge MCP。后续将通过已确认的好友查找/资料途径取得 UID 和验证要求，不能把本次单个目标的数据硬编码成通用默认值。

## 测试

```powershell
node --test scripts/test-qq-friend-probe.mjs scripts/test-qq-friend-contract.mjs scripts/test-qq-friend-request-observer.mjs
```

共 78 项模拟测试通过：原有入口和回滚 51 项、严格契约 11 项、请求观察 16 项。QQ 原生对象均为模拟对象；未通过测试调用真实 QQ 服务。生产桥接、DSH、白名单、管理员文件权限、会话与记忆均未改动。

参考类型声明只用于交叉核对，不作为本机 ABI：

- [Android ReqToFriend](https://github.com/LuckyPray/qq-stub/blob/0deeb76d156cc007edccc4b0cfc17a49038951c6/src/main/java/com/tencent/qqnt/kernel/nativeinterface/ReqToFriend.java) 缺少本机三个空间权限字段。
- [NapCat BuddyService](https://github.com/NapNeko/NapCatQQ/blob/3420f0b76d7dc0ac92cde1663f21ea27f61e13bb/packages/napcat-core/services/NodeIKernelBuddyService.ts) 的两参数声明与本机不符。
