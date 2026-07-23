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
// level. Observed directly in this app's own logs: every prescanned message
// fired its pixel within single-digit-to-tens of seconds of delivery, and
// some carried a synthetic User-Agent claiming to be Chrome, Safari, AND
// Edge simultaneously (no real browser does this — "Edge/12.246" paired
// with an ancient Chrome/42 build is a known scanner fingerprint).
//
// This can never be made 100% accurate — no pixel-tracking product can
// (Mailtrack, HubSpot, Yesware all have the same false-positive class) —
// but timing is the one signal the scanner can't mask: a real human did not
// open a message within a few seconds of it landing, every single time.
const AUTOMATED_SCAN_GRACE_MS = 60_000;
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
