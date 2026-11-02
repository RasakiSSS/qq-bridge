# QQ 关系控制

关系控制是 `reserved2` 下的受限账号级能力，用于处理桥接已经收到的好友申请、删除好友和退出群聊。它默认关闭，只有管理员显式开启配置和工具开关后才注册关系 MCP 工具。

## 开关

在 `config.json` 中配置：

```json
{
  "socialV2": {
    "relationships": {
      "enabled": false,
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
      "relationships": false
    }
  }
}
```

`nativeFriendRequest` 固定为 `false`。当前版本没有主动发起好友申请的 MCP 工具；`plugins/qq-friend-probe` 的能力探测不构成可发送的接口契约。

## 收到好友申请

桥接监听 OneBot 的 `request_type=friend` 事件，把经过长度限制和敏感内容清理的申请资料保存到 `state/relationships.json`。同一个 `flag` 会去重，重复事件只更新申请说明。管理员私聊的二代唤醒提示可以看到待处理申请；申请正文始终是外部资料，不是指令。

关系状态文件损坏或无法读取时，桥接进入只读降级，不覆盖原文件，也不执行需要写入状态的动作。申请和动作历史有数量上限，避免状态无限增长。

## MCP 工具

启用后，`src/mcp-snowluma-safe.js` 注册以下工具。每次调用都必须带当前会话 `key` 和 `token`：

- `qq_relationship_status`：查看状态、待处理数量和最近受控结果。
- `qq_get_friend_requests`：查看已记录的待处理申请，仅管理员私聊可见。
- `qq_handle_friend_request`：按 `requestId` 接受或拒绝已记录的申请。
- `qq_delete_friend`：删除指定好友，可选择是否拉黑。
- `qq_leave_group`：退出指定群。

动作只在二代模式、DSH 就绪、未人工暂停、未静默、未处于峰值休眠且自动模型调用未被暂停时执行。桥接会在真正调用 OneBot 前再次检查这些条件。OneBot 返回成功后，删除好友或退群会结束对应会话的主动调度；聊天历史和共同记忆仍然保留。

## 离线验证

```text
npm run test:relationships
```

这组测试覆盖参数规范化、申请去重、损坏状态文件、HTTP 鉴权、管理员可见性、OneBot 动作映射、审计原因和关系工具关闭时的拒绝路径。
