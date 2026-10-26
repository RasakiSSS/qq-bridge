# AddBuddy 静态构造、分发证据与离线 API

最新维护组合入口与客户端申请列表读取见 [QQ_ADD_BUDDY_VALIDATION.md](QQ_ADD_BUDDY_VALIDATION.md)。
已有可准备的单次验证包，尚未在 QQ 中实际调用、未接生产 MCP；下文“没有加载入口”的描述仅指独立执行器模块本身。

当前支持 QQ `9.9.26-44343` 的一个已观察场景：UIN 目标、来源 `5/2`、目标验证方式 `1`。
[离线适配器](../plugins/qq-friend-probe/friend-adapter.cjs) 生成请求数据，不持有 QQ 服务、
不调用原生方法、不开启网络端口。`invocationVerified=false`、`requestSent=false` 始终保留。

## 输入与结果

`createFriendAdapter(config)` 默认关闭，只接受 `observe` 或 `dry-run`。
`buildObservedAddBuddyEnvelope(input, config)` 与 `adapter.buildEnvelope(input)` 使用同一套校验；
直接调用导出的函数不能绕过关闭状态、模式、版本哈希或目标列表。

配置必须提供 `enabled:true`、`mode:'dry-run'`、`qqVersion`、`wrapperSha256`、
`majorSha256`、`expectedUin` 和非空 `allowedTargetUins`。普通 `plan()` 不要求客户端哈希，
但构造 envelope 必须锁定下表中的客户端二进制。

| 文件 | 已核验 SHA-256 |
| --- | --- |
| wrapper.node | `29de02c5bec028643fc5d597e269f15be8bc75f7ea1620e53b50c6ff900288f2` |
| major.node | `aa23a73baf7cd41ad28969ce0f227789b936093838bb398e16e3e24672ac16f3` |

输入为普通对象，所有读取来自自身数据属性的快照；拒绝 Proxy、访问器、未知字段和非标准目标数组。
QQ 号使用正十进制字符串，并检查 uint64 上限 `18446744073709551615`，避免原生数字转换截断。

```js
const input = {
  action: 'request', accountUin: '<配置中的机器人QQ>', targetUin: '<允许的目标QQ>',
  idempotencyKey: 'operator-test-0001', dryRun: true,
  addFriendSetting: 1, answer: '<申请说明>', remark: '',
  defaultCategory: 0, sourceId: 5, sourceSubId: 2,
  onlyChat: false, qzoneNotWatch: false, qzoneNotWatched: false,
};
const plan = adapter.buildEnvelope(input);
```

`addFriendSetting` 不是来源路径的固定默认值。客户端从目标资料读取并传递这个值；适配器目前
只接受显式 `1`，其他值暂不支持。来源号也必须显式为 `5/2`。备注、分组编号、三个权限布尔值
全部必填，不能从遗漏字段推断用户的权限选择。输入 `answer` 和 `remark` 的 500 字符上限是本地
策略上限，不是已验证的 QQ 服务端长度上限。

客户端拥有手机号、openid/appid 等其他分支，当前适配器不支持这些分支，也不支持 targetUid。
原 UI 表单字段拼写为 `defaultCatgory`，经 `Number()` 后成为 `defaultCategory`，再写入
`myFriendGroupId`；当前适配器接收的是规范化后的显式 uint32。

`plan()` 只校验旧版轻量计划字段，传入 envelope 专用字段会拒绝，不再悄悄丢弃参数。
`assertRuntimeAttestation()` 只是比较调用者提供的 QQ/原生模块 pin，不读取文件、不检查登录身份。
离线 config 中填写哈希同样不等于实时进程认证。未来加载器必须独立验证实际文件、登录账号和会话代次。

## 客户端构造证据

[应用函数反编译](../state/probes/qq-addbuddy-static-20261025/application-service.linear.txt)
的 `addBuddy`，对象索引 310、合成地址 `0xf00000013600`，字节码偏移 151–470，证明 UIN 分支构造：

```js
const envelope = {
  callFrom: 'GuildContactAddApplication',
  reqInfo: {
    targetInfo: { uin: input.id },
    addFriendSetting: input.addFriendSetting,
    answer: input.answer,
    sourceId: Number(input.sourceId), sourceSubId: Number(input.subSourceId),
    isContactFriend: false, remark: utf8(input.remark), showMyCard: 1,
    myFriendGroupId: input.defaultCategory,
    name: utf8(input.id), name1: utf8(input.id), myAllowFlag: 1,
    permissionInfo: utf8(JSON.stringify({
      onlyChat: input.onlyChat, qzoneNotWatch: input.qzoneNotWatch,
      qzoneNotWatched: input.qzoneNotWatched,
    })),
  },
  context: new Uint8Array(),
};
```

