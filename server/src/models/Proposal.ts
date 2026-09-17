import mongoose, { Document, Schema } from 'mongoose';

// The single primitive for "the agent wants to change something". Memory
// items, brief updates, fingerprint rules, threshold changes, voice updates
// and drafts all flow through here (doc/05-iteration-2.md, Elevation 3).
//
// In Phase 0 nothing produces proposals yet; the model and the trust policy
// exist so that every later phase writes to one place from the start.

export type ProposalKind =
  | 'memory_item'
  | 'memory_supersede'
  | 'draft'
  | 'fingerprint_rule'
  | 'queue_threshold'
  | 'voice_update'
  | 'brief';

export const PROPOSAL_KINDS: ProposalKind[] = [
  'memory_item', 'memory_supersede', 'draft', 'fingerprint_rule', 'queue_threshold', 'voice_update', 'brief',
];

// Kinds the trust policy is allowed to auto-apply once acceptance is earned.
// 'draft' is deliberately absent: there is no branch in the policy for it.
export const REVERSIBLE_KINDS: ReadonlySet<ProposalKind> = new Set<ProposalKind>([
  'memory_item', 'memory_supersede', 'queue_threshold', 'voice_update', 'brief',
]);

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'auto_accepted' | 'expired';

export interface IProposalEvidence {
  signalId?: string;
  memoryId?: string;
  emailId?: string;
  eventIndex?: number;
  quote?: string;
}

export interface IProposal extends Document {
  ownerId: mongoose.Types.ObjectId;
  kind: ProposalKind;
  payload: unknown;
  evidence: IProposalEvidence[];
  confidence: number;
  runId: mongoose.Types.ObjectId;
  status: ProposalStatus;
  decidedBy?: mongoose.Types.ObjectId | 'policy';
  decidedAt?: Date;
  reason?: string;
  createdAt: Date;
}

const EvidenceSchema = new Schema<IProposalEvidence>(
  { signalId: String, memoryId: String, emailId: String, eventIndex: Number, quote: String },
  { _id: false }
);

const ProposalSchema = new Schema<IProposal>({
  ownerId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  kind:       { type: String, enum: PROPOSAL_KINDS, required: true },
  payload:    { type: Schema.Types.Mixed, required: true },
  evidence:   { type: [EvidenceSchema], default: [] },
  confidence: { type: Number, min: 0, max: 1, default: 0 },
  runId:      { type: Schema.Types.ObjectId, ref: 'AgentRun', required: true },
  status:     { type: String, enum: ['pending', 'accepted', 'rejected', 'auto_accepted', 'expired'], default: 'pending' },
  decidedBy:  { type: Schema.Types.Mixed },
  decidedAt:  { type: Date },
  reason:     { type: String },
  createdAt:  { type: Date, default: Date.now },
});

ProposalSchema.index({ ownerId: 1, status: 1, createdAt: -1 });
ProposalSchema.index({ ownerId: 1, kind: 1, decidedAt: -1 });

export const Proposal = mongoose.model<IProposal>('Proposal', ProposalSchema);
