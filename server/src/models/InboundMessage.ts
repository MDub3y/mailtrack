import mongoose, { Document, Schema } from 'mongoose';

// One row per message read from the user's mailbox (doc/plan Phase 4):
// minimal content, header facts, the deterministic reply match, the cheap
// classification, and the triage state that gates the expensive step.
// Messages that enter a contact's thread are additionally promoted to an
// Email with direction 'inbound'; the rest live only here.

export type TriageStatus = 'unclassified' | 'classified' | 'awaiting_approval' | 'processed' | 'skipped' | 'failed';
export type ClassifierBackendName = 'headers' | 'embeddings' | 'llm' | 'local' | 'human';
export type MatchedBy = 'thread' | 'message_id' | 'pixel_url';

export interface IInboundHeaders {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  listUnsubscribe: boolean;
  listId?: string;
  precedence?: string;
  autoSubmitted?: string;
  hasCalendarPart: boolean;
  hasAttachments: boolean;
}

export interface IClassification {
  categoryKey: string;
  categoryId?: mongoose.Types.ObjectId;
  confidence: number;
  backend: ClassifierBackendName;
  modelRef?: string;
  runId?: mongoose.Types.ObjectId;
  scores?: Record<string, number>;
  reason?: string;
  at: Date;
  correctedFrom?: string;
  correctedBy?: mongoose.Types.ObjectId;
}

export interface IInboundMessage extends Document {
  ownerId: mongoose.Types.ObjectId;
  gmailMessageId: string;
  gmailThreadId: string;
  historyId?: string;
  internalDate: Date;
  from: { address: string; name?: string };
  to: string[];
  subject: string;
  snippet: string;
  textExcerpt: string;          // plain text, quoted reply stripped, capped
  labelIds: string[];
  headers: IInboundHeaders;
  matchedEmailId?: mongoose.Types.ObjectId;
  matchedBy?: MatchedBy;
  contactId?: mongoose.Types.ObjectId;
  classification?: IClassification;
  triage: {
    status: TriageStatus;
    policyAtDecision?: 'never' | 'ask' | 'auto';
    processedAt?: Date;
    processRunId?: mongoose.Types.ObjectId;
    error?: string;
  };
  emailId?: mongoose.Types.ObjectId;
  createdAt: Date;
}

export const INBOX_EXCERPT_CHARS = 1500;

const HeadersSchema = new Schema<IInboundHeaders>(
  {
    messageId: String, inReplyTo: String, references: { type: [String], default: [] },
    listUnsubscribe: { type: Boolean, default: false }, listId: String, precedence: String, autoSubmitted: String,
    hasCalendarPart: { type: Boolean, default: false }, hasAttachments: { type: Boolean, default: false },
  },
  { _id: false }
);

const ClassificationSchema = new Schema<IClassification>(
  {
    categoryKey: { type: String, required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
    confidence: { type: Number, min: 0, max: 1, default: 0 },
    backend: { type: String, enum: ['headers', 'embeddings', 'llm', 'local', 'human'], required: true },
    modelRef: String,
    runId: { type: Schema.Types.ObjectId, ref: 'AgentRun' },
    scores: { type: Schema.Types.Mixed },
    reason: String,
    at: { type: Date, default: Date.now },
    correctedFrom: String,
    correctedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

const InboundMessageSchema = new Schema<IInboundMessage>({
  ownerId:        { type: Schema.Types.ObjectId, ref: 'User', required: true },
  gmailMessageId: { type: String, required: true },
  gmailThreadId:  { type: String, required: true },
  historyId:      { type: String },
  internalDate:   { type: Date, required: true },
  from:           { type: new Schema({ address: { type: String, required: true, lowercase: true }, name: String }, { _id: false }), required: true },
  to:             { type: [String], default: [] },
  subject:        { type: String, default: '' },
  snippet:        { type: String, default: '', maxlength: 400 },
  textExcerpt:    { type: String, default: '', maxlength: INBOX_EXCERPT_CHARS + 20 },
  labelIds:       { type: [String], default: [] },
  headers:        { type: HeadersSchema, default: () => ({ references: [], listUnsubscribe: false, hasCalendarPart: false, hasAttachments: false }) },
  matchedEmailId: { type: Schema.Types.ObjectId, ref: 'Email' },
  matchedBy:      { type: String, enum: ['thread', 'message_id', 'pixel_url'] },
  contactId:      { type: Schema.Types.ObjectId, ref: 'Contact' },
  classification: { type: ClassificationSchema },
  triage: {
    type: new Schema({
      status: { type: String, enum: ['unclassified', 'classified', 'awaiting_approval', 'processed', 'skipped', 'failed'], default: 'unclassified' },
      policyAtDecision: { type: String, enum: ['never', 'ask', 'auto'] },
      processedAt: Date,
      processRunId: { type: Schema.Types.ObjectId, ref: 'AgentRun' },
      error: String,
    }, { _id: false }),
    default: () => ({ status: 'unclassified' }),
  },
  emailId:        { type: Schema.Types.ObjectId, ref: 'Email' },
  createdAt:      { type: Date, default: Date.now },
}, { minimize: false });

InboundMessageSchema.index({ ownerId: 1, gmailMessageId: 1 }, { unique: true });
InboundMessageSchema.index({ ownerId: 1, 'classification.categoryKey': 1, internalDate: -1 });
InboundMessageSchema.index({ ownerId: 1, 'triage.status': 1, internalDate: -1 });
InboundMessageSchema.index({ ownerId: 1, internalDate: -1 });
// Retention is a query in the sync job (delete rows older than
// INBOX_RETENTION_DAYS that were never promoted), not a TTL index, so
// promoted rows and their audit trail are never expired by the database.

export const InboundMessage = mongoose.model<IInboundMessage>('InboundMessage', InboundMessageSchema);
