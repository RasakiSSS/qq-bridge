# 二代仿真峰谷自动休眠

在 `config.json` 中启用：

```json
{
  "socialV2": {
    "peakSleep": { "enabled": true }
  }
}
```

仅 `reserved2` 模式生效。未配置或设为 `false` 时不启用峰谷限制。
修改源码后需要重启 qq-bridge；不需要重启 DSH，也不需要重置会话。

北京时间（UTC+8）周一至周五的 09:00–12:00、14:00–18:00 为高峰，
其余时段、周末和已确认的法定节假日为低谷。边界为左闭右开，12:00、18:00 即恢复。
判定复用 `src/model-prices.js` 的 `resolvePriceTable()` / `isPeakAt()` / `beijingParts()`，
不依赖宿主机时区；一秒心跳记录切换并恢复调度，实际投递前另做实时复查。

规则来源：[DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。
目前采用已确认的 2026 年假期；价格模块中推定的 2027 年连休日期不用于休眠调度。
未来正式放假安排公布后可维护 `pricing.holidays`，其格式为完整的 `YYYY-MM-DD` 日期数组，
会覆盖默认假期表；`pricing.peakWindows` / `peakWeekdays` 也沿用现有覆盖机制。
不会自动联网更新节假日。

核对过的参考实现中，
[Android 小组件](https://github.com/MCwasd/deepseek-platform-widget/blob/main/app/src/main/java/com/tiramisu/deepseekwidget/DeepSeekPricing.kt)
及 [api-monitor](https://github.com/jcleener/api-monitor/blob/main/code/index.js) 均在本地按北京时间计算当前峰谷；
[MaiBot 插件](https://github.com/Photalia/maibot-deepseek-peak-valley/blob/main/plugin.py)
联网解析官方时间规则后同样在本地计算。它们不提供实时峰谷状态接口，且相关判断未覆盖法定节假日。
本功能没有引入这些项目的插件、账号登录或模型调用。

高峰期间，普通群聊/私聊不能启动新唤醒、定时检查、补发提醒、重试或黑话模型任务。
在途回合可以完成，其原有工具权限不变。只有会话 key 严格等于可信配置的
`private:<ownerQQ>` 才豁免；管理员在群内、消息正文中自称管理员均不能豁免。
原有白名单、预设选择、文件 MCP 隔离、工具守卫和人工暂停继续生效。

消息仍进入原有持久化的未读/最近消息缓冲区，容量与原配置一致。
符合原唤醒偏好的触发合并为每会话一个 `peakSleepWake`，随 `social-v2.json` 保存；
低谷按原合并窗口和限频调度，快照被接受不等于已读，仍由原水位确认流程处理。
在途回合已经处理的消息不会再次补唤醒，未命中原唤醒条件的普通消息也不会因切换而强制唤醒。
有限潜水截止时间保留，主动机会恢复周期调度，错过的主动机会不集中补发。
黑话窗口和待研究候选在运行期间保留，低谷通过原有串行队列继续；学习素材窗口仍是原有内存缓冲。

人工暂停不受自动切换影响，包括管理员私聊；谷期只能恢复自动调度闸门，不能解除人工暂停。
功能启用、峰谷切换和管理员私聊豁免只记录状态变化日志，不记录凭据。

测试：`npm run test:peak-sleep`。使用虚拟时间、临时文件和模拟 QQ/DSH，
不等待真实峰谷切换，不访问生产实例；也已加入 `npm run test:audit`。
