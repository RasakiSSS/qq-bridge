import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fail } from './store.js';

const writes = new Set(['write_file', 'edit_file', 'create_directory']);
const fields = {
  read_text_file: ['path', 'head', 'tail'], read_multiple_files: ['paths'],
  list_directory: ['path'], list_directory_with_sizes: ['path', 'sortBy'],
  directory_tree: ['path', 'excludePatterns'], search_files: ['path', 'pattern', 'excludePatterns'],
  get_file_info: ['path'], list_allowed_directories: [],
  create_directory: ['path'], write_file: ['path', 'content'], edit_file: ['path', 'edits', 'dryRun'],
};
export const workspaceOperations = Object.freeze(Object.keys(fields));
const inside = (root, file) => { const rel = path.relative(root, file); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep); };

// Use the existing, trusted administrator Filesystem installation and roots.
// Model input never selects a command, server, absolute path or extra root.
export function workspaceServer(preset, bindingFile) {
  const servers = Array.isArray(preset) ? preset.filter(x => x?.config?.serverName === 'qq-workspace-files') : [];
  if (servers.length !== 1) throw fail('FILES_UNAVAILABLE');
  const c = servers[0].config;
  if (c.transport !== 'stdio' || typeof c.command !== 'string' || !path.isAbsolute(c.command)
    || !Array.isArray(c.args) || c.args.length < 2 || c.args.some(x => typeof x !== 'string' || !path.isAbsolute(x))) throw fail('FILES_UNAVAILABLE');
  // No CLI options: the first argument is the already installed server script.
  if (!fs.statSync(c.command).isFile() || !fs.statSync(c.args[0]).isFile()) throw fail('FILES_UNAVAILABLE');
  const protectedFiles = [bindingFile, fs.realpathSync(c.command), fs.realpathSync(c.args[0])];
  const roots = c.args.slice(1).map(root => {
    const real = fs.realpathSync(root);
    if (!fs.statSync(real).isDirectory() || protectedFiles.some(file => inside(real, file))) throw fail('FILES_UNAVAILABLE');
    return real;
  });
  return { command: c.command, script: c.args[0], roots };
}

function resolveInput(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1000 || path.isAbsolute(relative)
    || /[:\x00-\x1f]/.test(relative)) throw fail('FILE_PATH_DENIED');
  const segments = relative.replaceAll('\\', '/').split('/');
  if (segments.some(x => x === '..' || (x !== '.' && (/[ .]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))))) throw fail('FILE_PATH_DENIED');
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw fail('FILE_PATH_DENIED');
  // Reject links (including NTFS junctions), hardlinked files and aliases before
  // handing off. The existing server independently validates paths at use time.
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1) || !inside(root, fs.realpathSync(current))) throw fail('FILE_PATH_DENIED');
    } catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return target;
}

async function connect(server) {
  const client = new Client({ name: 'qq-unified-files', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: server.command, args: [server.script, ...server.roots], stderr: 'pipe' }), { timeout: 10000 });
    return { call: args => client.callTool(args, undefined, { timeout: 15000 }), close: () => client.close() };
  } catch (error) { await client.close().catch(() => {}); throw error; }
}

export class UnifiedFiles {
  constructor({ getServer, policy, connectServer = connect }) { this.getServer = getServer; this.policy = policy; this.connect = connectServer; }
  prepare(payload) {
    this.policy();
    const server = JSON.parse(JSON.stringify(this.getServer())), { operation, root = 0, ...input } = payload;
    if (!Object.hasOwn(fields, operation) || !server.roots[root] || Object.keys(input).some(k => !fields[operation].includes(k))) throw fail('INVALID_ARGUMENTS');
    const args = { ...input };
    if (fields[operation].includes('path')) args.path = resolveInput(server.roots[root], input.path);
    if (operation === 'read_multiple_files') {
      if (!Array.isArray(input.paths) || !input.paths.length) throw fail('INVALID_ARGUMENTS');
      args.paths = input.paths.map(p => resolveInput(server.roots[root], p));
    }
    if (operation === 'write_file' && typeof input.content !== 'string'
      || operation === 'edit_file' && (!Array.isArray(input.edits) || !input.edits.length)
      || operation === 'search_files' && typeof input.pattern !== 'string'
      || input.head !== undefined && input.tail !== undefined) throw fail('INVALID_ARGUMENTS');
    return { server, operation, args, original: payload };
  }
  handler() {
    return { scope: 'global', level: 'v3', prepare: ({ payload }) => this.prepare(payload),
      dispatch: async ({ payload, assertCurrent }) => {
        const check = () => {
          assertCurrent();
          const current = this.prepare(payload.original);
          if (JSON.stringify(current) !== JSON.stringify(payload)) throw fail('FILES_UNAVAILABLE');
        };
        check();
        if (payload.operation === 'list_allowed_directories') return { status: 'succeeded', result: { roots: payload.server.roots.map((_, index) => ({ root: index, path: '.' })) } };
        const client = await this.connect(payload.server);
        try {
          check(); // Recheck permissions, configuration and paths after startup.
          const response = await client.call({ name: payload.operation, arguments: payload.args });
          if (response?.isError || !Array.isArray(response?.content)) return { status: writes.has(payload.operation) ? 'unknown' : 'rejected', result: { code: 'FILE_OPERATION_FAILED' } };
          let text = response.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
          for (let i = 0; i < payload.server.roots.length; i++) text = text.replaceAll(payload.server.roots[i], `[workspace:${i}]`);
          // Bound tool text before it reaches the main context or action ledger.
          const originalLength = text.length;
          text = text.slice(0, 12000);
          while (Buffer.byteLength(JSON.stringify(text)) > 24000) text = text.slice(0, Math.floor(text.length * 0.8));
          return { status: 'succeeded', result: { text, truncated: text.length < originalLength } };
        } finally { await client.close(); }
      } };
  }
}
