# 删除已收藏的表情

工具：`qq_delete_sticker`，适用于 `reserved2` 二代仿真会话。

先调用 `qq_list_stickers` 确认目标，再传入当前会话的 `key`、`token` 和单个 `stickerId`。
`stickerId` 支持列表中的 id、MD5 或已收录的图片 URL，建议直接用 id。

```json
{
  "key": "group:123456",
  "token": "当前会话令牌",
  "stickerId": "qq_list_stickers 返回的表情 id"
}
```

这会从机器人 QQ 账号的收藏中删除一张表情，并移除本地库中对应的备注、笔记、标签和使用记录。
QQ 收藏由所有会话共享，因此其他会话也将不再列出这张表情。
工具不接受批量目标或通配符，不删除聊天消息、不读取或删除本地图片文件。

底层使用 SnowLuma 官方的
[`delete_custom_face`](https://snowluma.github.io/zh/docs/api/extended/delete_custom_face)
接口，只向它传入已收录表情解析出的 `emoji_id`。
网关返回 `status: ok`、`retcode: 0` 后才删除本地记录；失败时保留本地记录。
响应含 `deleted`、`stickerId`、`remaining`、`localPersisted`。
如果 QQ 已删除但本地文件保存失败，会明确返回 `deleted: true`、`localPersisted: false` 和警告，
此时应刷新收藏列表确认，避免盲目重复删除。

调用必须通过原有控制台鉴权和会话令牌校验，并遵守当前模式、白名单、二代总开关与人工暂停。
排队期间及同步收藏列表后还会再次检查权限。账号级删除操作串行执行，
删除成功前启动的旧同步结果不会把已删除表情重新写回本地库。
表情库损坏并进入只读保护时，不会调用 QQ 删除接口。

配置开关为 `socialV2.tools.deleteSticker`，默认 `true`。
控制台「二代仿真 → 工具开关 → qq_delete_sticker」可以关闭。
`socialV2.sticker.enabled: false` 也会关闭该工具。
关闭后，桥接立即拒绝后续调用；DSH 的工具清单需要重启后刷新。
本次新增工具需要重启 qq-bridge 和 DSH，不需要重置已有 QQ 会话。

测试：`npm run test:delete-sticker`；MCP 注册和调用测试也已加入 `test-audit-security-mcp.mjs`，
均使用临时目录和模拟服务，不访问生产 QQ 收藏。
