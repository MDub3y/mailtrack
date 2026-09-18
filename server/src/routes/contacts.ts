import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { protect, AuthRequest } from '../middleware/auth';
import { Contact } from '../models/Contact';
import { Memory } from '../models/Memory';
import { Email } from '../models/Email';
import { timeline } from '../services/signalService';
import { addUserMemory, decideMemory } from '../ai/memory/policy';

const router = Router();
router.use(protect);

// GET /api/contacts — the owner's contacts, most recently active first.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const contacts = await Contact.find({ ownerId: req.userId }).sort({ lastSignalAt: -1, createdAt: -1 }).limit(200).lean();
    const ids = contacts.map((c) => c._id);
    const counts = await Memory.aggregate<{ _id: mongoose.Types.ObjectId; active: number; proposed: number }>([
      { $match: { ownerId: new mongoose.Types.ObjectId(req.userId), subjectId: { $in: ids }, status: { $in: ['active', 'proposed'] }, kind: { $ne: 'engagement' } } },
      { $group: { _id: '$subjectId', active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } }, proposed: { $sum: { $cond: [{ $eq: ['$status', 'proposed'] }, 1, 0] } } } },
    ]);
    const byId = new Map(counts.map((c) => [c._id.toString(), c]));
    res.json(contacts.map((c) => ({
      ...c,
      memoryCounts: (() => { const m = byId.get(c._id.toString()); return m ? { active: m.active, proposed: m.proposed } : { active: 0, proposed: 0 }; })(),
      briefText: c.brief?.text,
    })));
  } catch (err) {
    console.error('Contacts error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/contacts/:id — contact, brief, memory grouped by kind, recent emails, timeline.
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, ownerId: req.userId }).lean();
    if (!contact) { res.status(404).json({ message: 'Contact not found' }); return; }

    const [memory, emails, signals] = await Promise.all([
      Memory.find({ ownerId: req.userId, subjectId: contact._id, status: { $in: ['active', 'proposed', 'superseded'] } })
        .sort({ status: 1, confidence: -1, createdAt: -1 }).lean(),
      Email.find({ senderId: req.userId, contactId: contact._id }).sort({ createdAt: -1 }).limit(20)
        .select('_id subject status createdAt openCount firstOpenedAt attachments').lean(),
      timeline(req.userId!, contact._id, { limit: 100 }),
    ]);

    res.json({ contact, memory, emails, signals });
  } catch (err) {
    console.error('Contact error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

const UserMemory = z.object({
  kind: z.enum(['fact', 'commitment', 'preference']),
  content: z.string().min(3).max(400),
  structured: z.record(z.string(), z.unknown()).optional(),
});

// POST /api/contacts/:id/memory — a human-added item, active immediately.
router.post('/:id/memory', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, ownerId: req.userId }).select('_id');
    if (!contact) { res.status(404).json({ message: 'Contact not found' }); return; }
    const parsed = UserMemory.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: parsed.error.issues.map((i) => i.message).join('; ') }); return; }
    const memory = await addUserMemory({ ownerId: req.userId!, contactId: contact._id, ...parsed.data });
    const { enqueueBrief } = await import('../queues/aiQueue');
    enqueueBrief(contact._id.toString(), { delayMs: 5_000 }).catch(() => {});
    res.status(201).json(memory);
  } catch (err) {
    console.error('Add memory error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/contacts/:id/brief — regenerate on demand.
router.post('/:id/brief', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, ownerId: req.userId }).select('_id');
    if (!contact) { res.status(404).json({ message: 'Contact not found' }); return; }
    const { generateBrief } = await import('../ai/memory/brief');
    const out = await generateBrief(contact._id);
    if (!out) { res.json({ generated: false, message: 'Not enough memory or signals to write a brief yet.' }); return; }
    res.json({ generated: true, ...out });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ message });
  }
});

export default router;

// Memory decisions live under /api/memory so the contact page and the
// proposal inbox share one path.
export const memoryRouter = Router();
memoryRouter.use(protect);

const Decision = z.object({
  decision: z.enum(['accept', 'reject', 'edit']),
  content: z.string().min(3).max(400).optional(),
  structured: z.record(z.string(), z.unknown()).optional(),
});

// PATCH /api/memory/:id { decision, content?, structured? }
memoryRouter.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = Decision.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: parsed.error.issues.map((i) => i.message).join('; ') }); return; }
    const { decision, content, structured } = parsed.data;
    const memory = await decideMemory(req.params.id, req.userId!, decision, decision === 'edit' ? { content, structured } : undefined);
    if (!memory) { res.status(404).json({ message: 'Memory not found' }); return; }
    if (memory.subjectId) {
      const { enqueueBrief } = await import('../queues/aiQueue');
      enqueueBrief(memory.subjectId.toString(), { delayMs: 5_000 }).catch(() => {});
    }
    res.json(memory);
  } catch (err) {
    console.error('Memory decision error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});
