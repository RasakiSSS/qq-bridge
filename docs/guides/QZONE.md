# QQ 空间自主活动

空间活动仅在 `reserved2` 下运行。开启[共同记忆](SHARED_MEMORY.md)后，群聊、私聊和 QQ 空间可以联系同一个人的经历、印象与未完事项；原有会话记忆和管理员文件权限继续保留。

QQ 空间保留独立 session，与群聊、私聊共用 DSH 的「QQ 聊天」工作区。工作区路径统一取 `sessionCwd`，未配置时使用 `state/agents`；名称取 `workspaceTitle`。空间仍使用 `qq-qzone` 受限预设，归入同一工作区不会获得管理员文件权限，也不会自动共享其他 session 的聊天上下文。

从旧版升级只需重启 qq-bridge，之后创建的空间 session 会进入共享工作区，无需因本次归组修改重启 DSH。旧 `state/qzone-agent/<QQ号>` 工作区及其中的历史会话保留，不自动移动、归档或删除；`state/qzone.json` 的已读、额度和活动记录继续沿用。

## 配置与启用

在 `config.json` 的 `socialV2` 下配置：

```json
"qzone": {
  "enabled": true,
  "browseFriends": true,
  "watchQQ": [],
  "pollIntervalMs": 1800000,
  "eventPollIntervalMs": 60000,
  "dailyPostLimit": 3,
  "minPostIntervalMs": 10800000,
  "visibility": "friends",
  "readComments": true,
  "autoReplyComments": true,
  "ownPostsLimit": 20
}
```

- 浏览好友动态首页；`watchQQ` 可填写额外关注的 QQ 号字符串。空数组仍会浏览好友动态。
- 每 30 分钟提供一次自主活动机会，不要求每次发说说。每天以北京时间计数，最多 3 条，间隔至少 3 小时。
- `friends` 对应 SnowLuma `ugc_right: 4`，只发文字；可选结构化 @。未提供图片上传、任意文件或空间删除能力。
- 每 60 秒检查可见新评论和明确 @，检测到后可提前唤醒。桥接调度心跳为 30 秒，接口耗时和正在进行的任务可能增加延迟。
- 自己说说下的新评论、明确 @ 自己的评论，以及自己已主动评论的动态下的新评论会交给模型判断。普通好友说说下的其他评论不会单独唤醒。
- 评论和回应不设每日次数额度。每条来源评论只处理一次，同一说说只主动发起一次评论；对方后续的新评论仍可继续回应。
- `readComments: false` 停止读取评论；`autoReplyComments: false` 停止自动处理及手动回应新评论，但仍可主动评论已读说说。

代码更新需要重启 qq-bridge；新 `qq-qzone` 预设和 MCP schema 需要 DSH 重载 profile 或重启。既有安装使用 `qq-agent-presets` bundle，新增 patch 已在包内登记；若 DSH 看不到预设，按原安装说明运行 `node scripts/setup-dsh.mjs` 后再加载。程序不会自行重启 DSH、SnowLuma 或清空会话。

运行新版桥接后，`qzone` 配置每次操作从磁盘读取，设 `enabled: false` 会阻止下一次读取、推理和写操作。MCP 工具是否出现在清单中取决于其启动时配置，修改开关后重载 MCP/DSH 可刷新清单；即使旧工具仍显示，桥接也会按最新开关拒绝执行。

## 峰谷和权限

自动浏览、模型投递、发送前都检查二代模式、人工暂停、角色静默、工具开关及现有峰谷逻辑。异步创建会话、选模型、排队之后再次检查。人工暂停不会被低谷切换覆盖。

若报“角色静默模式（silent）”，说明 `/silent` 仍生效，与控制台的“二代 AI 人工暂停”是两个独立开关。管理员发送 `/active` 或在控制台关闭角色静默即可恢复；这也会恢复普通 QQ 的正常活动，不只是空间。若报“人工暂停”，需使用控制台的恢复按钮，`/active` 不会取消人工暂停。诊断接口不会自动替你解除任何暂停设置。

管理员私聊提供以下 MCP：

| 工具 | 用途 |
| --- | --- |
| `qq_qzone_status` | 查看待处理内容、额度、最近发送及待核对记录 |
| `qq_qzone_browse` | 刷新好友首页、关注 QQ、自己的动态和评论 |
| `qq_qzone_publish` | 发文字说说，可通过 `mentions` 数组 @ 已知 QQ |
| `qq_qzone_comment` | 通过浏览结果的 `postKey` 评论说说 |
| `qq_qzone_reply` | 通过浏览结果的 `commentKey` 回应新评论 |

必须是可信配置 `ownerQQ` 对应的 `private:<ownerQQ>`，携带该私聊的有效 token，并通过原有白名单和权限检查。管理员在群里、其他私聊、伪造正文身份都不能使用这些工具。仅这个管理员私聊调用豁免峰谷时间限制；人工暂停、角色静默、额度、工具开关和内容审计仍有效。

