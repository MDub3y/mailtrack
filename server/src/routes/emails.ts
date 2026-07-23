import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { protect, AuthRequest } from '../middleware/auth';
import { Email } from '../models/Email';
import { User } from '../models/User';
import { resolveSenderIdentity } from '../services/dispatchService';
import type { BulkEmailJob } from '../queues/emailQueue';

const router = Router();
router.use(protect);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/emails/send
// Sends a real email as the sender's own organization (SendGrid, if they
// belong to one) or their connected Gmail account (queued for
// retry/reliability), with a tracking pixel injected so we know when it's
// opened. The recipient does NOT need to be a registered platform user.
router.post('/send', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { to, subject, htmlBody, textBody, attachments } = req.body as {
      to: string; subject: string; htmlBody: string; textBody: string;
      attachments?: Array<{ documentId: string; name: string; shareUrl: string }>;
    };

    if (!to || !subject) {
      res.status(400).json({ message: 'to and subject are required' });
      return;
    }

    const toAddress = to.toLowerCase().trim();
    if (!EMAIL_RE.test(toAddress)) {
      res.status(400).json({ message: `"${to}" is not a valid email address.` });
      return;
    }

    const sender = await User.findById(req.userId);
    if (!sender) { res.status(404).json({ message: 'Sender not found' }); return; }

    const identity = await resolveSenderIdentity(req.userId!);
    if (!identity) {
      res.status(400).json({ message: 'Connect your Gmail account (or join an organization) before sending tracked email.' });
      return;
    }

    if (toAddress === identity.fromAddress.toLowerCase()) {
      res.status(400).json({ message: 'You cannot send an email to yourself.' });
      return;
    }

    // Best-effort: if the address happens to belong to a platform user, link
    // it so the in-app inbox feature keeps working for them.
    const recipient = await User.findOne({ emailAddress: toAddress });

    const email = await Email.create({
      senderId:    sender._id,
      recipientId: recipient?._id,
      from: identity.fromAddress,
      to:   toAddress,
      subject,
      htmlBody: htmlBody || '',
      textBody: textBody || '',
      attachments: attachments || [],
      trackingToken: uuidv4(),
      status: 'sent',
      events: [{ type: 'sent', timestamp: new Date() }],
    });

    const { emailQueue } = await import('../queues/emailQueue');
    await emailQueue.add(
      'send-single',
      { emailId: email._id.toString() },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 } }
    );

    res.status(201).json(email);
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// GET /api/emails/sent  — emails the current user sent
router.get('/sent', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const emails = await Email.find({ senderId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(emails);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// GET /api/emails/inbox  — emails sent TO the current user
router.get('/inbox', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const emails = await Email.find({ recipientId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(emails);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// GET /api/emails/:id  — full detail, accessible by sender OR recipient
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const email = await Email.findOne({
      _id: req.params.id,
      $or: [{ senderId: req.userId }, { recipientId: req.userId }],
    }).lean();

    if (!email) { res.status(404).json({ message: 'Email not found' }); return; }
    res.json(email);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// GET /api/emails/users/search?q=  — find platform users to send to
router.get('/users/search', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const q = (req.query.q as string || '').toLowerCase().trim();
    if (!q) { res.json([]); return; }

    // Escape regex metacharacters to prevent ReDoS
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const users = await User.find({
      _id: { $ne: req.userId },
      $or: [
        { emailAddress: { $regex: escaped, $options: 'i' } },
        { name:         { $regex: escaped, $options: 'i' } },
      ],
    }).select('name emailAddress').limit(5).lean();

    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// POST /api/emails/send-bulk
router.post('/send-bulk', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { recipients, subject, htmlBody, textBody } = req.body as {
      recipients: string[]; subject: string; htmlBody?: string; textBody?: string;
    };
    if (!Array.isArray(recipients) || recipients.length === 0) {
      res.status(400).json({ message: 'recipients must be a non-empty array' }); return;
    }
    if (recipients.length > 500) {
      res.status(400).json({ message: 'Maximum 500 recipients per job' }); return;
    }
    if (!subject) { res.status(400).json({ message: 'subject is required' }); return; }

    const sender = await User.findById(req.userId);
    if (!sender) { res.status(404).json({ message: 'Sender not found' }); return; }

    const identity = await resolveSenderIdentity(req.userId!);
    if (!identity) {
      res.status(400).json({ message: 'Connect your Gmail account (or join an organization) before sending tracked email.' });
      return;
    }

    // Import queue lazily to avoid circular deps
    const { emailQueue } = await import('../queues/emailQueue');
    const job = await emailQueue.add('send-bulk', {
      senderId:           req.userId!,
      senderEmailAddress: identity.fromAddress,
      recipients:         recipients.map((r) => r.toLowerCase().trim()).filter(Boolean),
      subject,
      htmlBody:  htmlBody  || '',
      textBody:  textBody  || '',
    });

    res.status(202).json({ jobId: job.id, recipientCount: recipients.length });
  } catch (err) {
    console.error('Bulk email queue error:', err);
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// GET /api/emails/bulk-status/:jobId
router.get('/bulk-status/:jobId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { emailQueue } = await import('../queues/emailQueue');
    const job = await emailQueue.getJob(req.params.jobId);
    if (!job || job.name !== 'send-bulk') { res.status(404).json({ message: 'Job not found' }); return; }
    const bulkData = job.data as BulkEmailJob;
    if (bulkData.senderId !== req.userId) { res.status(403).json({ message: 'Access denied' }); return; }

    const state    = await job.getState();
    const progress = typeof job.progress === 'number' ? job.progress : 0;

    res.json({ jobId: job.id, state, progress, result: job.returnvalue, failedReason: job.failedReason });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

export default router;
