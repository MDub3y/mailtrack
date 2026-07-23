import { Router, Request, Response } from 'express';
import { Email } from '../models/Email';

const router = Router();

// 1x1 transparent PNG, served regardless of whether the token matched or the
// DB update succeeded — a broken image in the recipient's inbox would be a
// dead giveaway that tracking is happening.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

// Mail providers automatically prefetch/scan images embedded in new email
// for phishing/malware — before any human opens anything — as part of their
// own spam defenses. Because that prescan is proxied through the same
// infrastructure (e.g. Gmail's ggpht.com/GoogleImageProxy) as a genuine
// human-triggered image load, the two are indistinguishable at the network
// level in the general case.
//
// One signal IS reliable: some scanners send a synthetic User-Agent
// claiming to be Chrome, Safari, AND Edge simultaneously (no real browser
// does this — "Edge/12.246" paired with an ancient Chrome/42 build is a
// known scanner fingerprint). That's checked unconditionally, regardless of
// timing.
//
// Timing alone is NOT a reliable second signal — an earlier version of this
// filter also suppressed anything within 60s of delivery, which incorrectly
// swallowed a real open from someone actively watching for a test email
// (a completely normal thing to do). A human deliberately watching for a
// message can plausibly open it in under 10 seconds, so that grace window
// produced false negatives, not just fewer false positives. The remaining
// floor here is deliberately tiny — just enough to catch a scan so
// instantaneous no human input could possibly explain it — not a real
// disambiguator. Some automated GoogleImageProxy prescans without the
// distinctive UA will still register as opens; that residual noise is a
// known, unsolved limitation shared by every pixel-tracking product, not
// something fixable from here.
const AUTOMATED_SCAN_GRACE_MS = 3_000;
const SCANNER_UA_PATTERN = /Edge\/12\.246/i;

function isLikelyAutomatedScan(userAgent: string, msSinceCreated: number): boolean {
  if (SCANNER_UA_PATTERN.test(userAgent)) return true;
  return msSinceCreated < AUTOMATED_SCAN_GRACE_MS;
}

// GET /api/track/:token/pixel.png — public, unauthenticated (mirrors the
// public-route pattern already used for PDF share links in routes/share.ts).
router.get('/:token/pixel.png', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = await Email.findOne({ trackingToken: req.params.token });
    if (email) {
      const now = new Date();
      const ip = ((req.headers['x-forwarded-for'] as string) || '').split(',')[0].trim() || req.socket.remoteAddress || '';
      const userAgent = req.headers['user-agent'] || '';
      const automated = isLikelyAutomatedScan(userAgent, now.getTime() - email.createdAt.getTime());

      email.events.push({ type: 'opened', timestamp: now, ip, userAgent, automated });

      if (!automated) {
        email.openCount += 1;
        email.lastOpenedAt = now;
        if (!email.firstOpenedAt) email.firstOpenedAt = now;
        if (email.status !== 'opened') email.status = 'opened';
      }

      await email.save();
    }
  } catch (err) {
    console.error('Tracking pixel error:', err);
  }

  res.set({
    'Content-Type': 'image/png',
    'Content-Length': PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
  });
  res.status(200).end(PIXEL);
});

export default router;
