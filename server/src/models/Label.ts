import mongoose, { Document, Schema } from 'mongoose';
import { RUN_KINDS, RunKind } from './AgentRun';

// A human judgement about something the system produced, stored so evals and
// calibration grow from real usage (doc/05-iteration-2.md, Elevation 2).
// Written only by ai/corrections.ts.

export type LabelVerdict = 'accepted' | 'rejected' | 'edited' | 'reverted' | 'human' | 'automated';

export interface ILabel extends Document {
  ownerId: mongoose.Types.ObjectId;
  runKind: RunKind;
  runId?: mongoose.Types.ObjectId;
  proposalId?: mongoose.Types.ObjectId;
  verdict: LabelVerdict;
  // What was proposed and, for edits, what the human changed it to.
  before?: unknown;
  after?: unknown;
  confidence?: number;       // the model's confidence at proposal time, for calibration
  labeledBy: mongoose.Types.ObjectId | 'policy';
  createdAt: Date;
}

const LabelSchema = new Schema<ILabel>({
  ownerId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  runKind:    { type: String, enum: RUN_KINDS, required: true },
  runId:      { type: Schema.Types.ObjectId, ref: 'AgentRun' },
  proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal' },
  verdict:    { type: String, enum: ['accepted', 'rejected', 'edited', 'reverted', 'human', 'automated'], required: true },
  before:     { type: Schema.Types.Mixed },
  after:      { type: Schema.Types.Mixed },
  confidence: { type: Number },
  labeledBy:  { type: Schema.Types.Mixed, required: true },
  createdAt:  { type: Date, default: Date.now },
});

LabelSchema.index({ ownerId: 1, runKind: 1, createdAt: -1 });

export const Label = mongoose.model<ILabel>('Label', LabelSchema);
