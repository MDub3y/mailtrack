import mongoose, { Document, Schema } from 'mongoose';

// Snooze/dismiss state for follow-through queue items, keyed by owner,
// email, and rule (doc/02-ai-architecture.md §1.9). Dismissing suppresses
// the same rule for the same email for a cooldown so the queue does not nag.

export type QueueRule =
  | 'unopened'
  | 'opened_no_reply'
  | 'document_interest'
  | 'your_commitment_due'
  | 'their_commitment_due'
  | 'renewed_interest';

export const QUEUE_RULES: QueueRule[] = [
  'unopened', 'opened_no_reply', 'document_interest', 'your_commitment_due', 'their_commitment_due', 'renewed_interest',
];

export interface IQueueState extends Document {
  ownerId: mongoose.Types.ObjectId;
  emailId?: mongoose.Types.ObjectId;
  memoryId?: mongoose.Types.ObjectId;   // commitment rules key on the memory item
  rule: QueueRule;
  action: 'snoozed' | 'dismissed';
  until: Date;                          // hidden until this time
  createdAt: Date;
}

const QueueStateSchema = new Schema<IQueueState>({
  ownerId:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
  emailId:  { type: Schema.Types.ObjectId, ref: 'Email' },
  memoryId: { type: Schema.Types.ObjectId, ref: 'Memory' },
  rule:     { type: String, enum: QUEUE_RULES, required: true },
  action:   { type: String, enum: ['snoozed', 'dismissed'], required: true },
  until:    { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

QueueStateSchema.index({ ownerId: 1, rule: 1, emailId: 1, memoryId: 1 });

export const QueueState = mongoose.model<IQueueState>('QueueState', QueueStateSchema);