`sy` 的导出与实现位于 [编码依赖反编译](../state/probes/qq-addbuddy-static-20261025/encoding-dependency.linear.txt)
第 2916–2930、3069–3085 行，实际编码为 `new TextEncoder().encode(text)`。
`name`、`name1`、`remark`、`permissionInfo` 均为 UTF-8 字节；`answer` 保持字符串。
客户端 `buildPermissionInfo` 在 JSON 序列化失败时返回空字节数组，但本地适配器要求三个明确布尔值，
不复制任意 getter、toJSON 或省略字段行为。未构造 sig/token/verify/deviceInfo/secSign 等安全字段，
这只说明当前客户端方法没有设置它们，不代表其他路径可省略。

返回对象和字段容器冻结；每次构造新分配 Uint8Array。字节内容本身仍可被持有者修改。
未来执行器必须从校验后的原始输入重新构造自己的参数，不能在 await 之后使用外部返回的可变字节数组。

## 原生类型与转发链路

原生绑定 RVA `0xBE714A–0xBE743A` 在 `0xBE7202` 检查 `argc == 3`；argv[0] 进入
string 转换器 `0xA0F7BC`，argv[1] 进入 AddBuddyReq 转换器 `0xBE74EC`，argv[2] 进入
二进制向量转换器 `0xA0FAC3`。这证明类型顺序为 `(string, AddBuddyReq, bytes)`。

**类型顺序不能单独证明 envelope 字段被如何转发。** 2026-10-26 已完成独立的字段来源复核：
客户端模块 `22634` 的导出 `XV` 读取 context slot 4，来源为 CP[11] 的对象字面量（对象 102937）。
其中 `nodeIKernelAddBuddyService` 为对象 103363，`addBuddy` 对应数组描述 103370、固定数组
103371，三项依次为 **`callFrom, reqInfo, context`**。同模块 `Z4` 的 slot 2 / CP[9] 确认
服务 getter 为 `getAddBuddyService`。重新运行固定缓存哈希的提取脚本得到相同顺序。

模块 `55190` 的 getter 对象 45072 在字节码 137–160 读取 `XV[serviceName][method]`；
handler 45082 通过 callback 45089 逐项取 `objParams[name]`，随后在偏移 107 以服务对象为
receiver 执行 `CallWithSpread`。因此 `(callFrom, reqInfo, context)` 已得到独立的登记表、
分发器和原生 ABI 三方面证据，构造结果现在标记 `nativeMappingVerified=true`。
这只验证参数映射，`invocationVerified=false / requestSent=false` 仍保持。

完整定位见 [分发研究记录](../state/probes/qq-addbuddy-static-20261025/native-dispatch-evidence.md)
和 [登记表提取](../state/probes/qq-addbuddy-static-20261025/addbuddy-parameter-registry.json)。
此前 `21f8564` 的结论曾仅靠类型顺序，备份 `a223641` 中已降为候选；本次凭补齐的证据重新确认，
没有按属性枚举顺序猜测或通过发送来试错。

## 单次执行器与会话绑定

[friend-runtime.cjs](../plugins/qq-friend-probe/friend-runtime.cjs) 为独立的本地 `send-once` 执行器，
默认关闭，没有加载入口、端口、定时发送或 MCP 注册。`prepare()` 只验证并返回摘要；
`execute()` 要求显式 `dryRun:false`，从已校验输入重新构造私有字节数组，仅调用固定绑定的方法。

- 本地调用者提供 `getBinding` 与异步 `lookupRelationship`。前者必须包含账号、三个文件/版本 pin、
  receiver、固定 method、代次 epoch 和 `isCurrent`；不能由模型请求携带。
- 后者接收账号、目标及已验证的来源 `5/2`，必须明确返回相同账号/目标、`friend`、`pending` 布尔值和
  实时 `addFriendSetting`。好友、待处理、未知状态或设置变化都会阻止调用。缺失 pending 不能当作 false。
- 关系查询后、落盘后、调用前重查绑定；native 等待期间账号/服务变化，结果归为 unknown。
- 本地 journal 以独占创建、文件 fsync 保存幂等键和账号/目标预留；并发实例也只能取得一次预留。
  部分写入、超时和不确定结果不自动重试。这个永久目标预留用于单次维护验证，**不是最终自主加好友的产品限制**。
- Windows 的目录 fsync 不可移植；文件 fsync 防进程退出丢预留，断电保证仍取决于文件系统。
- native 返回只报告有限整数。`nativeInvoked` 不代表 `requestSent`、`accepted` 或已成为好友；后者保持未知。

