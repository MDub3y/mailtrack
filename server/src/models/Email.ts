import mongoose, { Document, Schema } from 'mongoose';

export interface ITrackedLink {
  linkId: string;
  originalUrl: string;
  clickCount: number;
}

export type EmailStatus = 'sent' | 'delivered' | 'opened' | 'failed';
export type EventType = 'sent' | 'delivered' | 'opened' | 'failed';

export interface IEmailEvent {
  type: EventType;
  timestamp: Date;
  userAgent?: string;
  ip?: string;
}

export interface IEmail extends Document {
  senderId: mongoose.Types.ObjectId;
  recipientId?: mongoose.Types.ObjectId;   // populated only if `to` happens to match a platform User
  from: string;                            // display name / email of sender
  to: string;                              // real external recipient address
  subject: string;
  htmlBody: string;
  textBody: string;
  status: EmailStatus;
  events: IEmailEvent[];
  attachments: Array<{ documentId: string; name: string; shareUrl: string }>;
  trackingToken: string;
  openCount: number;
  firstOpenedAt?: Date;
  lastOpenedAt?: Date;
  providerMessageId?: string;
  failureReason?: string;
  createdAt: Date;
}

const EmailEventSchema = new Schema<IEmailEvent>(
  {
    type: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    userAgent: { type: String },
    ip: { type: String },
  },
  { _id: false }
);

const EmailSchema = new Schema<IEmail>({
  senderId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  recipientId: { type: Schema.Types.ObjectId, ref: 'User' },
  from:    { type: String, required: true },
  to:      { type: String, required: true },
  subject: { type: String, default: '' },
  htmlBody: { type: String, default: '' },
  textBody: { type: String, default: '' },
  status: {
    type: String,
    enum: ['sent', 'delivered', 'opened', 'failed'],
    default: 'sent',
  },
  events: { type: [EmailEventSchema], default: [] },
  attachments: {
    type: [new Schema({ documentId: String, name: String, shareUrl: String }, { _id: false })],
    default: [],
  },
  trackingToken:     { type: String, required: true, unique: true },
  openCount:         { type: Number, default: 0 },
  firstOpenedAt:     { type: Date },
  lastOpenedAt:      { type: Date },
  providerMessageId: { type: String },
  failureReason:     { type: String },
  createdAt: { type: Date, default: Date.now },
});

// Fast lookup for sender's outbox and recipient's inbox
EmailSchema.index({ senderId:    1, createdAt: -1 });
EmailSchema.index({ recipientId: 1, createdAt: -1 });

export const Email = mongoose.model<IEmail>('Email', EmailSchema);
