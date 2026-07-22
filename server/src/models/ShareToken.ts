import mongoose, { Document, Schema } from 'mongoose';

export interface IShareToken extends Document {
  token: string;
  documentId: mongoose.Types.ObjectId;
  passwordHash?: string;
  expiresAt?: Date;
  accessCount: number;
  createdAt: Date;
}

const ShareTokenSchema = new Schema<IShareToken>({
  token:        { type: String, required: true, unique: true },
  documentId:   { type: Schema.Types.ObjectId, ref: 'Document', required: true },
  passwordHash: { type: String },
  expiresAt:    { type: Date },
  accessCount:  { type: Number, default: 0 },
  createdAt:    { type: Date, default: Date.now },
});

// token already has a unique index from field-level `unique: true`
ShareTokenSchema.index({ documentId: 1, createdAt: -1 });

export const ShareToken = mongoose.model<IShareToken>('ShareToken', ShareTokenSchema);