[friend-binding.cjs](../plugins/qq-friend-probe/friend-binding.cjs) 校验实际安装路径、package 版本、
wrapper 与 major 的固定哈希，复用被动观察器跟随 QQ 自己的 session/init/getAddBuddyService 调用。
它不主动创建 session 或调用服务 getter。只有匹配账号的 init 返回后才保留方法引用；绑定模式持续观察，
重新初始化、更换 session、wrapper 再加载、超时或 stop 都撤销引用。服务替换产生新代次；方法被替换也会失效。
绑定只留在本地闭包，不写报告。原只读探针入口不传此回调，行为保持不变。

目前这些模块**未部署到 QQ，也未接到 bridge/MCP**；本机实际会话绑定和发送仍需后续维护验证。
生产接入还需可信 IPC、既有会话权限、峰谷/人工暂停的最终投递复查，以及真实关系查询提供者。
不能直接把填写了 pin 的配置当作登录在线认证。

## 目标设置的只读查询

[friend-setting.cjs](../plugins/qq-friend-probe/friend-setting.cjs) 只调用固定 `getBuddySetting`，
使用相同账号/目标范围和绑定校验。ApplicationService 字节码 224–407 证明 UIN 分支参数为：
`('GuildGetContactSettingsApplication', {targetInfo:{uin},sourceId:5,sourceSubId:2}, new Uint8Array())`。
模块 `22634.XV` 登记表也给出 `callFrom/reqInfo/context`；本机 wrapper 的绑定 RVA
`0xBE698E–0xBE6C7E` 要求 3 参数，依次调用 string 转换器 `0xA0F7BC`、请求转换器
`0xBE6D30`、bytes 转换器 `0xA0FAC3`。本轮没有实际调用该原生查询。

读完只保留 `querySetting` 和 `isContactFriend`，拒绝缺失/错误类型、非零结果和异步绑定失效。
不从 `isContactFriend` 的名称推断 QQ 好友列表成员资格，该标志按原名保留；好友资格仍需实际好友列表核验。
响应也不证明是否有待处理申请，所以返回 **`friend:null / pending:null`**；不可直接作为执行器的完整关系结果。
后续还需明确待处理申请的可信查询范围与来源，不能借静态设置默认值绕过。

## 返回码与关系结果

[界面函数 sendBuddyReq](../state/probes/qq-addbuddy-static-20261025/buddy-adder-service.linear.txt)
字节码偏移 274–303 同时检查 `result === 0`、`rsp.errorCode === 0`、`rsp.result === 0` 才进入
成功分支。`readAddBuddyOutcome()` 提取这三个有限整数，返回 `uiSuccessConditionMet`：三者齐全
且均为零则 true；明确非零则 false；关键响应缺失或类型不符则 null。

该字段只表示符合界面成功分支条件。成功分支还区分 HasAdd/HadReq，因此不能将它解释成已成为好友。
`businessSuccessKnown=false`、`relationshipChanged=false` 保持不变。方法不输出上下文、请求内容、
目标资料或错误正文，也不执行响应对象的访问器。

## 解析可靠性与复核

静态资料保存在 [本机解析摘要](../state/probes/qq-addbuddy-static-20261025/parse-summary.json)
和 [V8 源码清单](../state/probes/qq-addbuddy-static-20261025/source-manifest.json)，不作为运行依赖。
V8 `13.8.258.18` 源码 commit 为 `a14ab029e21658cba458b7001281c5d526e67636`；生成 profile
有 210 个 opcode、1144 个 root，版本哈希 `0x72f25803`。缓存只读 checksum `0x40bfe37b`
匹配安装目录的 v8_context_snapshot；另一个 snapshot 的 `0x76710460` 被拒绝。

两个主要缓存分别位于 major.node 的偏移 27659536/46529136，payload 为 64544/29528 字节。
静态解析完整消费载荷，得到 1777/749 个对象、164/53 个字节码数组，没有待解析引用；tagged_size=8
会越界，实际使用 4。线性翻译器仍有 211/47 条未支持指令警告，涉及 8 种指令，故推论必须结合
原始 opcode 和局部数据流，不能将整份伪代码当作完全等价的程序。

```powershell
node --test scripts/test-qq-friend-adapter.mjs
npm run test:qq-friend-runtime
npm run test:qq-friend-binding
npm run test:qq-friend-setting
npm run test:qq-friend-probe
```

验证覆盖字段来源、配置旁路、继承访问器、数组访问器、uint64 溢出、UTF-8 和权限 JSON、结果码不确定性。
测试不会加载 QQ 原生模块、发送好友请求或改变生产服务。

2026-10-26 本轮上述模块加原探针/静态扫描/请求契约/观察测试共 **166 项通过**；语法与 diff 检查通过。
这是离线验证结果，不能替代实际客户端的目标设置查询和发送结果。
