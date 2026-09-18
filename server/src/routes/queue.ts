import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth';
import { QUEUE_RULES, QueueRule } from '../models/QueueState';
import { buildQueue, snoozeItem, dismissItem, DEFAULT_THRESHOLDS } from '../services/queueService';

const router = Router();
router.use(protect);

// GET /api/queue — the follow-through queue: rules with reasons, no model.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const items = await buildQueue(req.userId!);
    res.json({ items, thresholds: DEFAULT_THRESHOLDS });
  } catch (err) {
    console.error('Queue error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

function parseRef(req: AuthRequest): { rule: QueueRule; emailId?: string; memoryId?: string } | null {
  const rule = req.params.rule as QueueRule;
  if (!QUEUE_RULES.includes(rule)) return null;
  const { emailId, memoryId } = req.body as { emailId?: string; memoryId?: string };
  if (!emailId && !memoryId) return null;
  return { rule, emailId, memoryId };
}

// POST /api/queue/:rule/snooze { emailId? | memoryId?, days? }
router.post('/:rule/snooze', async (req: AuthRequest, res: Response): Promise<void> => {
  const ref = parseRef(req);
  if (!ref) { res.status(400).json({ message: 'rule and emailId or memoryId are required' }); return; }
  const days = Math.min(Math.max(Number(req.body?.days ?? 3), 1), 60);
  await snoozeItem(req.userId!, ref.rule, ref, new Date(Date.now() + days * 86_400_000));
  res.json({ ok: true, until: new Date(Date.now() + days * 86_400_000) });
});

// POST /api/queue/:rule/dismiss { emailId? | memoryId? }
router.post('/:rule/dismiss', async (req: AuthRequest, res: Response): Promise<void> => {
  const ref = parseRef(req);
  if (!ref) { res.status(400).json({ message: 'rule and emailId or memoryId are required' }); return; }
  await dismissItem(req.userId!, ref.rule, ref);
  res.json({ ok: true, cooldownDays: DEFAULT_THRESHOLDS.dismissCooldownDays });
});

export default router;
