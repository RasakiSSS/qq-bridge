# 共同记忆实施状态（2026-10-24）

状态：代码、自动化测试和说明已完成；尚未重启生产实例启用，也未进行真实模型或 QQ/空间发送验收。

## 用户已确定

- 群聊、私聊、QQ 空间全局共享可用记忆，不设置三类来源之间的共享限制。人物按 QQ 号关联；自然联系经历、印象、关系和未完事项。
- 空间与群聊共用工作区，各 session 独立；管理员文件权限、原守卫、白名单、峰谷、人工暂停和空间额度保留。
- 先 Git 备份；不得擅自重启、重置会话、清空数据或发真实测试内容。
- 最新额度指示：5 小时额度剩余不足 **15%** 时交接（已替代此前 20%）。不使用额度重置券。

## 检查点

- 实施前备份：`4de50f7 fix: share QQ workspace with Qzone sessions`。
- 第一阶段保存：`5da71ca wip: checkpoint shared memory foundation for handoff`。
- 完成提交请查 Git log 中 `feat: share evidence-backed memory across QQ chats and Qzone`。
- 没有修改 config.json、生产 SQLite、旧 DSH 压缩状态或任何运行数据。

## 实现定位

- `src/shared-memory.js`：SQLite/WAL、即时证据、QQ 身份、中文/英文检索、长期事实/印象/经历/未完事项、事务、修正历史、乐观并发、遗忘防复活。
- `src/shared-memory-worker.js`：受限单轮临时会话、峰谷/暂停及异步身份重检、成功后推进进度、失败退避、不确定投递持久化恢复、批次幂等、结束后取消订阅并归档。
- `src/shared-memory-qzone.js`：动态/评论和发送记录归一，未知回执不能冒充成功。
- `src/bridge.js`：接入入站/成功发言、正常唤醒与 qq_get_prompt、空间决策、内部任务事件与用量、鉴权管理 API。
- `src/mcp-snowluma-safe.js`：qq_recall / qq_remember / qq_forget。后者仅管理员私聊或控制台。
- `src/qzone.js` / `src/qzone-agent.js`：空间观察和记忆候选，与共享经历联系；记忆失败不改变空间发送结果。
- `dsh/agent-presets/qq-memory/`、`plugins/qq-agent-presets/qq-memory-no-tools.mjs`：禁止所有工具的整理预设。既有预设只追加共同记忆指导、更新空间共享说明；原文件守卫没有放宽。
- `docs/guides/SHARED_MEMORY.md`：完整配置、管理、安装、恢复和实际边界；QZONE.md、RULES.md 同步。

## 验证

- 记忆专项 20/20，空间 28/28，MCP 安全 13/13；联合最后一轮 **61/61**。
- 峰谷回归 **29/29**；preset patch 一致性、原安全守卫、修改模块语法、git diff --check 通过。
- 完整离线审计 **39/42**。三个既有失败：test-qq-preset-contract 的旧 cwd 断言；test-voice-system 的本地忽略说明缺失；test-preset-local-tools 与已安装 DSH 工具名差异。没有为通过而放宽权限。
- 测试全部临时数据、模拟 QQ/DSH/时间。Windows 沙箱对临时 rename 和 loopback 限制导致需要提升执行离线测试；不是修改生产权限。

## 启用与边界

1. 用户安排重载 DSH profile/MCP 或重启 DSH，加载新增 qq-memory 与工具 schema；仓库链接 bundle 已登记并生成 patch。看不到预设时用原 setup-dsh 安装流程。
2. 用户安排重启 qq-bridge；无须 reset、清库或迁移/删除旧 session。当前代码默认启用共同记忆；配置也可显式指定。
3. 旧会话记忆和 DSH 历史保留，未批量导入历史 DSH 原文。新增数据从启用后的消息及可用空间快照建立。
4. 记忆使用本地关键词检索，不是语义向量搜索。单次内容预算限制上下文膨胀；不能保证模型必然自然使用所有信息。
5. 投递结果未知且没有终态时保持等待，重启继续跟踪；若 DSH 任务已丢失需人工核对后恢复。此时原始记录和查询不受阻。不要盲目删库或重置 QQ session。
6. 管理接口有 status/history，尚无控制台可视化记忆管理页面。自然语言纠正/遗忘可走 MCP，历史只读。

后续若继续调试，先检查 Git 状态和用量，再按用户反馈排查；不要重做实现或擅自线上验收。
