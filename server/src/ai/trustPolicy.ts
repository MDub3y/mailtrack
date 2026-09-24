import mongoose from 'mongoose';
import { Proposal, ProposalKind, REVERSIBLE_KINDS } from '../models/Proposal';
import { Label } from '../models/Label';
import { AiSettings } from '../models/AiSettings';

// Decides whether a proposal is applied immediately or waits for a human.
// Kinds outside REVERSIBLE_KINDS never reach the auto-accept branch,
// regardless of any rate: there is no code path for them.
//
// Full rule (doc/05-iteration-2.md, Elevation 3):
//   auto-accept if kind is reversible
//     and acceptance rate for (owner, kind) over the last N decided ≥ threshold
//     and N ≥ minimum sample
//     and confidence ≥ the cutoff
//
// Since Phase 6 the policy is on by default: nothing changes until an
// owner has decided enough proposals of a kind, and the thresholds are
// theirs to see and set (AI settings → Trust). AI_TRUST_POLICY_ENABLED=false
// switches it off server-wide.

export interface TrustDecision {
  outcome: 'pending' | 'auto_accept';
  reason: string;
  acceptanceRate?: number;
  sample?: number;
}

export interface TrustPolicyConfig {
  minSample: number;
  minAcceptanceRate: number;
  minConfidence: number;
  enabled: boolean;
  source: { enabled: 'server' | 'owner' | 'default'; thresholds: 'server' | 'owner' | 'default' };
}

export const TRUST_DEFAULTS = { minSample: 50, minAcceptanceRate: 0.95, minConfidence: 0.8 };
export const TRUST_LIMITS = { minSample: [10, 500], minAcceptanceRate: [0.8, 1], minConfidence: [0.5, 1] } as const;

function serverConfig(): TrustPolicyConfig {
  const env = process.env.AI_TRUST_POLICY_ENABLED;
  return {
    enabled: env === undefined || env === '' ? true : env === 'true',
    minSample: Number(process.env.AI_TRUST_MIN_SAMPLE || TRUST_DEFAULTS.minSample),
    minAcceptanceRate: Number(process.env.AI_TRUST_MIN_ACCEPTANCE || TRUST_DEFAULTS.minAcceptanceRate),
    minConfidence: Number(process.env.AI_TRUST_MIN_CONFIDENCE || TRUST_DEFAULTS.minConfidence),
    source: { enabled: env === undefined || env === '' ? 'default' : 'server', thresholds: process.env.AI_TRUST_MIN_SAMPLE || process.env.AI_TRUST_MIN_ACCEPTANCE || process.env.AI_TRUST_MIN_CONFIDENCE ? 'server' : 'default' },
  };
}

