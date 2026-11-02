import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { unifiedToolCatalog } from '../../src/unified/tools.js';
import { RESTRICTED_TOOL_NAMES } from './qq-tool-restrict.mjs';
export const name = 'qq-unified-guard';
export const inject = ['tools'];
const allowed = new Set([...unifiedToolCatalog().map(tool => tool.name), 'ask_user_question', 'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch', 'todo_write', 'compress', 'decompress', 'search_context', 'acp_status']);
// The native DSH tools run in their own provider, outside UnifiedTools.call.
// Check the current main binding and live permission on every native dispatch.
const stateDir = new URL('../../state/', import.meta.url);
const native = new Set([
  'pwsh', 'read', 'read_image', 'write', 'edit', 'glob', 'grep',
  'job_list', 'job_output', 'job_kill', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  'skill', 'get_goal', 'create_goal', 'update_goal', 'exit_plan_mode', 'present',
  'subagent', 'subagent_fork', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'web_search', 'web_fetch',
]);
export function nativeAllowed(sessionId, directory = stateDir) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  let db;
  try {
    const binding = JSON.parse(readFileSync(new URL('unified-mcp.json', directory), 'utf8'));
    if (binding.version !== 1 || binding.sessionId !== sessionId) return false;
    db = new DatabaseSync(fileURLToPath(new URL('unified.sqlite', directory)), {readOnly:true});
    const rows = db.prepare('SELECT permission,paused FROM accounts WHERE session_id=?').all(sessionId);
    return rows.length === 1 && rows[0].permission === 'v3' && rows[0].paused === 0;
  } catch { return false; }
  finally { db?.close(); }
}
export function apply(ctx) {
  for (const name of RESTRICTED_TOOL_NAMES) {
    try { ctx.tools.restrict({ deny: [name] }); } catch { /* Unknown inherited name; execution guard still denies. */ }
  }
  ctx.tools.guard(exec => {
    if (allowed.has(exec?.name)) return;
    if (native.has(exec?.name) && nativeAllowed(exec.agent?.session?.id)) return;
    return 'UNIFIED_TOOL_DENIED';
  });
}
