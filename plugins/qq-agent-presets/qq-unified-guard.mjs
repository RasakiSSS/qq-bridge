import { unifiedToolCatalog } from '../../src/unified/tools.js';
import { RESTRICTED_TOOL_NAMES } from './qq-tool-restrict.mjs';
export const name = 'qq-unified-guard';
export const inject = ['tools'];
const allowed = new Set([...unifiedToolCatalog().map(tool => tool.name), 'todo_write', 'compress', 'decompress', 'search_context', 'acp_status']);
export function apply(ctx) {
  for (const name of RESTRICTED_TOOL_NAMES) {
    try { ctx.tools.restrict({ deny: [name] }); } catch { /* Unknown inherited name; execution guard still denies. */ }
  }
  ctx.tools.guard(exec => allowed.has(exec?.name) ? undefined : 'UNIFIED_TOOL_DENIED');
}
