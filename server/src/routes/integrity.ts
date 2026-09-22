import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { protect, AuthRequest } from '../middleware/auth';
import { Signal } from '../models/Signal';
import { FingerprintRule } from '../models/FingerprintRule';
import { Proposal } from '../models/Proposal';
import { labelSignal, loadActiveRules, SEED_RULES } from '../services/classifierService';
import { computeMetrics, seedEvents, labelledFromDb } from '../ai/evals/classifier';
import { NoProviderKeyError } from '../ai/providers';
import { BudgetExceededError, RunFailedError } from '../ai/runAgent';
import '../ai/investigate/investigator'; // registers the fingerprint_rule applier

// Signal integrity (doc/05 Elevation 1): the classifier's measured accuracy,
// its rules, the investigator's proposals, and human labels on events.

const router = Router();
router.use(protect);

// GET /api/integrity — metrics over labelled events, rules, pending proposals, volume.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rules = await loadActiveRules(true);
    const labelled = [...seedEvents(), ...(await labelledFromDb())];
    const metrics = computeMetrics(labelled, rules);
    const [active, proposed, rejected] = await Promise.all([
      FingerprintRule.find({ status: 'active' }).sort({ createdAt: -1 }).lean(),
      FingerprintRule.find({ status: 'proposed' }).sort({ createdAt: -1 }).lean(),
      FingerprintRule.find({ status: 'rejected' }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);
    const proposalByRule = new Map((await Proposal.find({ ownerId: req.userId, kind: 'fingerprint_rule', status: 'pending' }).lean()).map((p) => [(p.payload as { ruleId: string }).ruleId, p._id.toString()]));
    const since = new Date(Date.now() - 30 * 86_400_000);
    const volume = await Signal.aggregate<{ _id: string; n: number }>([
      { $match: { ownerId: new mongoose.Types.ObjectId(req.userId), type: 'open', at: { $gte: since } } },
      { $group: { _id: '$integrity.verdict', n: { $sum: 1 } } },
    ]);
    res.json({
      metrics: { ...metrics, misses: metrics.misses.slice(0, 20) },
      seedHeuristics: SEED_RULES,
      rules: { active, proposed: proposed.map((r) => ({ ...r, proposalId: proposalByRule.get(r._id.toString()) ?? r.proposalId?.toString() })), rejected },
      volume30d: Object.fromEntries(volume.map((v) => [v._id, v.n])),
    });
  } catch (err) {
    console.error('Integrity error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/integrity/signals/:id/label { label: 'human' | 'automated' }
router.post('/signals/:id/label', async (req: AuthRequest, res: Response): Promise<void> => {
  const { label } = req.body as { label?: string };
  if (label !== 'human' && label !== 'automated') { res.status(400).json({ message: 'label must be human or automated' }); return; }
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(400).json({ message: 'invalid signal id' }); return; }
  try {
    const signal = await labelSignal(req.userId!, req.params.id, label);
    if (!signal) { res.status(404).json({ message: 'Open event not found' }); return; }
    res.json({ ok: true, signalId: signal._id, verdict: signal.integrity.verdict, label: signal.integrity.label });
  } catch (err) {
    console.error('Label error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/integrity/email/:emailId/opens — open signals for one email, for the labelling UI.
router.get('/email/:emailId/opens', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!mongoose.isValidObjectId(req.params.emailId)) { res.status(400).json({ message: 'invalid email id' }); return; }
  const rows = await Signal.find({ ownerId: req.userId, emailId: req.params.emailId, type: 'open' }).sort({ at: 1 }).lean();
  res.json(rows.map((s) => ({ _id: s._id, at: s.at, verdict: s.integrity.verdict, label: s.integrity.label ?? null, userAgent: (s.payload as { userAgent?: string }).userAgent, msSinceCreated: (s.payload as { msSinceCreated?: number }).msSinceCreated, matchedBy: (s.payload as { matchedBy?: string }).matchedBy ?? null, eventIndex: (s.payload as { eventIndex?: number }).eventIndex })));
});

// POST /api/integrity/investigate — on-demand investigation of current anomalies.
router.post('/investigate', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { investigate, selectCandidates } = await import('../ai/investigate/investigator');
    const candidates = await selectCandidates(req.userId!);
    if (!candidates.length) { res.json({ ran: false, message: 'No anomalous open events to investigate right now.', candidates: 0 }); return; }
    const out = await investigate(req.userId!, { candidates });
    res.json({ ran: true, ...out });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof NoProviderKeyError ? 400 : err instanceof BudgetExceededError ? 429 : err instanceof RunFailedError ? 502 : 400;
    res.status(status).json({ message, runId: err instanceof RunFailedError ? err.runId : undefined });
  }
});

// POST /api/integrity/reclassify — re-run the classifier over this owner's history now.
router.post('/reclassify', async (req: AuthRequest, res: Response): Promise<void> => {
  const { reclassifyOpens } = await import('../services/classifierService');
  res.json(await reclassifyOpens({ ownerId: req.userId! }));
});

export default router;
