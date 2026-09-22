import mongoose, { Document, Schema } from 'mongoose';

// A classifier rule for signal integrity (doc/02-ai-architecture.md §3.4).
// Proposed by the investigator with evidence, accepted by a human, consumed
// by the deterministic classifier in services/classifierService.ts. Global
// scope: a scanner fingerprint is the same for every owner.

export type PatternType = 'ua_regex' | 'ip_cidr' | 'timing_floor_ms';
export type RuleVerdict = 'automated' | 'human';
export type RuleStatus = 'proposed' | 'active' | 'retired' | 'rejected';

export interface IFingerprintRule extends Document {
  patternType: PatternType;
  pattern: string;                 // regex source, CIDR, or a number of ms
  verdict: RuleVerdict;
  signalType: 'open' | 'link_click' | 'doc_view';
  status: RuleStatus;
  confidence: number;
  reasoning?: string;
  evidence: Array<{ signalId: mongoose.Types.ObjectId }>;
  predictedEffect?: { wouldReclassify: number; matchesLabelled: { agree: number; disagree: number }; recomputedByServer: boolean; modelDisagreed?: boolean };
  proposedByRunId?: mongoose.Types.ObjectId;
  proposalId?: mongoose.Types.ObjectId;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewNote?: string;
  measured?: { precision: number; recall: number; n: number; at: Date };
  // 'seed' rules are the ones the code shipped with (README investigation).
  origin: 'seed' | 'investigator' | 'user';
  createdAt: Date;
}

const FingerprintRuleSchema = new Schema<IFingerprintRule>({
  patternType: { type: String, enum: ['ua_regex', 'ip_cidr', 'timing_floor_ms'], required: true },
  pattern:     { type: String, required: true },
  verdict:     { type: String, enum: ['automated', 'human'], required: true },
  signalType:  { type: String, enum: ['open', 'link_click', 'doc_view'], default: 'open' },
  status:      { type: String, enum: ['proposed', 'active', 'retired', 'rejected'], default: 'proposed' },
  confidence:  { type: Number, min: 0, max: 1, default: 0 },
  reasoning:   { type: String, maxlength: 1000 },
  evidence:    { type: [new Schema({ signalId: { type: Schema.Types.ObjectId, ref: 'Signal' } }, { _id: false })], default: [] },
  predictedEffect: { type: Schema.Types.Mixed },
  proposedByRunId: { type: Schema.Types.ObjectId, ref: 'AgentRun' },
  proposalId:  { type: Schema.Types.ObjectId, ref: 'Proposal' },
  reviewedBy:  { type: Schema.Types.ObjectId, ref: 'User' },
  reviewNote:  { type: String, maxlength: 500 },
  measured:    { type: Schema.Types.Mixed },
  origin:      { type: String, enum: ['seed', 'investigator', 'user'], default: 'investigator' },
  createdAt:   { type: Date, default: Date.now },
});

FingerprintRuleSchema.index({ status: 1, signalType: 1 });

export const FingerprintRule = mongoose.model<IFingerprintRule>('FingerprintRule', FingerprintRuleSchema);
