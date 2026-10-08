import { Router, Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { protect, AuthRequest } from '../middleware/auth';
import { AgentRun } from '../models/AgentRun';
import { Proposal } from '../models/Proposal';
import { AiSettings, PROVIDER_NAMES, ProviderName } from '../models/AiSettings';
import { decideProposal, HumanDecision } from '../ai/corrections';
import { isAiEnabled, allowServerKeys, defaultModelRef } from '../ai/config';
import { encryptSecret, last4 } from '../ai/crypto';
import { parseModelRef, NoProviderKeyError } from '../ai/providers';
import { ContextBuilder } from '../ai/context/builder';
import { runAgent, runEmbedding, BudgetExceededError, RunFailedError } from '../ai/runAgent';
import { UnsupportedCapabilityError } from '../ai/providers/types';

const router = Router();
router.use(protect);

// GET /api/ai/status — whether AI features are on, for the client to gate UI.
router.get('/status', (_req: AuthRequest, res: Response): void => {
  res.json({ enabled: isAiEnabled(), serverKeysAllowed: allowServerKeys() });
});

// ---------------------------------------------------------------------------
// BYOK settings
// ---------------------------------------------------------------------------

function publicSettings(s: { keyMeta?: Record<string, { last4: string; addedAt: Date }>; customBaseUrl?: string; models?: { primary?: string; extractor?: string; embedder?: string } } | null) {
  const providers: Record<string, { configured: boolean; last4?: string; addedAt?: Date }> = {};
  for (const p of PROVIDER_NAMES) {
    const meta = s?.keyMeta?.[p];
    providers[p] = meta ? { configured: true, last4: meta.last4, addedAt: meta.addedAt } : { configured: false };
  }
  return {
    providers,
    customBaseUrl: s?.customBaseUrl ?? null,
    models: { primary: s?.models?.primary ?? null, extractor: s?.models?.extractor ?? null, embedder: s?.models?.embedder ?? null },
    defaults: { primary: defaultModelRef('primary'), extractor: defaultModelRef('extractor'), embedder: defaultModelRef('embedder') },
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
    embedder: z.string().max(200).nullable().optional(),
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

    for (const ref of [body.models?.primary, body.models?.extractor, body.models?.embedder]) {
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
      if (body.models.embedder !== undefined) s.models.embedder = body.models.embedder ?? undefined;
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
    // The embedder task is not a chat model: test it with one short embedding.
    if (model === 'embedder') {
      const r = await runEmbedding({ ownerId: req.userId!, model, inputs: ['Proofbox connection test'], inputRefs: { note: 'settings test' } });
      res.json({ ok: true, runId: r.runId, provider: r.provider, model: r.model, usage: r.usage, costUsd: r.costUsd, degraded: [], dimensions: r.dimensions });
      return;
    }
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
    const message = err instanceof UnsupportedCapabilityError
      ? `${err.message}. Classification will use the extractor model instead.`
      : err instanceof Error ? err.message : String(err);
    const status = err instanceof NoProviderKeyError || err instanceof UnsupportedCapabilityError ? 400 : err instanceof BudgetExceededError ? 429 : err instanceof RunFailedError ? 502 : 400;
    res.status(status).json({ ok: false, message, runId: err instanceof RunFailedError ? err.runId : undefined });
  }
});

// ---------------------------------------------------------------------------
// Drafting and voice (Phase 2)
// ---------------------------------------------------------------------------

const DraftBody = z.object({
  contactId: z.string().length(24),
  emailId: z.string().length(24).optional(),
  rule: z.enum(['unopened', 'opened_no_reply', 'document_interest', 'your_commitment_due', 'their_commitment_due', 'renewed_interest']).optional(),
  reason: z.string().max(300).optional(),
  includeMemoryIds: z.array(z.string().length(24)).max(10).optional(),
});

// POST /api/ai/draft — a follow-up draft with a receipt. Nothing is sent.
router.post('/draft', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = DraftBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
  try {
    const { draftFollowUp } = await import('../ai/draft/followUp');
    const result = await draftFollowUp({ ownerId: req.userId!, ...parsed.data });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof NoProviderKeyError ? 400 : err instanceof BudgetExceededError ? 429 : err instanceof RunFailedError ? 502 : /not found/i.test(message) ? 404 : 400;
    res.status(status).json({ message, runId: err instanceof RunFailedError ? err.runId : undefined });
  }
});

