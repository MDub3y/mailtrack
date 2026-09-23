import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../mcp/server';

// The MCP door: Streamable HTTP, stateless (one server per request, no
// session), authenticated with the owner's token in the Authorization
// header (a login token or the 90-day read token from /api/integrations).
//
//   claude mcp add --transport http mailtrack http://localhost:5000/api/mcp --header "Authorization: Bearer <token>"

const router = Router();

function ownerFrom(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(h.slice(7), process.env.JWT_SECRET!) as { userId: string };
    return decoded.userId ?? null;
  } catch { return null; }
}

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const ownerId = ownerFrom(req);
  if (!ownerId) { res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: send a MailTrack token as a Bearer header' }, id: null }); return; }
  const server = createMcpServer(ownerId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err instanceof Error ? err.message : String(err) }, id: null });
  }
});

// Stateless: nothing to resume or end.
router.get('/', (_req: Request, res: Response): void => { res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }); });
router.delete('/', (_req: Request, res: Response): void => { res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }); });

export default router;
