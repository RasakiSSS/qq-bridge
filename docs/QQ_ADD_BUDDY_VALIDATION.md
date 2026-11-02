# AddBuddy 单次维护验证入口

**最新进展：单次真实申请已送达；测试修改已回滚，正式 MCP 已通过测试但尚未启用。当前交付与安装步骤见 [QQ_ADD_BUDDY_MCP.md](QQ_ADD_BUDDY_MCP.md)，下方为历史。**

## 2026-10-26 09:55 本轮实测与交接（覆盖下方“尚未部署”历史）

代码包 `f142db0` 已按授权临时部署并真实登录：账号绑定通过，09:50:24 曾捕获 requestListenerReady=true；
随后实时状态变为 false。打开群 123456789 中目标 123456789 的添加好友窗口后，09:51:30 AddBuddy 绑定就绪，
但请求列表监听仍 false。没有执行 preflight/send-once，`lastResult=null / nativeAttempted=false / requestSent=false`。
因此 getBuddyReq/getBuddySetting 和自动发送的真实结果仍未验证，不能报告申请成功或接口已经上线。

已定位本地生命周期逻辑：同一登录 session 多次 getBuddyService 返回不同 JS 句柄时，代码撤销旧句柄及其监听器。
现已离线修复为保留同一已初始化 session 的各个句柄，从中选取有已注册监听器的读取器；
重新初始化、其他 session、账号不匹配、停止及超时仍全部失效。借用 getter receiver 仍拒绝。
此逻辑沿用原请求观察器对同 session 多个服务引用的处理，不主动创建 session 或补注册原生监听器。
新增维护入口回归证明后来的无监听句柄不会覆盖已就绪读取器，**184 项相关测试通过**。

用户已退出 QQ，Rollback 与独立 Status 全部 original，零 QQ 进程；随后用户回复已恢复。
09:55:27 北京时间桥接状态：DSH ready=true、paused=false、SnowLuma accountOnline/good=true，
但 connected=false。尚不能称消息链路已恢复；未重启 DSH、桥接或 SnowLuma。
原包已回滚，**不可再部署原包来验证修复**；修正版尚未重新打包或部署。
额度剩余 17% 时开始交接，最终复查剩余 **13%**，已按用户 15% 边界停止新工作。
09:56:53 再查仍 connected=false、accountOnline/good=true（silent/degraded=false）；不把后两项当作 WS 已恢复。

下次先检查额度、Git、桥接 WS 恢复情况；如仍断开，参考 SNOWLUMA_WS_RECONNECT.md，未经授权不重启。
额度足够后从新源码重新准备验证包及回滚文件，再协调 QQ 退出/登录。申请目标仍是 123456789，
实际发送前再次查好友与群身份；不要删除好友或清除 journal。每次准备都会重新读取当前 SnowLuma HTTP 凭据。

2026-10-26：已有 Git 备份分支 `codex/addbuddy-before-validation-20261026`（`76bef58`）。
本轮不是生产 MCP 上线。新包只在临时 QQ 启动入口中加载，启动不发送申请，发送必须由本机命令显式触发。
183 项相关离线测试通过；包文件、固定账号/目标/来源和原始 DLL 的候选/备份哈希已核验。

## 本机包与命令

当前包：`state/probes/qq-friend-PACKAGE`。
机器人 `123456789`，测试对象 `123456789`，群来源 `123456789`（已验证路径 `5/2`）。
只读好友列表与群成员查询再次确认目标不是好友、仍在指定群中。UID 沿用之前只读身份库核验的
`state/probes/friend-test-target.json`；不从模型、群消息或自称 owner 的文本获取身份。

```powershell
node scripts/qq-friend-validation-command.mjs --package <包路径> --action status
node scripts/qq-friend-validation-command.mjs --package <包路径> --action preflight
# 仅在明确指定测试目标、预检查通过后执行一次；不自动重试：
node scripts/qq-friend-validation-command.mjs --package <包路径> --action send-once
```

原三文件维护流程仍使用包内 `deployment/maintain.ps1`：所有 QQ 退出后 Apply，随后只启动机器人 QQ；
验证完成后退出 QQ、Rollback、Status 核验，再正常恢复账号。DSH、SnowLuma、桥接不重启。
等待用户退出前必须已完成准备、测试和提交。本记录创建时**尚未部署，没有发送申请**。

控制端口只监听 `127.0.0.1` 的系统分配端口，每个请求校验随机 256 位密钥；
密钥只存在 Git 忽略目录下的本地配置中，命令客户端自行读取，不在命令行、报告或日志中输出。
接口只接受 status、preflight、send-once，不接受目标、请求体、原生方法名或参数。
账号绑定失效、异常或 30 分钟到期会关闭入口并恢复观察钩子。

## 申请状态读取

本机模块 `22634.XV` 的登记表包含 `nodeIKernelBuddyService.getBuddyReq: []` 和
`nodeIKernelBuddyListener.onBuddyReqChange: [data]`。原生绑定要求 getBuddyReq 零参数：
RVA `DBDDD2–DBDF95`；add/removeKernelBuddyListener 分别为 `DBBAA4–DBBC92`、`DBBD1E–DBBE99`，均一参数。
注册返回在 `DBBC59–DBBC68` 经 `napi_create_string_utf8` 转换，故监听器 ID 是字符串。

参考 [NapCat 的调用实现](https://raw.githubusercontent.com/NapNeko/NapCatQQ/main/packages/napcat-core/apis/friend.ts)
与 [通知类型](https://raw.githubusercontent.com/NapNeko/NapCatQQ/main/packages/napcat-core/types/notify.ts)：
查询完成依赖 `onBuddyReqChange`，不是把 getBuddyReq 的直接返回当列表；记录包含方向类型与是否已决定。
本实现独立编写，只保留目标是否有未处理记录，不保存其他人的昵称、申请文本或请求列表。

`friend-requests.cjs` 等待 QQ 自己注册监听器，保留其调用参数、返回与异常，只包装回调以观察结果。
它不注册第二个原生监听器、不清除未读、不批准、拒绝或删除申请。
对目标未决定的 0/1/13 类型判为 pending；未识别状态和错误数据为 unknown。
**pending 的范围是客户端请求列表视图，不宣称覆盖服务端全部历史。** 空列表仅说明本次视图未显示申请。
超时后整个读取器退役，迟到结果不能满足下一次查询。账号、服务或监听器变化使旧结果不可用。

## 单次发送检查与边界

`friend-validation.cjs` 组合现有执行器及两个只读查询。发送前重新确认：

1. QQ 本地绑定账号、版本/哈希和代次仍匹配。
2. SnowLuma 的登录账号在读取好友列表、指定群成员前后均匹配。
3. 目标不是好友，客户端请求列表没有显示待处理申请。
4. 当前 getBuddySetting 返回支持的验证方式 1。
5. 现有执行器在落盘、调用前和异步返回后复查绑定。

实际 getBuddyReq/getBuddySetting、监听器捕获及 addBuddy 调用尚待真实 QQ 验证；模拟测试不能证明其已运行成功。
未知状态一律不发送。不删除现有好友来制造测试条件，不自动加入聊天白名单。
所有包共享 `state/probes/qq-friend-send-once-journal`，重新生成包不能绕过已预留目标；
原生返回不明时不重试。此永久预留仅用于单次维护测试，不是未来自主行为的产品限制。

后续生产 MCP 仍需独立实现长期加载生命周期、桥接认证和权限/峰谷/人工暂停的最终检查。
本机维护入口不能直接当作生产 MCP，也不应开放给模型。
