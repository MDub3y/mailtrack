import mongoose from 'mongoose';
import { Proposal, IProposal, ProposalKind } from '../models/Proposal';
import { AgentRun, RunKind } from '../models/AgentRun';
import { Label, LabelVerdict } from '../models/Label';
import { decideTrust } from './trustPolicy';

// The correction loop's bookkeeping (doc/05-iteration-2.md, Elevation 2).
// Every human decision on a proposal becomes a Label against the run kind
// that produced it, at zero model cost. Later phases read Labels to grow the
// evals and to compute calibration; nothing here calls a model.

const KIND_TO_RUN_KIND: Record<ProposalKind, RunKind> = {
  memory_item: 'extract_memory',
  memory_supersede: 'extract_memory',
  brief: 'contact_brief',
  voice_update: 'voice_profile',
  draft: 'draft_follow_up',
  fingerprint_rule: 'investigate',
  queue_threshold: 'judge', // placeholder until a queue-tuning run kind exists
};

// Applying a decided proposal is kind-specific (a memory item becomes
// active, a rule becomes live). Kinds register an applier here so this
// module never imports the code that owns each kind.
export type ProposalApplier = (proposal: IProposal, outcome: 'accepted' | 'rejected') => Promise<void>;
const appliers = new Map<ProposalKind, ProposalApplier>();
export function registerApplier(kind: ProposalKind, fn: ProposalApplier): void {
  appliers.set(kind, fn);
}
async function apply(proposal: IProposal, outcome: 'accepted' | 'rejected'): Promise<void> {
  const fn = appliers.get(proposal.kind);
  if (fn) await fn(proposal, outcome);
}

export interface NewProposal {
  ownerId: string | mongoose.Types.ObjectId;
  kind: ProposalKind;
  payload: unknown;
  evidence?: IProposal['evidence'];
  confidence: number;
  runId: string | mongoose.Types.ObjectId;
}

// Creates the proposal and asks the trust policy whether it may be applied
// now. Applying (i.e. the side effect of an accepted proposal) is the caller's
// job in later phases; this only records the decision.
export async function submitProposal(p: NewProposal): Promise<IProposal> {
  const decision = await decideTrust(p.ownerId, p.kind, p.confidence);
  const proposal = await Proposal.create({
    ...p,
    status: decision.outcome === 'auto_accept' ? 'auto_accepted' : 'pending',
    decidedBy: decision.outcome === 'auto_accept' ? 'policy' : undefined,
    decidedAt: decision.outcome === 'auto_accept' ? new Date() : undefined,
    reason: decision.reason,
  });

  if (decision.outcome === 'auto_accept') {
    await Label.create({
      ownerId: p.ownerId,
      runKind: KIND_TO_RUN_KIND[p.kind],
      runId: p.runId,
      proposalId: proposal._id,
      verdict: 'accepted',
      before: p.payload,
      confidence: p.confidence,
      labeledBy: 'policy',
    });
    await apply(proposal, 'accepted');
  }
  return proposal;
}

// Some kinds have their own domain policy that may accept immediately
// regardless of earned trust (e.g. a memory item extracted from the sender's
// own words with a verified quote). That is a policy decision, recorded as
// such, and still labelled so acceptance rates stay honest.
export async function acceptByPolicy(proposalId: mongoose.Types.ObjectId | string, reason: string): Promise<IProposal | null> {
  const proposal = await Proposal.findById(proposalId);
  if (!proposal || proposal.status !== 'pending') return proposal;
  proposal.status = 'auto_accepted';
  proposal.decidedBy = 'policy';
  proposal.decidedAt = new Date();
  proposal.reason = reason;
  await proposal.save();
  await Label.create({
    ownerId: proposal.ownerId, runKind: KIND_TO_RUN_KIND[proposal.kind], runId: proposal.runId, proposalId: proposal._id,
    verdict: 'accepted', before: proposal.payload, confidence: proposal.confidence, labeledBy: 'policy',
  });
  await apply(proposal, 'accepted');
  return proposal;
}

export type HumanDecision = 'accept' | 'reject' | 'edit' | 'revert';

// A human's decision on a proposal. `edited` carries the corrected payload.
export async function decideProposal(
  proposalId: string,
  userId: string,
  decision: HumanDecision,
  opts: { reason?: string; edited?: unknown } = {}
): Promise<IProposal | null> {
  const proposal = await Proposal.findOne({ _id: proposalId, ownerId: userId });
  if (!proposal) return null;

  const verdict: LabelVerdict =
    decision === 'accept' ? 'accepted'
    : decision === 'edit' ? 'edited'
    : decision === 'revert' ? 'reverted'
    : 'rejected';

  // A revert of an auto-accepted proposal counts as a rejection for the
  // acceptance rate (see trustPolicy.measuredAcceptance).
  proposal.status = decision === 'accept' || decision === 'edit' ? 'accepted' : 'rejected';
  proposal.decidedBy = new mongoose.Types.ObjectId(userId);
  proposal.decidedAt = new Date();
  proposal.reason = opts.reason;
  if (decision === 'edit' && opts.edited !== undefined) {
    proposal.payload = opts.edited;
  }
  await proposal.save();

  await Label.create({
    ownerId: proposal.ownerId,
    runKind: KIND_TO_RUN_KIND[proposal.kind],
    runId: proposal.runId,
    proposalId: proposal._id,
    verdict,
    before: decision === 'edit' ? undefined : proposal.payload,
    after: decision === 'edit' ? opts.edited : undefined,
    confidence: proposal.confidence,
    labeledBy: new mongoose.Types.ObjectId(userId),
  });

  // Keep the run's record aware that a human weighed in, so the run log can
  // show "accepted / rejected" next to the output without a join.
  await AgentRun.updateOne(
    { _id: proposal.runId },
    { $set: { [`inputRefs.lastDecision`]: { proposalId: proposal._id, verdict, at: proposal.decidedAt } } }
  ).catch(() => {});

  await apply(proposal, proposal.status === 'accepted' ? 'accepted' : 'rejected');
  return proposal;
}
