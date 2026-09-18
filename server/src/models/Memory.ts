import mongoose, { Document, Schema } from 'mongoose';

// A memory item: what we believe, about whom, based on what, and how sure
// we are (doc/02-ai-architecture.md §1.1). Typed, sourced, reviewable —
// never a free-text blob.

export type MemoryScope = 'contact' | 'sender' | 'global';
export type MemoryKind = 'fact' | 'commitment' | 'preference' | 'engagement' | 'voice' | 'fingerprint';
export type MemorySource = 'agent' | 'user' | 'system';
export type MemoryStatus = 'proposed' | 'active' | 'rejected' | 'superseded';

export const MEMORY_KINDS: MemoryKind[] = ['fact', 'commitment', 'preference', 'engagement', 'voice', 'fingerprint'];

export interface IMemoryEvidence {
  emailId?: mongoose.Types.ObjectId;
  signalId?: mongoose.Types.ObjectId;
  eventIndex?: number;
  quote?: string;
}

export interface IMemory extends Document {
  ownerId: mongoose.Types.ObjectId;
  scope: MemoryScope;
  subjectId?: mongoose.Types.ObjectId;      // Contact._id when scope === 'contact'
  kind: MemoryKind;
  content: string;                          // one sentence, human-readable
  structured?: Record<string, unknown>;     // kind-specific fields
  evidence: IMemoryEvidence[];
  confidence: number;
  source: MemorySource;
  status: MemoryStatus;
  supersededBy?: mongoose.Types.ObjectId;
  createdByRunId?: mongoose.Types.ObjectId;
  proposalId?: mongoose.Types.ObjectId;     // the Proposal that carries this item's decision
  createdAt: Date;
  lastConfirmedAt?: Date;
  expiresAt?: Date;                         // commitments with a due date
}

const EvidenceSchema = new Schema<IMemoryEvidence>(
  {
    emailId: { type: Schema.Types.ObjectId, ref: 'Email' },
    signalId: { type: Schema.Types.ObjectId, ref: 'Signal' },
    eventIndex: Number,
    quote: String,
  },
  { _id: false }
);

const MemorySchema = new Schema<IMemory>({
  ownerId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  scope:      { type: String, enum: ['contact', 'sender', 'global'], required: true },
  subjectId:  { type: Schema.Types.ObjectId, ref: 'Contact' },
  kind:       { type: String, enum: MEMORY_KINDS, required: true },
  content:    { type: String, required: true, maxlength: 400 },
  structured: { type: Schema.Types.Mixed },
  evidence:   { type: [EvidenceSchema], default: [] },
  confidence: { type: Number, min: 0, max: 1, default: 0 },
  source:     { type: String, enum: ['agent', 'user', 'system'], required: true },
  status:     { type: String, enum: ['proposed', 'active', 'rejected', 'superseded'], default: 'proposed' },
  supersededBy:   { type: Schema.Types.ObjectId, ref: 'Memory' },
  createdByRunId: { type: Schema.Types.ObjectId, ref: 'AgentRun' },
  proposalId:     { type: Schema.Types.ObjectId, ref: 'Proposal' },
  createdAt:      { type: Date, default: Date.now },
  lastConfirmedAt: { type: Date },
  expiresAt:      { type: Date },
});

// Retrieval is a query, not a search: owner + contact + status, ordered by
// kind priority, confidence, recency.
MemorySchema.index({ ownerId: 1, subjectId: 1, status: 1, kind: 1 });
MemorySchema.index({ ownerId: 1, scope: 1, kind: 1, status: 1 });
MemorySchema.index({ ownerId: 1, kind: 1, status: 1, expiresAt: 1 });

export const Memory = mongoose.model<IMemory>('Memory', MemorySchema);
