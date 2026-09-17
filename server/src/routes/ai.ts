import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth';
import { AgentRun } from '../models/AgentRun';
import { Proposal } from '../models/Proposal';
import { decideProposal, HumanDecision } from '../ai/corrections';
import { isAiEnabled } from '../ai/client';

const router = Router();
router.use(protect);

// GET /api/ai/status — whether AI features are on, for the client to gate UI.
router.get('/status', (_req: AuthRequest, res: Response): void => {
  res.json({ enabled: isAiEnabled() });
});

// GET /api/ai/runs — the owner's run log, newest first.
router.get('/runs', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const runs = await AgentRun.find({ ownerId: req.userId })
      .sort({ startedAt: -1 })
      .limit(100)
      .select('-steps -output')
      .lean();
    res.json(runs);
  } catch (err) {
    console.error('AI runs error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/ai/runs/:id — full detail: receipt, steps, output, usage, cost.
router.get('/runs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const run = await AgentRun.findOne({ _id: req.params.id, ownerId: req.userId }).lean();
    if (!run) { res.status(404).json({ message: 'Run not found' }); return; }
    res.json(run);
  } catch (err) {
    console.error('AI run error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/ai/proposals?status=pending — the review inbox.
router.get('/proposals', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const proposals = await Proposal.find({ ownerId: req.userId, status })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(proposals);
  } catch (err) {
    console.error('AI proposals error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/ai/proposals/:id/decide  { decision: accept|reject|edit|revert, reason?, edited? }
router.post('/proposals/:id/decide', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { decision, reason, edited } = req.body as { decision: HumanDecision; reason?: string; edited?: unknown };
    if (!['accept', 'reject', 'edit', 'revert'].includes(decision)) {
      res.status(400).json({ message: 'decision must be accept, reject, edit, or revert' });
      return;
    }
    const proposal = await decideProposal(req.params.id, req.userId!, decision, { reason, edited });
    if (!proposal) { res.status(404).json({ message: 'Proposal not found' }); return; }
    res.json(proposal);
  } catch (err) {
    console.error('AI decide error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
