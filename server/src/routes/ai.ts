import { Router, Response } from 'express';
import { z } from 'zod';
import { protect, AuthRequest } from '../middleware/auth';
import { AgentRun } from '../models/AgentRun';
import { Proposal } from '../models/Proposal';
import { AiSettings, PROVIDER_NAMES, ProviderName } from '../models/AiSettings';
import { decideProposal, HumanDecision } from '../ai/corrections';
import { isAiEnabled, allowServerKeys, defaultModelRef } from '../ai/config';
import { encryptSecret, last4 } from '../ai/crypto';
import { parseModelRef, NoProviderKeyError } from '../ai/providers';
import { ContextBuilder } from '../ai/context/builder';
import { runAgent, BudgetExceededError, RunFailedError } from '../ai/runAgent';

const router = Router();
router.use(protect);

// GET /api/ai/status — whether AI features are on, for the client to gate UI.
router.get('/status', (_req: AuthRequest, res: Response): void => {
  res.json({ enabled: isAiEnabled(), serverKeysAllowed: allowServerKeys() });
});

// ---------------------------------------------------------------------------
// BYOK settings
// ---------------------------------------------------------------------------

function publicSettings(s: { keyMeta?: Record<string, { last4: string; addedAt: Date }>; customBaseUrl?: string; models?: { primary?: string; extractor?: string } } | null) {
  const providers: Record<string, { configured: boolean; last4?: string; addedAt?: Date }> = {};
  for (const p of PROVIDER_NAMES) {
    const meta = s?.keyMeta?.[p];
    providers[p] = meta ? { configured: true, last4: meta.last4, addedAt: meta.addedAt } : { configured: false };
  }
  return {
    providers,
    customBaseUrl: s?.customBaseUrl ?? null,
    models: { primary: s?.models?.primary ?? null, extractor: s?.models?.extractor ?? null },
    defaults: { primary: defaultModelRef('primary'), extractor: defaultModelRef('extractor') },
    serverKeysAllowed: allowServerKeys(),
  };
}

// GET /api/ai/settings — never returns a key, only whether one is set and its last 4.
router.get('/settings', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const s = await AiSettings.findOne({ ownerId: req.userId }).lean();
    res.json(publicSettings(s));
  } catch (err) {
    console.error('AI settings error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

const providerName = z.enum(PROVIDER_NAMES as [ProviderName, ...ProviderName[]]);
const SettingsUpdate = z.object({
  // A string sets the key; null removes it; absent leaves it alone.
  keys: z.partialRecord(providerName, z.string().min(1).max(4096).nullable()).optional(),
  customBaseUrl: z.string().url().max(1024).nullable().optional(),
  models: z.object({
    primary: z.string().max(200).nullable().optional(),
    extractor: z.string().max(200).nullable().optional(),
  }).optional(),
});

// PUT /api/ai/settings
router.put('/settings', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = SettingsUpdate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    const body = parsed.data;

    for (const ref of [body.models?.primary, body.models?.extractor]) {
      if (ref) {
        try { parseModelRef(ref); } catch (e) { res.status(400).json({ message: (e as Error).message }); return; }
      }
    }

    const s = (await AiSettings.findOne({ ownerId: req.userId }).select('+keys')) ?? new AiSettings({ ownerId: req.userId });

    if (body.keys) {
      for (const [p, value] of Object.entries(body.keys) as Array<[ProviderName, string | null | undefined]>) {
        if (value === undefined) continue;
        if (value === null) {
          s.keys[p] = undefined;
          s.keyMeta[p] = undefined;
        } else {
          s.keys[p] = encryptSecret(value.trim());
          s.keyMeta[p] = { last4: last4(value.trim()), addedAt: new Date() };
        }
      }
      s.markModified('keys');
      s.markModified('keyMeta');
    }
    if (body.customBaseUrl !== undefined) s.customBaseUrl = body.customBaseUrl ?? undefined;
    if (body.models) {
      if (body.models.primary !== undefined) s.models.primary = body.models.primary ?? undefined;
      if (body.models.extractor !== undefined) s.models.extractor = body.models.extractor ?? undefined;
      s.markModified('models');
    }
    s.updatedAt = new Date();
    await s.save();

    res.json(publicSettings(s.toObject()));
  } catch (err) {
    console.error('AI settings update error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/ai/settings/test { model?: "provider:model" | "primary" | "extractor" }
// Makes one tiny structured call with the owner's key so a misconfigured key
// or model shows up here, not inside a real feature. It is a real run and
// appears in the run log with its cost.
router.post('/settings/test', async (req: AuthRequest, res: Response): Promise<void> => {
  const model = typeof req.body?.model === 'string' && req.body.model ? req.body.model : 'primary';
  try {
    const ctx = new ContextBuilder()
      .add({ name: 'system', budgetTokens: 200, stable: true, text: 'You are verifying a connection. Answer exactly as asked.' })
      .add({ name: 'task', budgetTokens: 100, stable: false, text: 'Reply with the JSON object {"ok": true, "model": "<the model name you are>"}.' })
      .build();
    const result = await runAgent({
      kind: 'smoke',
      ownerId: req.userId!,
      model,
      effort: 'low',
      context: ctx,
      outputSchema: z.object({ ok: z.boolean(), model: z.string().optional() }),
      maxTokens: 500,
      inputRefs: { note: 'settings test' },
    });
    res.json({ ok: true, runId: result.runId, provider: result.provider, model: result.model, usage: result.usage, costUsd: result.costUsd, degraded: result.degraded });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof NoProviderKeyError ? 400 : err instanceof BudgetExceededError ? 429 : err instanceof RunFailedError ? 502 : 400;
    res.status(status).json({ ok: false, message, runId: err instanceof RunFailedError ? err.runId : undefined });
  }
});

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Proposal inbox
// ---------------------------------------------------------------------------

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
