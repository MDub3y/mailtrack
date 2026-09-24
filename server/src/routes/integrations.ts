import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { protect, AuthRequest } from '../middleware/auth';
import { WebhookConfig, OUTBOUND_EVENTS, OutboundEvent } from '../models/Webhook';
import { ensureWebhookConfig, rotateInboundSecret, addOutbound, removeOutbound, setOutboundEnabled, ingestExternalSignal, deliverToEndpoint, watchQueue, redeliverFailed, recentDeliveries } from '../services/webhookService';
import { createApiToken, listApiTokens, revokeApiToken } from '../services/apiTokenService';
import { scheduleQueueWatch, unscheduleQueueWatch } from '../queues/aiQueue';

// The doors (doc/05, Elevations 1 and 7): the inbound signal webhook
// (unauthenticated, secret in the path), outbound endpoint settings, and
// a long-lived read token for the MCP server.

// ---------------------------------------------------------------- inbound (public)

export const signalsRouter = Router();

const inboundLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });

const ExternalSignal = z.object({
  contactEmail: z.string().email().max(320),
  contactName: z.string().max(120).optional(),
  id: z.string().max(200).optional(),
  at: z.string().datetime().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// POST /api/signals/webhook/:secret
signalsRouter.post('/webhook/:secret', inboundLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = ExternalSignal.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
  if (JSON.stringify(parsed.data.payload ?? {}).length > 8_000) { res.status(413).json({ message: 'payload too large (8 KB)' }); return; }
  try {
    const r = await ingestExternalSignal(req.params.secret, parsed.data);
    if (!r) { res.status(404).json({ message: 'unknown webhook' }); return; }
    res.status(r.isNew ? 201 : 200).json({ signalId: r.signalId, duplicate: !r.isNew });
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------- settings (owner)

const router = Router();
router.use(protect);

function publicBase(req: Request): string {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

async function view(ownerId: string, req: Request) {
  const cfg = await ensureWebhookConfig(ownerId);
  return {
    inbound: { url: `${publicBase(req)}/api/signals/webhook/${cfg.inboundSecret}` },
    outbound: cfg.outbound.map((e) => ({ _id: e._id.toString(), url: e.url, events: e.events, enabled: e.enabled, createdAt: e.createdAt, lastDeliveryAt: e.lastDeliveryAt, lastStatus: e.lastStatus, lastError: e.lastError, failures: e.failures })),
    mcp: { url: `${publicBase(req)}/api/mcp` },
  };
}

// GET /api/integrations
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try { res.json(await view(req.userId!, req)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : String(err) }); }
});

// POST /api/integrations/inbound/rotate
router.post('/inbound/rotate', async (req: AuthRequest, res: Response): Promise<void> => {
  try { await rotateInboundSecret(req.userId!); res.json(await view(req.userId!, req)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : String(err) }); }
});

const Outbound = z.object({ url: z.string().url().max(1024), events: z.array(z.enum(OUTBOUND_EVENTS as [OutboundEvent, ...OutboundEvent[]])).min(1).optional() });

// POST /api/integrations/outbound — returns the signing secret once.
router.post('/outbound', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = Outbound.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
  try {
    const { endpoint, secret } = await addOutbound(req.userId!, parsed.data);
    if (endpoint.events.includes('queue')) await scheduleQueueWatch(req.userId!);
    res.status(201).json({ _id: endpoint._id.toString(), url: endpoint.url, events: endpoint.events, secret });
  } catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : String(err) }); }
});

// PUT /api/integrations/outbound/:id { enabled }
router.put('/outbound/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ message: 'enabled must be a boolean' }); return; }
  try {
    const ok = await setOutboundEnabled(req.userId!, req.params.id, parsed.data.enabled);
    if (!ok) { res.status(404).json({ message: 'Endpoint not found' }); return; }
    res.json({ enabled: parsed.data.enabled });
  } catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : String(err) }); }
});

// DELETE /api/integrations/outbound/:id
router.delete('/outbound/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ok = await removeOutbound(req.userId!, req.params.id);
    if (!ok) { res.status(404).json({ message: 'Endpoint not found' }); return; }
    const cfg = await WebhookConfig.findOne({ ownerId: req.userId }).select('outbound').lean();
    if (!cfg?.outbound.some((e) => e.enabled && e.events.includes('queue'))) await unscheduleQueueWatch(req.userId!);
    res.json({ deleted: true });
  } catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : String(err) }); }
});

// POST /api/integrations/outbound/:id/test — a signed ping, delivered now.
router.post('/outbound/:id/test', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = await deliverToEndpoint(req.userId!, req.params.id, { id: `ping-${Date.now()}`, event: 'ping', at: new Date().toISOString(), ownerId: req.userId!, data: { message: 'MailTrack webhook test' } });
    res.status(r.ok ? 200 : 502).json(r);
  } catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : String(err) }); }
});

// POST /api/integrations/queue-watch — run the queue diff now (mostly for tests and debugging).
router.post('/queue-watch', async (req: AuthRequest, res: Response): Promise<void> => {
  try { res.json(await watchQueue(req.userId!)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : String(err) }); }
});

// Stored read tokens for MCP clients: shown once, hashed at rest, each one
// revocable on its own. (A signed 90-day JWT is still accepted for clients
// configured before this existed.)
router.get('/tokens', async (req: AuthRequest, res: Response): Promise<void> => {
  try { res.json(await listApiTokens(req.userId!)); }
  catch (err) { res.status(500).json({ message: err instanceof Error ? err.message : 'Server error' }); }
});

router.post('/tokens', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = z.object({ name: z.string().min(1).max(60).default('MCP client'), expiresInDays: z.number().int().min(1).max(365).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ message: 'name must be 1 to 60 characters' }); return; }
  try {
    const { token, record } = await createApiToken(req.userId!, parsed.data.name, { expiresInDays: parsed.data.expiresInDays });
    res.status(201).json({ _id: record._id.toString(), name: record.name, prefix: record.prefix, token, expiresAt: record.expiresAt ?? null, scope: 'mcp' });
  } catch (err) { res.status(500).json({ message: err instanceof Error ? err.message : 'Server error' }); }
});

router.delete('/tokens/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ok = await revokeApiToken(req.userId!, req.params.id);
    if (!ok) { res.status(404).json({ message: 'Token not found or already revoked' }); return; }
    res.json({ revoked: true });
  } catch (err) { res.status(500).json({ message: err instanceof Error ? err.message : 'Server error' }); }
});

// Kept for older clients; new ones should use stored tokens.
router.post('/mcp-token', async (req: AuthRequest, res: Response): Promise<void> => {
  const token = jwt.sign({ userId: req.userId, scope: 'mcp' }, process.env.JWT_SECRET!, { expiresIn: '90d' });
  res.json({ token, expiresInDays: 90, scope: 'mcp', deprecated: 'use POST /api/integrations/tokens for a revocable token' });
});

// Delivery log and redelivery of what failed.
router.get('/outbound/:id/deliveries', async (req: AuthRequest, res: Response): Promise<void> => {
  try { res.json(await recentDeliveries(req.userId!, req.params.id)); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : String(err) }); }
});

router.post('/outbound/:id/redeliver', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = z.object({ days: z.number().int().min(1).max(30).default(7) }).safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ message: 'days must be 1 to 30' }); return; }
  try { res.json(await redeliverFailed(req.userId!, req.params.id, { days: parsed.data.days })); }
  catch (err) { res.status(400).json({ message: err instanceof Error ? err.message : String(err) }); }
});

export default router;
