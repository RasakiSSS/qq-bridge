
/**
 * 管理员二代仿真专用工具守卫。
 *
 * 保留普通 QQ 聊天 MCP 工具，
 * 额外允许指定的工作区文件 MCP 工具。
 *
 * 注意：
 * 1. 仅供管理员专用 preset 使用。
 * 2. 普通 qq-chat-v2 仍使用原来的 qq-tool-restrict.mjs。
 * 3. 本文件不负责目录隔离和身份认证。
 * 4. 文件 MCP 必须单独限制工作目录。
 */

export const name = 'qq-tool-restrict-files'

export const inject = ['tools']

// 禁止调用的本地执行、文件、进程及管理工具。
// 这里保留 DSH 原生文件工具的限制，
// 文件操作只能使用指定的受限 MCP。

const LOCAL_EXECUTION_TOOLS = [
  // 系统命令
  'pwsh',
  'bash',

  // DSH 原生文件工具
  'read',
  'read_image',
  'write',
  'edit',
  'str_replace_editor',
  'glob',
  'grep',

  // 运行时依赖
  'load_workspace_dependencies',

  // 子 Agent
  'subagent',
  'subagent_fork',
  'list_subagent_models',
  'send_message',
  'interrupt_agent',
  'list_agents',

  // 工作流
  'workflow',
  'ralph',

  // 宿主检查
  'cordis_inspect_list',
  'cordis_inspect_query',

  // 系统配置及回滚
  'dsh_snapshot',
  'dsh_rollback',
  'incident_resolved',

  // 任务及开发工具
  'job_list',
  'job_output',
  'job_kill',
  'skill',
  'present',
  'get_goal',
  'create_goal',
  'update_goal',

  // MCP 资源访问
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',

  // 外部 Agent
  'subagent_codex',
  'subagent_claude_code',

  // Team 模式
  'spawn_teammate',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',

  // 插件管理
  'plugin_manager',

  // 自动调度
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',

  // 开发模式
  'dev_mode_set',
  'dev_mode_status',
  'dev_mode_subagent',
]

// 额外禁止的全局开发工具

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  ...LOCAL_EXECUTION_TOOLS,

  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 导出限制清单，供测试脚本使用

export const RESTRICTED_TOOL_NAMES =
  Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 原有 QQ MCP 工具白名单

const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
]

// 精确允许的工具

const SAFE_EXACT = new Set([
  // 原有无害工具
  'ask_user_question',
  'todo_write',

  // billion-context：绑定当前 agent 会话的上下文管理工具，精确放行。
  'compress',
  'decompress',
  'search_context',
  'acp_status',

  // 工作区文件读取
  'mcp__qq-workspace-files__read_text_file',
  'mcp__qq-workspace-files__read_media_file',
  'mcp__qq-workspace-files__read_multiple_files',

  // 工作区目录浏览
  'mcp__qq-workspace-files__list_directory',
  'mcp__qq-workspace-files__list_directory_with_sizes',
  'mcp__qq-workspace-files__directory_tree',

  // 工作区文件搜索
  'mcp__qq-workspace-files__search_files',

  // 获取文件信息
  'mcp__qq-workspace-files__get_file_info',
  'mcp__qq-workspace-files__list_allowed_directories',

  // 创建目录
  'mcp__qq-workspace-files__create_directory',

  // 创建及编辑文件
  'mcp__qq-workspace-files__write_file',
  'mcp__qq-workspace-files__edit_file',
])

export function apply(ctx) {
  // 第一层：隐藏危险的全局工具

  for (const name of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
    try {
      ctx.tools.restrict({
        deny: [name],
      })
    } catch (error) {
      console.error(
        `[qq-tool-restrict-files] skip restrict ${name}: ${
          error?.message ?? error
        }`
      )
    }
  }

  // 第二层：执行时检查工具白名单

  ctx.tools.guard((exec) => {
    const name = exec?.name

    if (typeof name !== 'string' || name.length === 0) {
      return '工具名无效，已拒绝'
    }

    // 精确白名单
    if (SAFE_EXACT.has(name)) {
      return
    }

    // 原有 QQ MCP 前缀白名单
    if (
      SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      return
    }

    // 拒绝所有其他工具
    return (
      `工具 "${name}" 不在管理员二代仿真工具白名单内，` +
      '已拒绝执行'
    )
  })
}
