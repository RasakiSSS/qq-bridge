# 主动加好友 MCP：2026-10-26 实施状态

本文件覆盖其他观察文档中的历史状态。**真实主动申请已送达，正式 MCP 代码和安装包已完成；尚未生产启用。**

**额度收尾：** 本轮代码提交 `76e1482`。随后五小时 usedPercent=85（剩余 15%），停止新开发/部署。正式包所有文件和三个部署候选哈希验证通过，QQ 三个目标仍为 original，无待回滚修改。用户可保持 QQ 正常使用；下一轮先检查额度与 Git，再确认长期部署及桥接/MCP 重载授权，不要直接要求用户退出 QQ。本轮无需因“无 MCP 迹象”放弃：真实送达、实际 MCP 工具调用和正式实现均已有证据；生产未上线必须明确保留。

## 已验证的能力

- 从群 123456789 对 123456789 的单次真实申请由原生执行器发出，三个原生结果码均为 0；用户明确确认“已收到”。这次不是界面手动发送。不得再次发送该测试申请。
- 测试包 `state/probes/qq-friend-PACKAGE` 已回滚，独立核验三个 QQ 文件均 original。用户已恢复两个 QQ；恢复后桥接 connected/accountOnline/good/dshReady 均为 true。
- 正式 `qq_add_friend` MCP 已注册，实际 stdio 客户端能列出并调用工具；隔离测试验证 MCP → 桥接路由。原生入口、会话绑定和执行器另有模拟测试；正式安装后还需确认登录自动取得服务和 DSH 工具可见性。
- 97 项原生/关系/MCP 回归和 29 项峰谷回归通过。测试记录位于 `state/probes/native-mcp-regression.txt`、`native-mcp-peak-regression.txt`。
- 开工备份分支：`codex/addbuddy-before-mcp-20261026`，基线 `ffe5fca`。

## 工具与权限

`qq_add_friend(key, token, userId, groupId, answer, operationId)`：仅支持已验证的共同群来源（source 5/2）、目标好友设置 1。不支持未经验证的 QQ 号搜索来源。UID 从当前账号 SnowLuma 身份库读取，实时检查登录账号、群成员、好友及客户端待处理申请。

模型不能传入原生方法名、原生参数或本地服务密钥。桥接沿用现有会话令牌、白名单、二代模式、角色静默、人工暂停、峰谷和工具开关。原生发送前再次向桥接确认权限。新增好友不自动进入聊天白名单；删除好友、退群和管理员文件 MCP 的权限规则保持原样。

`operationId` 是一次决定的唯一编号，同一次决定重试必须沿用。磁盘日志阻止该决定重复调用；结果未知不能换编号重试。没有自动重发。原生返回成功表示申请提交，不表示已成为好友。不同决定可以使用新编号，仍须通过实时关系检查。

## 待启用包与步骤

正式包：`state/probes/qq-friend-PACKAGE`。

- `deployment/plan.json` 列出三个目标、原件备份及候选哈希；`deployment/maintain.ps1` 提供 Status / Apply / Rollback。当前未 Apply。
- QQ 9.9.26-44343 的版本、wrapper、major 固定校验。更新或账号重新初始化时停止本服务，不推测新接口。
- 正式模式在登录后取得已验证的 AddBuddy getter，监听服务持续到 QQ 退出，不再有维护包的 30 分钟到期。自动取得 getter 已模拟验证，正式登录行为仍待核验。
- 与临时验证不同，启用后须保留 QQ 完整性校验 DLL 的 5 字节修改、package.json 启动项和加载文件，停用时可退出所有 QQ 后 Rollback。此长期变更须明确批准。
- 业务配置仅需 `socialV2.relationships.actions.nativeFriendRequest: true`，以及 `socialV2.relationships.nativeConfigFile` 指向上述包下 `qq-bridge-friend-probe/config.json`。其他配置不变。关闭前者即可停用主动申请；不会清除历史和好友。
- 批准后：退出共用安装目录的所有 QQ → 核验原件 → Apply → 启动机器人 QQ → 只读检查 bindingReady/requestListenerReady。若不就绪，回滚，不再进行试探性发申请。
- 然后保存配置备份、启用上述两项、受控重启桥接以加载新路由，并重新加载 DSH 的 SnowLuma MCP 进程/配置。优先仅重载 MCP；若环境只能重启 DSH，另行明确说明后操作。不能使用宽泛进程匹配批量结束实例。
- 最后检查现有会话保留、QQ/DSH 在线、DSH 能看到 `qq_add_friend`。无需第二次真实申请。

## 额度与继续边界

用户要求本次五小时剩余 15% 时若无 MCP 完成迹象则放弃。本轮已完成真实送达、MCP 实现与调用测试，剩余为生产启用。达到交接边界仍需先保存进度，不在额度紧张时开启新的 QQ 维护窗口。此前的发送日志必须保留，不得清空来重复测试。

本轮未重启 DSH/桥接，未启用生产配置，未重置会话、记忆、消息或白名单。
