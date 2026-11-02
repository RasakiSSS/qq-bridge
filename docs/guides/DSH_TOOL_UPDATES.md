# DeepSeek 动态工具更新报错

DSH `0.2.1-rc.2` 的 `deepseek-official / deepseek-flash` 会话在中途新增 MCP 工具后，可能持续返回：

```text
messages.<固定编号>: `tool_addition` blocks can only be in `system` messages
```

DSH 将工具注册表变化持久化为 `developer/message`，请求适配器再转换成含 `tool_addition` 的 system 消息。本机观察到新增 `mcp__snowluma__qq_delete_sticker` 后立即出现此错误；错误发生于模型请求校验阶段，尚未执行该工具。不能仅根据错误文案推断桥接把工具块放进了 user 消息。上游有相同版本、相同症状的报告：[讨论 10539](https://github.com/deepseek-ai/deepseek-harness/discussions/10539)、[讨论 10547](https://github.com/deepseek-ai/deepseek-harness/discussions/10547)。

## 保留会话的兼容处理

使用官方路由已有的模型配置接口，仅去掉 `deepseek-flash` 的 `toolUpdate` 能力声明。DSH 自带的请求投影会改为每次提供**当前完整工具列表**，过滤历史 developer 工具更新消息，并去掉延迟加载标记。原始历史仍然保留。

此处理作用于当前 DSH profile 的官方 Flash 路由，会影响该路由上的其他会话的工具声明投递方式。模型、推理强度、视觉能力、上下文容量、system 更新能力和其他模型配置保持原值；QQ 工具守卫、管理员身份路由及文件 MCP 目录限制保持原实现。工具列表改变时可能重新建立前缀缓存。

```powershell
# 只读检查（默认行为）
node scripts/dsh-tool-update-workaround.mjs --check

# 先备份 models 设置，再实时应用；不重启桥接或 DSH
node scripts/dsh-tool-update-workaround.mjs --apply
```

脚本使用 `config.json` 的 `dsh.baseUrl`，允许用 `DSH_BASE_URL` 显式覆盖，只接受本机地址。使用现有本机鉴权，不输出凭据。备份写入被 Git 忽略的 `state/dsh-setting-backups/`，只包含模型列表及回退所需信息。写入使用设置修订号，拒绝覆盖并发修改；重复执行已生效的处理不会再次写入。

配置接口标记为实时生效，下一次请求即可使用。已经准备好配置的请求仍可能失败一次。脚本不会自动向映射到 QQ 的会话发送测试消息，正常发一条私聊可确认端到端恢复。

## 回退与验证

上游修复后，可用应用时输出的备份路径回退：

```powershell
node scripts/dsh-tool-update-workaround.mjs --restore <backup.json>
npm run test:dsh-tool-updates
```

回退恢复原有 models 用户覆盖；原来没有覆盖时撤销该覆盖。其他设置不受影响。若管理员之后修改了模型列表，脚本拒绝用旧备份覆盖。

自动化测试覆盖配置保留、备份失败、幂等、并发冲突、写入拒绝、写后验证及回退；安装 DSH 时另用真实适配器和模拟传输验证请求中不再出现工具更新块，当前工具列表、文件工具、推理配置和原始历史均保留。测试不访问模型服务、不执行 QQ 动作。

请保留原会话及其日志。重建会话会丢失上下文，直接编辑压缩日志还可能破坏投影缓存与索引。