可用 `socialV2.tools.qzoneRead`、`qzonePublish`、`qzoneComment` 分别关闭读、发表、评论权限。自主空间工作会话使用独立的 `qq-qzone` 受限预设，继承原安全守卫，不持有任何 QQ 聊天会话 token 或管理员 Filesystem 权限。模型只生成 JSON，桥接校验整批目标和正文后串行执行。模型选择失败时不投递。切换 QQ 登录账号会新建独立工作会话。

空间内容、昵称和评论是外部数据，不具有管理权限。目标必须来自已读取内容；@ 对象必须来自已知动态、评论或 `watchQQ`。禁止手写 @ 协议标记。所有正文仍经过凭据、本地路径和已知 token 拦截。

## 保存、重试和恢复

`state/qzone.json` 按登录 QQ 保存已读动态、新评论、分页游标、发布额度及发送记录。峰期/暂停不消费这些待处理内容，恢复后继续检查。启用前的历史评论不自动回应，自己的评论不会唤醒自己。近期活动记录会提供给模型，桥接重启不重置这些记录。

远端写入之前先持久化发送意图。明确未投递即被权限检查拦截时，记录为 `not-sent`，不占发布额度；已发请求却丢失回执时，记录为 `uncertain`，不盲目重发。后续读到匹配的自己说说/评论可自动核对成功。存在待核对说说时暂停新增发表，避免换措辞重复发布。

管理员确认远端实际结果后，可用控制台鉴权调用 `POST /api/socialV2/qzone/resolve`，JSON 为 `{"writeId":"状态返回的 id","sent":true}` 或 `sent:false`。该操作没有 MCP，带 agent 身份的调用会被拒绝。不要在未核对前标记未发送。状态文件读取/保存失败时停止空间任务并保留文件，不自动重建空状态。

DSH prompt 明确被拒绝时下次可重试；连接中断或十分钟模型等待超时且尚未收到真实 `turn/end` 时，不向该会话再排队。未知投递状态需要先检查 DSH，会话仍在执行时不能重复启动同一动作。

## 上游限制和测试范围

- 当前接入通过 SnowLuma 的 `get_qzone_feeds`、`get_qzone_msg_list`、`get_qzone_msg_detail`、`send_qzone_msg`、`comment_qzone`。接口依据：[OneBot actions](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/actions/qzone.ts)、[Qzone protocol](https://github.com/SnowLuma/SnowLuma/blob/main/packages/protocol/src/web/qzone.ts)。
- 这是轮询唤醒，**不是 QQ 空间官方消息通知流**。只能检测好友首页、指定 QQ、自己的近期动态及已缓存关注动态中的 @/评论。无法保证看到范围之外的 @；停机或高峰期间内容挤出接口的近期列表，也可能漏掉。每轮读取首页 20 条、每个指定 QQ 10 条、自己的默认 20 条，缓存最多 200 条动态。
- 评论分页每次最多五页、每页最多 100 条，剩余使用持久化游标继续；模型每批最多看到 50 条新评论，后续批次继续处理。这是批量处理边界，不是每日回复配额。
- SnowLuma 当前评论接口没有精确楼中楼定位参数，因此回应表现为新顶层评论，带“回复某某：”前缀。`mentions` 使用 QQ 空间原生 `@{uin:QQ,nick:NAME,who:1}` 文本标记；真实显示/通知效果仍取决于上游支持。
- 评论读取接口不支持或出错时会明确记录降级，浏览、发表仍可运行，不虚构已读取评论。
- `npm run test:qzone` 使用模拟时间、QQ 和 DSH，覆盖额度、去重、重启、暂停、峰谷、@ 唤醒、MCP 权限、身份变化、回执丢失和模型投递竞态。没有通过真实发布或评论进行验收，不应将离线测试理解为真实 QQ 写入已验证。

## 本次实施验证（2026-10-23）

空间专项 22/22、MCP 安全测试 12/12、峰谷回归 29/29 通过；四套预设守卫、preset patch 一致性、修改模块语法和 `git diff --check` 通过。完整审计为 36/39 个脚本通过。三个既有失败涉及：`test-qq-preset-contract.mjs` 仍断言已移除的 cwd 变量；`test-voice-system.mjs` 缺少本地忽略的语音说明文件；`test-preset-local-tools.mjs` 的严格名称检查与已安装 DSH 工具包不一致。这三个失败对应的原预设、守卫及测试文件本次均未修改，没有通过放宽权限使其变绿。

本机 SnowLuma 只读验证了登录、自己的说说、评论详情及好友首页的数据结构；没有发布真实说说、评论或 @。本次只写源码、测试、说明和备份后的空间配置，没有重启生产桥接/DSH，也没有清空会话或记忆。

主要实现：`src/qzone.js` 管理状态、去重与调度，`src/qzone-agent.js` 管理独立 DSH 工作会话，`src/bridge.js` 接入权限和事件，`src/mcp-snowluma-safe.js` 提供五个管理员私聊工具；`dsh/agent-presets/qq-qzone/` 及 bundle patch 提供空间专用提示词和守卫。配置示例、预设构建器、安全说明及相应离线测试同步更新。
