import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { unifiedToolCatalog } from '../../src/unified/tools.js';

export const name = 'qq-unified-client';
export const inject = ['tools'];
const bindingFile = new URL('../../state/unified-mcp.json', import.meta.url);
const identityMeta = 'qq-bridge/execution';

// Host-only file outside the permitted model workspace. Never supply this file,
// bearer or endpoint through a model argument, persona, or inherited environment.
export async function readMainBinding(sessionId) {
  const text = await readFile(bindingFile, 'utf8');
  if (Buffer.byteLength(text) > 16384) throw new Error('MAIN_BINDING_UNAVAILABLE');
  const file = JSON.parse(text);
  if (file.version !== 1 || file.sessionId !== sessionId || !/^[a-f0-9]{64}$/.test(file.token)) throw new Error('MAIN_BINDING_UNAVAILABLE');
  const url = new URL(file.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('MAIN_BINDING_UNAVAILABLE');
  return { endpoint: url.href, token: file.token };
}

export async function invokeMainTool(tool, args, exec, readBinding = readMainBinding) {
  // These values are supplied by ToolRuntime, never by the language model.
  const sessionId = exec?.agent?.session?.id, callId = exec?.callId;
  if (typeof sessionId !== 'string' || !sessionId || typeof callId !== 'string' || !callId) throw new Error('MAIN_EXECUTION_REQUIRED');
  let client;
  try {
    const binding = await readBinding(sessionId);
    exec.signal?.throwIfAborted();
    client = new Client({ name: 'qq-unified-main', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(binding.endpoint), {
      requestInit: { redirect: 'error', headers: { authorization: `Bearer ${binding.token}`, 'x-qq-main-session': sessionId } },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    await client.connect(transport, { signal: exec.signal, timeout: 10000 });
    const result = await client.callTool({ name: tool, arguments: args, _meta: { [identityMeta]: { sessionId, callId } } }, undefined, { signal: exec.signal, timeout: 30000 });
    const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    // Server provides only static sanitized error codes. Do not expose client
    // transport errors, which can contain credentials or local endpoint details.
    if (result.isError) return { error: true, text };
    return { error: false, text };
  } catch { throw new Error('UNIFIED_CONNECTION_FAILED'); }
  finally { await client?.close().catch(() => {}); }
}

export function apply(ctx) {
  for (const definition of unifiedToolCatalog()) {
    ctx.tools.register({ ...definition,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const result = await invokeMainTool(definition.name, args, exec);
        if (result.error) throw new Error(result.text);
        return result.text;
      },
    });
  }
}
