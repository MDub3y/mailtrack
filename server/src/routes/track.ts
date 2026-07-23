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

// GET /api/track/:token/pixel.png — public, unauthenticated (mirrors the
// public-route pattern already used for PDF share links in routes/share.ts).
router.get('/:token/pixel.png', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = await Email.findOne({ trackingToken: req.params.token });
    if (email) {
      const now = new Date();
      const ip = ((req.headers['x-forwarded-for'] as string) || '').split(',')[0].trim() || req.socket.remoteAddress || '';
      const userAgent = req.headers['user-agent'] || '';

      email.openCount += 1;
      email.lastOpenedAt = now;
      if (!email.firstOpenedAt) email.firstOpenedAt = now;
      if (email.status !== 'opened') email.status = 'opened';
      email.events.push({ type: 'opened', timestamp: now, ip, userAgent });
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
