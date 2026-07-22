import mongoose, { Document, Schema } from 'mongoose';

export interface ITrackedLink {
  linkId: string;
  originalUrl: string;
  clickCount: number;
}

export type EmailStatus = 'sent' | 'delivered' | 'opened';
export type EventType = 'sent' | 'delivered' | 'opened';

export interface IEmailEvent {
  type: EventType;
  timestamp: Date;
}

export interface IEmail extends Document {
  senderId: mongoose.Types.ObjectId;
  recipientId: mongoose.Types.ObjectId;   // the recipient user on this platform
  from: string;                            // display name / email of sender
  to: string;                              // display name / email of recipient
  subject: string;
  htmlBody: string;
  textBody: string;
  status: EmailStatus;
  events: IEmailEvent[];
  attachments: Array<{ documentId: string; name: string; shareUrl: string }>;
  createdAt: Date;
}

const EmailEventSchema = new Schema<IEmailEvent>(
  {
    type: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const EmailSchema = new Schema<IEmail>({
  senderId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  from:    { type: String, required: true },
  to:      { type: String, required: true },
  subject: { type: String, default: '' },
  htmlBody: { type: String, default: '' },
  textBody: { type: String, default: '' },
  status: {
    type: String,
    enum: ['sent', 'delivered', 'opened'],
    default: 'sent',
  },
  events: { type: [EmailEventSchema], default: [] },
  attachments: {
    type: [new Schema({ documentId: String, name: String, shareUrl: String }, { _id: false })],
    default: [],
  },
  createdAt: { type: Date, default: Date.now },
});

// Fast lookup for sender's outbox and recipient's inbox
EmailSchema.index({ senderId:    1, createdAt: -1 });
EmailSchema.index({ recipientId: 1, createdAt: -1 });

export const Email = mongoose.model<IEmail>('Email', EmailSchema);
