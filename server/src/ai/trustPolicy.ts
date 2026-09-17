import mongoose from 'mongoose';
import { Proposal, ProposalKind, REVERSIBLE_KINDS } from '../models/Proposal';

// Decides whether a proposal is applied immediately or waits for a human.
// Phase 0: everything is pending. The shape is here so later phases only add
// the measured-acceptance branch, and so the constraint below is visible from
// day one: kinds outside REVERSIBLE_KINDS never reach the auto-accept branch,
// regardless of any rate — there is no code path for them.
//
// Full rule (doc/05-iteration-2.md, Elevation 3):
//   auto-accept if kind is reversible
//     and acceptance rate for (owner, kind) over the last N decided ≥ threshold
//     and N ≥ minimum sample
//     and confidence ≥ the calibrated cutoff for this owner

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
}

export function trustConfig(): TrustPolicyConfig {
  return {
    enabled: process.env.AI_TRUST_POLICY_ENABLED === 'true',
    minSample: Number(process.env.AI_TRUST_MIN_SAMPLE || 50),
    minAcceptanceRate: Number(process.env.AI_TRUST_MIN_ACCEPTANCE || 0.95),
    minConfidence: Number(process.env.AI_TRUST_MIN_CONFIDENCE || 0.8),
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

  const cfg = trustConfig();
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
