import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth';
import { Email } from '../models/Email';
import { User } from '../models/User';

const router = Router();
router.use(protect);

// POST /api/emails/send
// Delivers the email internally — no SMTP, no SendGrid.
// Finds the recipient by their platform emailAddress, stores one document
// visible to both sender (outbox) and recipient (inbox).
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

    const sender = await User.findById(req.userId);
    if (!sender) { res.status(404).json({ message: 'Sender not found' }); return; }

    // Recipient must be a registered user on this platform
    const recipient = await User.findOne({ emailAddress: to.toLowerCase().trim() });
    if (!recipient) {
      res.status(404).json({
        message: `No user found with address "${to}". They must be registered on this platform.`,
      });
      return;
    }

    if (recipient._id.toString() === req.userId) {
      res.status(400).json({ message: 'You cannot send an email to yourself.' });
      return;
    }

    const now = new Date();

    const email = await Email.create({
      senderId:    sender._id,
      recipientId: recipient._id,
      from: sender.emailAddress,
      to:   recipient.emailAddress,
      subject,
      htmlBody: htmlBody || '',
      textBody: textBody || '',
      attachments: attachments || [],
      // Delivered the moment it hits our DB — no SMTP hop needed
      status: 'delivered',
      events: [
        { type: 'sent',      timestamp: now },
        { type: 'delivered', timestamp: now },
      ],
    });

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

// PATCH /api/emails/:id/open
// Called by the recipient's client when they open an email.
// Marks status as 'opened' so the sender's polling picks it up.
router.patch('/:id/open', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const email = await Email.findOne({
      _id: req.params.id,
      recipientId: req.userId,   // only the actual recipient can mark as opened
    });

    if (!email) { res.status(404).json({ message: 'Email not found' }); return; }
    if (email.status === 'opened') { res.json(email); return; } // idempotent

    email.status = 'opened';
    email.events.push({ type: 'opened', timestamp: new Date() });
    await email.save();

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

    // Import queue lazily to avoid circular deps
    const { emailQueue } = await import('../queues/emailQueue');
    const job = await emailQueue.add('send-bulk', {
      senderId:           req.userId!,
      senderEmailAddress: sender.emailAddress,
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
    if (!job) { res.status(404).json({ message: 'Job not found' }); return; }
    if (job.data.senderId !== req.userId) { res.status(403).json({ message: 'Access denied' }); return; }

    const state    = await job.getState();
    const progress = typeof job.progress === 'number' ? job.progress : 0;

    res.json({ jobId: job.id, state, progress, result: job.returnvalue, failedReason: job.failedReason });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

export default router;
