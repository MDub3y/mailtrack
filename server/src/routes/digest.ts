import { Router, Response } from 'express';
import { z } from 'zod';
import { protect, AuthRequest } from '../middleware/auth';
import { User } from '../models/User';
import { buildDigest, markDigestSeen, renderDigestText, renderDigestHtml } from '../services/digestService';
import { resolveSenderIdentity, dispatchEmail } from '../services/dispatchService';
import { isAiEnabled } from '../ai/config';
import { NoProviderKeyError } from '../ai/providers';
import { BudgetExceededError, RunFailedError } from '../ai/runAgent';

// The landing page's API: a deterministic digest, an optional headline, a
// "seen" mark that moves the window, and delivery to the owner's own
// address through their own connected account.

const router = Router();
router.use(protect);

function fail(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof NoProviderKeyError ? 400 : err instanceof BudgetExceededError ? 429 : err instanceof RunFailedError ? 502 : 400;
  res.status(status).json({ message, runId: err instanceof RunFailedError ? err.runId : undefined });
}

const Query = z.object({ since: z.string().datetime().optional() });

// GET /api/digest?since=
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ message: 'since must be an ISO date' }); return; }
  try {
    const view = await buildDigest(req.userId!, { since: parsed.data.since ? new Date(parsed.data.since) : undefined });
    res.json({ ...view, text: renderDigestText(view), aiEnabled: isAiEnabled() });
  } catch (err) { fail(res, err); }
});

// POST /api/digest/seen — the next digest starts now.
router.post('/seen', async (req: AuthRequest, res: Response): Promise<void> => {
  try { await markDigestSeen(req.userId!); res.json({ ok: true }); }
  catch (err) { fail(res, err); }
});

// POST /api/digest/headline { since? } — the one model call, on request.
router.post('/headline', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = Query.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ message: 'since must be an ISO date' }); return; }
  try {
    const view = await buildDigest(req.userId!, { since: parsed.data.since ? new Date(parsed.data.since) : undefined });
    const { writeDigestHeadline } = await import('../ai/digest/headline');
    const out = await writeDigestHeadline(req.userId!, view);
    if (!out) { res.json({ headline: null, message: 'Nothing to summarise.' }); return; }
    res.json(out);
  } catch (err) { fail(res, err); }
});

// POST /api/digest/email { since?, headline? } — send the digest to yourself.
//
// This is the one deliberate exception to "you cannot send an email to
// yourself" (routes/emails.ts): the digest goes out through the owner's own
// connected account to their own address, with no tracking pixel, no
// Email row, and no signal, because nothing about it is a conversation.
router.post('/email', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = Query.extend({ headline: z.string().max(400).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ message: 'invalid body' }); return; }
  try {
    const identity = await resolveSenderIdentity(req.userId!);
    const user = await User.findById(req.userId).select('email gmailAddress').lean();
    if (!identity || !user) { res.status(400).json({ message: 'Connect Gmail (or join an organisation) before sending the digest to yourself.' }); return; }
    const to = identity.mode === 'gmail' ? identity.fromAddress : user.email;
    const view = await buildDigest(req.userId!, { since: parsed.data.since ? new Date(parsed.data.since) : undefined });
    const text = renderDigestText(view);
    const subject = `MailTrack digest, ${view.now.toISOString().slice(0, 10)}${view.hasSomething ? '' : ': nothing new'}`;
    await dispatchEmail(req.userId!, { to, subject, html: renderDigestHtml(view, parsed.data.headline), text: parsed.data.headline ? `${parsed.data.headline}\n\n${text}` : text });
    res.json({ sent: true, to, subject });
  } catch (err) { fail(res, err); }
});

export default router;
