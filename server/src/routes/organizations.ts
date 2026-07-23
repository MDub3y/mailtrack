import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { protect, AuthRequest } from '../middleware/auth';
import { Organization } from '../models/Organization';
import { User } from '../models/User';

const router = Router();
router.use(protect);

// POST /api/organizations
// Enterprise onboarding: the org provides its own SendGrid API key + a
// domain-authenticated From address. The creating user is enrolled as the
// first member — every member then sends through this org's SendGrid
// account instead of needing to connect a personal Gmail account.
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, domain, sendgridApiKey, fromEmail } = req.body as {
      name: string; domain: string; sendgridApiKey: string; fromEmail: string;
    };

    if (!name || !domain || !sendgridApiKey || !fromEmail) {
      res.status(400).json({ message: 'name, domain, sendgridApiKey, and fromEmail are required' });
      return;
    }

    const user = await User.findById(req.userId);
    if (!user) { res.status(404).json({ message: 'User not found' }); return; }
    if (user.organizationId) {
      res.status(400).json({ message: 'You already belong to an organization' });
      return;
    }

    const org = await Organization.create({
      name,
      domain: domain.toLowerCase().trim(),
      sendgridApiKey,
      fromEmail: fromEmail.toLowerCase().trim(),
      createdBy: user._id,
    });

    user.organizationId = org._id as mongoose.Types.ObjectId;
    await user.save();

    res.status(201).json({ _id: org._id, name: org.name, domain: org.domain, fromEmail: org.fromEmail });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// POST /api/organizations/join
// Lets another employee join an already-onboarded organization by ID —
// no per-employee OAuth or credential setup, they inherit the org's
// SendGrid-based sending the moment they join.
router.post('/join', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { organizationId } = req.body as { organizationId: string };
    if (!organizationId) { res.status(400).json({ message: 'organizationId is required' }); return; }

    const org = await Organization.findById(organizationId);
    if (!org) { res.status(404).json({ message: 'Organization not found' }); return; }

    const user = await User.findById(req.userId);
    if (!user) { res.status(404).json({ message: 'User not found' }); return; }
    if (user.organizationId) {
      res.status(400).json({ message: 'You already belong to an organization' });
      return;
    }

    user.organizationId = org._id as mongoose.Types.ObjectId;
    await user.save();

    res.json({ _id: org._id, name: org.name, domain: org.domain, fromEmail: org.fromEmail });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// GET /api/organizations/me
router.get('/me', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.userId);
    if (!user?.organizationId) { res.status(404).json({ message: 'No organization' }); return; }

    const org = await Organization.findById(user.organizationId);
    if (!org) { res.status(404).json({ message: 'No organization' }); return; }

    res.json({ _id: org._id, name: org.name, domain: org.domain, fromEmail: org.fromEmail });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

export default router;
