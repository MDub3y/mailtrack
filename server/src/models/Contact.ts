import mongoose, { Document, Schema } from 'mongoose';

// The anchor for contact-scoped memory. Created the first time an owner
// sends to an address; scoped to the owner (two users emailing the same
// address never share history).

export interface IContactBrief {
  text: string;
  citedMemoryIds: mongoose.Types.ObjectId[];
  basedOnSignalCount: number;
  generatedAt: Date;
  runId: mongoose.Types.ObjectId;
}

export interface IContact extends Document {
  ownerId: mongoose.Types.ObjectId;
  address: string;
  domain: string;
  displayName?: string;
  firstSentAt?: Date;
  lastSentAt?: Date;
  lastSignalAt?: Date;
  stats: { sent: number; opened: number; replied: number; docViews: number };
  brief?: IContactBrief;
  // Set by the brief job so a burst of signals produces one regeneration.
  briefDirtyAt?: Date;
  createdAt: Date;
}

const BriefSchema = new Schema<IContactBrief>(
  {
    text: String,
    citedMemoryIds: [{ type: Schema.Types.ObjectId, ref: 'Memory' }],
    basedOnSignalCount: Number,
    generatedAt: Date,
    runId: { type: Schema.Types.ObjectId, ref: 'AgentRun' },
  },
  { _id: false }
);

const ContactSchema = new Schema<IContact>({
  ownerId:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
  address:      { type: String, required: true, lowercase: true, trim: true },
  domain:       { type: String, required: true, lowercase: true },
  displayName:  { type: String },
  firstSentAt:  { type: Date },
  lastSentAt:   { type: Date },
  lastSignalAt: { type: Date },
  stats: {
    sent:     { type: Number, default: 0 },
    opened:   { type: Number, default: 0 },
    replied:  { type: Number, default: 0 },
    docViews: { type: Number, default: 0 },
  },
  brief:        { type: BriefSchema },
  briefDirtyAt: { type: Date },
  createdAt:    { type: Date, default: Date.now },
});

ContactSchema.index({ ownerId: 1, address: 1 }, { unique: true });
ContactSchema.index({ ownerId: 1, lastSignalAt: -1 });

export const Contact = mongoose.model<IContact>('Contact', ContactSchema);
