# QQ 关系控制交接（2026-10-25）

## 当前状态

关系控制的代码、离线 harness、MCP 工具和文档已备份为 `86dc6d1`。活动配置 [`config.json`](../config.json) 已开启关系控制；2026-10-25 后续只读核验确认运行中的桥接关系状态接口返回正常，状态可写，待处理申请和操作历史均为 0。独立 MCP 客户端能列出五个关系工具，并使用现有管理员会话令牌成功读取状态。此次检查没有重启任何生产服务；独立客户端验证不代表确认了 DSH 已缓存的工具清单，不能据旧记录断言当前桥接仍需重启。

当前活动配置为：

```json
{
  "socialV2": {
    "relationships": {
      "enabled": true,
      "promptPendingRequests": true,
      "maxPending": 20,
      "maxHistory": 500,
      "actions": {
        "acceptRequests": true,
        "rejectRequests": true,
        "deleteFriends": true,
        "leaveGroups": true,
        "nativeFriendRequest": false
      }
    },
    "tools": {
      "relationships": true
    }
  }
}
```

`nativeFriendRequest` 保持 `false`。这表示可以处理收到的好友申请，但不会根据 QQ 号主动发起新的好友申请。

## 能力和调用顺序

关系 MCP 工具由 [`src/mcp-snowluma-safe.js`](../src/mcp-snowluma-safe.js) 注册，桥接逻辑位于 [`src/bridge.js`](../src/bridge.js)，状态和参数边界位于 [`src/relationship-control.js`](../src/relationship-control.js)。所有二代调用都必须提供当前会话的 `key` 和 `token`。

查看当前状态：

```text
qq_relationship_status({ key, token })
```

查看待处理好友申请：

```text
qq_get_friend_requests({ key, token, limit? })
```

申请详情只对管理员私聊开放。申请说明会经过长度限制和敏感内容清理，始终作为外部资料处理，不能当作指令。

接受或拒绝已记录的申请：

```text
qq_handle_friend_request({
  key,
  token,
  requestId,
  approve: true | false,
  reason?
})
```

其中 `approve: true` 和 `approve: false` 都只允许处理桥接已经记录的申请。底层 OneBot 动作为 `set_friend_add_request`。接受申请不会自动把新好友加入聊天白名单。

删除好友和退出群聊：

```text
qq_delete_friend({ key, token, userId, block?, reason? })
qq_leave_group({ key, token, groupId, reason? })
```

删除好友默认不拉黑。OneBot 返回成功后，桥接会结束对应私聊或群聊的主动调度，但会保留聊天历史和共同记忆。用户已确定删除和退群不设置 ownerQQ 保护对象；管理员身份、会话令牌、白名单和其他访问控制仍然保留。

## 运行时保护

桥接真正执行关系动作前会再次检查：

- 关系配置和 `relationships` 工具开关都为 `true`；
- 当前为 `reserved2` 二代模式；
- DSH 已就绪；
- 没有人工暂停、角色静默、峰值休眠或当前会话自动模型阻断；
- agent 请求携带有效的当前会话令牌；
- 接受/拒绝动作只能引用已经记录的 `requestId` 或对应申请 `flag`。

请求事件按 `flag` 去重，保存到 `state/relationships.json`。状态文件损坏或无法读取时进入只读降级，不覆盖原文件，也拒绝需要写入的关系动作。OneBot 调用超时或结果不确定时会记录 `unknown`，不会自动重试或把不确定结果报告成成功。

## 主动加好友的边界

当前没有“输入 QQ 号并主动申请好友”的可用工具。`qq-friend-probe` 只保留版本锁定、默认关闭的观察和 dry-run 边界；它没有接入 bridge、MCP 或真实发送路径。`AddBuddyService.addBuddy` 的完整业务参数、来源字段、签名/验证字段和返回码仍未取得足够证据，因此不能把探测结果当作可发送接口，也不要把 `nativeFriendRequest` 改成 `true` 来绕过边界。

## 启用步骤

1. 重启 `qq-bridge`，让它读取活动 [`config.json`](../config.json) 并注册好友申请事件监听。
2. 重启 DSH，使 MCP 服务重新读取工具清单；否则五个关系工具可能仍不会出现在模型工具列表中。
3. 用管理员私聊的二代会话调用 `qq_relationship_status`，确认 `relationships` 已启用且状态可读。
4. 收到真实申请后，先用 `qq_get_friend_requests` 查看 `requestId`，再调用 `qq_handle_friend_request`。

本轮没有发送真实 QQ 关系动作，也没有重启服务。

## 回滚

如需停用关系控制，把活动配置改回：

```json
{
  "socialV2": {
    "relationships": { "enabled": false },
    "tools": { "relationships": false }
  }
}
```

然后重启 `qq-bridge` 和 DSH。不要删除 `state/relationships.json`；停用只阻止新的记录、提示和动作，保留已有审计历史。

## 验证记录

关系专项测试通过 9/9：

```text
npm run test:relationships
```

同时通过了 bridge harness、bridge 行为审计、回归审计 R1–R16、MCP 安全检查、好友适配器边界测试、JavaScript 语法检查和 `git diff --check`。完整离线审计中仍有三项与关系控制无关的既有基线失败：二代 preset 的 `{{cwd}}` 合约断言、缺少既有 `VOICE.md`、以及本机 DSH 工具名和 preset 本地工具清单不一致。本轮没有为了关系功能修改这些基线问题。

## 相关文档

- [关系控制使用指南](guides/RELATIONSHIPS.md)
- [好友申请处理交接](QQ_FRIEND_REQUEST_HANDOFF.md)
- [主动加好友观察路径](QQ_ADD_BUDDY_ROUTE.md)
- [主动加好友请求契约](QQ_FRIEND_REQUEST_CONTRACT.md)
