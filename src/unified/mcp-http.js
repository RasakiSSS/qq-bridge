import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createUnifiedMcpServer } from './tools.js';

export const IDENTITY_META = 'qq-bridge/execution';
const identifier = value => typeof value === 'string' && /^[\w:.-]{1,256}$/.test(value);

// Explicitly started by the host; importing this module does not open a port.
// No cookies, browser origins, arbitrary interfaces, or unauthenticated discovery.
export async function startUnifiedMcpHttp({ tools, port = 0, dispatch = (token, name, args) => tools.call(token, name, args) }) {
  const server = createServer(async (req, res) => {
    const reject = status => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end('Request rejected'); };
    const address = server.address();
    if (req.headers.host !== `127.0.0.1:${address.port}` || req.headers.origin || req.url !== '/mcp') return reject(403);
    if (req.method !== 'POST') return reject(405);
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    const sessionId = req.headers['x-qq-main-session'];
    try { tools.authenticate(token, sessionId); } catch { return reject(401); }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reject(415);
    let bytes = 0, body;
    try {
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) { reject(413); return; }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { if (!res.headersSent) reject(400); return; }
    if (!body || Array.isArray(body) || typeof body !== 'object') return reject(400);
    try { tools.authenticate(token, sessionId); } catch { return reject(401); }
    if (body.method === 'tools/call') {
      const identity = body.params?._meta?.[IDENTITY_META];
      if (!identity || identity.sessionId !== sessionId || !identifier(identity.callId)) return reject(403);
    }
    const mcp = createUnifiedMcpServer({ dispatch: (name, args, meta) => {
      tools.authenticate(token, sessionId);
      const identity = meta?.[IDENTITY_META];
      if (!identity || identity.sessionId !== sessionId || !identifier(identity.callId)) throw new Error('Invalid identity');
      return dispatch(token, name, args, { sessionId, callId: identity.callId });
    } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void mcp.close().catch(() => {}); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) reject(500); else res.end(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }),
  };
}
