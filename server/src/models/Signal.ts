import mongoose, { Document, Schema } from 'mongoose';

// One row per observation about a contact, whatever produced it
// (doc/05-iteration-2.md, Elevation 1). Email.events[] and Document.views[]
// are still written for compatibility; everything above the capture layer
// (engagement memory, the queue, the brief, the investigator) reads Signals.

export type SignalType =
  | 'sent' | 'delivered' | 'failed'
  | 'open' | 'link_click'
  | 'doc_view' | 'page_dwell'
  | 'reply' | 'bounce'
  | 'external';

export const SIGNAL_TYPES: SignalType[] = [
  'sent', 'delivered', 'failed', 'open', 'link_click', 'doc_view', 'page_dwell', 'reply', 'bounce', 'external',
];

export type IntegrityVerdict = 'human' | 'automated' | 'unknown';
export type SignalSource = 'pixel' | 'viewer' | 'redirect' | 'gmail' | 'webhook' | 'system' | 'backfill' | 'demo';

export interface ISignal extends Document {
  ownerId: mongoose.Types.ObjectId;
  contactId: mongoose.Types.ObjectId;
  emailId?: mongoose.Types.ObjectId;
  documentId?: mongoose.Types.ObjectId;
  type: SignalType;
  at: Date;
  payload: Record<string, unknown>;
  integrity: {
    verdict: IntegrityVerdict;
    ruleId?: mongoose.Types.ObjectId;
    label?: 'human' | 'automated';
  };
  source: SignalSource;
  dedupeKey: string;
  createdAt: Date;
}

const SignalSchema = new Schema<ISignal>({
  ownerId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  contactId:  { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
  emailId:    { type: Schema.Types.ObjectId, ref: 'Email' },
  documentId: { type: Schema.Types.ObjectId, ref: 'Document' },
  type:       { type: String, enum: SIGNAL_TYPES, required: true },
  at:         { type: Date, required: true },
  payload:    { type: Schema.Types.Mixed, default: {} },
  integrity: {
    verdict: { type: String, enum: ['human', 'automated', 'unknown'], default: 'unknown' },
    ruleId:  { type: Schema.Types.ObjectId, ref: 'FingerprintRule' },
    label:   { type: String, enum: ['human', 'automated'] },
  },
  source:     { type: String, required: true },
  dedupeKey:  { type: String, required: true, unique: true },
  createdAt:  { type: Date, default: Date.now },
}, { minimize: false }); // keep an empty payload as {} instead of dropping the field

// Timeline per contact; the queue and engagement queries; the digest's "since".
SignalSchema.index({ ownerId: 1, contactId: 1, at: -1 });
SignalSchema.index({ ownerId: 1, type: 1, at: -1 });
SignalSchema.index({ emailId: 1, type: 1 });

export const Signal = mongoose.model<ISignal>('Signal', SignalSchema);