// Server-wide switch and defaults, then the owner's own choices. A server
// that disabled the policy stays disabled whatever the owner sets.
export async function trustConfig(ownerId?: string | mongoose.Types.ObjectId): Promise<TrustPolicyConfig> {
  const base = serverConfig();
  if (!ownerId) return base;
  const s = await AiSettings.findOne({ ownerId }).select('trust').lean();
  const t = s?.trust;
  if (!t) return base;
  const clamp = (v: number | undefined, [lo, hi]: readonly [number, number], d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const ownThresholds = typeof t.minSample === 'number' || typeof t.minAcceptanceRate === 'number' || typeof t.minConfidence === 'number';
  return {
    enabled: base.enabled && (t.enabled ?? true),
    minSample: clamp(t.minSample, TRUST_LIMITS.minSample, base.minSample),
    minAcceptanceRate: clamp(t.minAcceptanceRate, TRUST_LIMITS.minAcceptanceRate, base.minAcceptanceRate),
    minConfidence: clamp(t.minConfidence, TRUST_LIMITS.minConfidence, base.minConfidence),
    source: { enabled: !base.enabled ? base.source.enabled : typeof t.enabled === 'boolean' ? 'owner' : base.source.enabled, thresholds: ownThresholds ? 'owner' : base.source.thresholds },
  };
}

export async function measuredAcceptance(
  ownerId: string | mongoose.Types.ObjectId,
  kind: ProposalKind,
  window: number
): Promise<{ rate: number; sample: number }> {
  const recent = await Proposal.find({
    ownerId,
    kind,
    status: { $in: ['accepted', 'rejected', 'auto_accepted'] },
  })
    .sort({ decidedAt: -1 })
    .limit(window)
    .select('status')
    .lean();

  if (recent.length === 0) return { rate: 0, sample: 0 };
  // A reverted auto-accept is stored as 'rejected' by ai/corrections.ts, so it
  // lowers the rate exactly like a human rejection would.
  const accepted = recent.filter((p) => p.status === 'accepted' || p.status === 'auto_accepted').length;
  return { rate: accepted / recent.length, sample: recent.length };
}

export async function decideTrust(
  ownerId: string | mongoose.Types.ObjectId,
  kind: ProposalKind,
  confidence: number
): Promise<TrustDecision> {
  if (!REVERSIBLE_KINDS.has(kind)) {
    return { outcome: 'pending', reason: `${kind} is never auto-applied` };
  }

  const cfg = await trustConfig(ownerId);
  if (!cfg.enabled) {
    return { outcome: 'pending', reason: 'trust policy disabled' };
  }

  const { rate, sample } = await measuredAcceptance(ownerId, kind, cfg.minSample);
  if (sample < cfg.minSample) {
    return { outcome: 'pending', reason: `sample ${sample} < ${cfg.minSample}`, acceptanceRate: rate, sample };
  }
  if (rate < cfg.minAcceptanceRate) {
    return { outcome: 'pending', reason: `acceptance ${rate.toFixed(2)} < ${cfg.minAcceptanceRate}`, acceptanceRate: rate, sample };
  }
  if (confidence < cfg.minConfidence) {
    return { outcome: 'pending', reason: `confidence ${confidence.toFixed(2)} < ${cfg.minConfidence}`, acceptanceRate: rate, sample };
  }
  return { outcome: 'auto_accept', reason: `earned: ${sample} decided, ${(rate * 100).toFixed(0)}% accepted`, acceptanceRate: rate, sample };
}

// ---------------------------------------------------------------- the visible side

export interface TrustKindView {
  kind: ProposalKind;
  reversible: boolean;
  sample: number;
  acceptanceRate: number;
  earned: boolean;
  reason: string;
  autoAccepted30d: number;
  reverted30d: number;
  pending: number;
}

export interface CalibrationBucket { from: number; to: number; n: number; accepted: number; rate: number }

export interface TrustOverview {
  config: TrustPolicyConfig;
  kinds: TrustKindView[];
  // Confidence at proposal time against what the human then decided, per
  // kind, in buckets of 0.1. The calibrated cutoff is the lowest bucket
  // whose acceptance is at or above the acceptance threshold.
  calibration: Record<string, { buckets: CalibrationBucket[]; suggestedMinConfidence?: number; n: number }>;
}

const KINDS: ProposalKind[] = ['memory_item', 'memory_supersede', 'brief', 'voice_update', 'queue_threshold', 'fingerprint_rule', 'draft'];

export async function trustOverview(ownerId: string | mongoose.Types.ObjectId): Promise<TrustOverview> {
  const config = await trustConfig(ownerId);
  const since30 = new Date(Date.now() - 30 * 86_400_000);
  const kinds: TrustKindView[] = [];
  for (const kind of KINDS) {
    const reversible = REVERSIBLE_KINDS.has(kind);
    const { rate, sample } = await measuredAcceptance(ownerId, kind, config.minSample);
    const d = reversible ? await decideTrust(ownerId, kind, 1) : { outcome: 'pending' as const, reason: `${kind} is never auto-applied` };
    const [autoAccepted30d, reverted30d, pending] = await Promise.all([
      Proposal.countDocuments({ ownerId, kind, status: 'auto_accepted', decidedAt: { $gte: since30 } }),
      Label.countDocuments({ ownerId, verdict: 'reverted', createdAt: { $gte: since30 }, proposalId: { $in: await Proposal.find({ ownerId, kind }).distinct('_id') } }),
      Proposal.countDocuments({ ownerId, kind, status: 'pending' }),
    ]);
    kinds.push({ kind, reversible, sample, acceptanceRate: Number(rate.toFixed(3)), earned: d.outcome === 'auto_accept', reason: d.reason, autoAccepted30d, reverted30d, pending });
  }

  const calibration: TrustOverview['calibration'] = {};
  const labels = await Label.find({ ownerId, labeledBy: { $ne: 'policy' }, verdict: { $in: ['accepted', 'rejected', 'edited', 'reverted'] }, confidence: { $exists: true }, proposalId: { $exists: true } }).select('confidence verdict proposalId').lean();
  const proposals = await Proposal.find({ _id: { $in: labels.map((l) => l.proposalId) } }).select('kind').lean();
  const kindOf = new Map(proposals.map((p) => [p._id.toString(), p.kind]));
  for (const kind of KINDS) {
    const mine = labels.filter((l) => kindOf.get(l.proposalId!.toString()) === kind);
    if (!mine.length) continue;
    const buckets: CalibrationBucket[] = [];
    for (let i = 0; i < 10; i++) {
      const from = i / 10, to = (i + 1) / 10;
      const inB = mine.filter((l) => l.confidence! >= from && (l.confidence! < to || (i === 9 && l.confidence! <= 1)));
      if (!inB.length) continue;
      const accepted = inB.filter((l) => l.verdict === 'accepted' || l.verdict === 'edited').length;
      buckets.push({ from, to, n: inB.length, accepted, rate: Number((accepted / inB.length).toFixed(3)) });
    }
    const good = buckets.filter((b) => b.n >= 5 && b.rate >= config.minAcceptanceRate);
    calibration[kind] = { buckets, n: mine.length, suggestedMinConfidence: good.length ? good[0].from : undefined };
  }
  return { config, kinds, calibration };
}