// GET /api/ai/voice — the active voice profile, if any.
router.get('/voice', async (req: AuthRequest, res: Response): Promise<void> => {
  const { getVoiceProfile, MIN_SAMPLES } = await import('../ai/voice/profile');
  const { Email } = await import('../models/Email');
  const profile = await getVoiceProfile(req.userId!);
  const samples = await Email.countDocuments({ senderId: req.userId, direction: { $ne: 'inbound' }, textBody: { $exists: true, $ne: '' } });
  res.json({ profile: profile ? { _id: profile._id, prose: profile.content, structured: profile.structured, source: profile.source, createdAt: profile.createdAt, runId: profile.createdByRunId } : null, samples, minSamples: MIN_SAMPLES });
});

// POST /api/ai/voice — regenerate from sent mail.
router.post('/voice', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { generateVoiceProfile, MIN_SAMPLES } = await import('../ai/voice/profile');
    const out = await generateVoiceProfile(req.userId!);
    if (!out) { res.status(400).json({ message: `Need at least ${MIN_SAMPLES} sent emails with text to describe a voice.` }); return; }
    res.json({ prose: out.memory.content, structured: out.profile, runId: out.runId, status: out.memory.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof NoProviderKeyError ? 400 : err instanceof BudgetExceededError ? 429 : err instanceof RunFailedError ? 502 : 400;
    res.status(status).json({ message });
  }
});

// PUT /api/ai/voice { prose } — the user's own words become the profile.
router.put('/voice', async (req: AuthRequest, res: Response): Promise<void> => {
  const prose = typeof req.body?.prose === 'string' ? req.body.prose.trim() : '';
  if (prose.length < 20 || prose.length > 1500) { res.status(400).json({ message: 'prose must be 20–1500 characters' }); return; }
  const { setVoiceProse } = await import('../ai/voice/profile');
  const memory = await setVoiceProse(req.userId!, prose);
  res.json({ prose: memory.content, source: memory.source });
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
// Trust policy (doc/05, Elevation 3): visible thresholds and calibration
// ---------------------------------------------------------------------------

router.get('/trust', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { trustOverview } = await import('../ai/trustPolicy');
    res.json(await trustOverview(req.userId!));
  } catch (err) { res.status(500).json({ message: err instanceof Error ? err.message : 'Server error' }); }
});

const TrustBody = z.object({
  enabled: z.boolean().optional(),
  minSample: z.number().int().min(10).max(500).optional(),
  minAcceptanceRate: z.number().min(0.8).max(1).optional(),
  minConfidence: z.number().min(0.5).max(1).optional(),
});

router.put('/trust', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = TrustBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
  try {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) set[`trust.${k}`] = v;
    await AiSettings.updateOne({ ownerId: req.userId }, { $set: { ...set, updatedAt: new Date() } }, { upsert: true });
    const { trustOverview } = await import('../ai/trustPolicy');
    res.json(await trustOverview(req.userId!));
  } catch (err) { res.status(500).json({ message: err instanceof Error ? err.message : 'Server error' }); }
});

// ---------------------------------------------------------------------------
// Replay reports (doc/05, Elevation 4)
// ---------------------------------------------------------------------------

router.get('/replays', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { ReplayReport } = await import('../models/ReplayReport');
    res.json(await ReplayReport.find({ ownerId: req.userId }).sort({ createdAt: -1 }).limit(50).select('-rows').lean());
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

router.get('/replays/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { ReplayReport } = await import('../models/ReplayReport');
    const r = mongoose.Types.ObjectId.isValid(req.params.id) ? await ReplayReport.findOne({ _id: req.params.id, ownerId: req.userId }).lean() : null;
    if (!r) { res.status(404).json({ message: 'Report not found' }); return; }
    res.json(r);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

const ReplayBody = z.object({
  kind: z.enum(['extract_memory', 'draft_follow_up', 'contact_brief', 'voice_profile', 'classify', 'digest']).optional(),
  sinceDays: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(5).default(3),
  model: z.string().max(200).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  judge: z.boolean().optional(),
  drift: z.boolean().optional(),
});

// POST /api/ai/replays: a small replay now (at most 5 runs), or a drift
// check across kinds. Variants are a CLI concern (files in the repo).
router.post('/replays', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = ReplayBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
  try {
    const { replaySample, runDriftReplay } = await import('../ai/replay');
    const { kind, sinceDays, limit, model, effort, judge, drift } = parsed.data;
    if (drift || !kind) { res.json(await runDriftReplay(req.userId!, { perKind: limit, days: sinceDays })); return; }
    res.json(await replaySample(req.userId!, { kind, since: new Date(Date.now() - sinceDays * 86_400_000), limit, model, effort, judge, trigger: 'user' }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof NoProviderKeyError ? 400 : err instanceof BudgetExceededError ? 429 : 400;
    res.status(status).json({ message });
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
