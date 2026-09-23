import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  emailAddress: string;
  createdAt: Date;
  // Gmail OAuth — lets this user send real tracked mail as their own gmail.com
  // address via the Gmail API, instead of relaying through a third-party ESP
  // (which Gmail's DMARC policy would reject for a gmail.com From address).
  googleAccessToken?: string;
  googleRefreshToken?: string;
  googleTokenExpiry?: Date;
  gmailAddress?: string;
  // Enterprise tier — if set, this user sends through their organization's
  // own SendGrid account (domain-authenticated by the enterprise at
  // onboarding) instead of needing to connect a personal Gmail account.
  organizationId?: mongoose.Types.ObjectId;
  // Gmail read grant (Phase 4): a second, separate consent for
  // gmail.readonly, never widened from the send grant. Tokens are encrypted
  // at rest (utils/secrets) and hidden from queries unless selected.
  gmailRead?: IGmailReadGrant;
  // Digest window: when the owner last looked, and the queue keys at that
  // moment so the next digest can say what appeared and what resolved.
  digest?: { lastSeenAt?: Date; queueKeys?: string[] };
  comparePassword(candidate: string): Promise<boolean>;
}

export interface IGmailReadGrant {
  address: string;
  refreshToken?: string;   // encrypted, select:false
  accessToken?: string;    // encrypted, select:false
  tokenExpiry?: Date;
  scope: string;
  grantedAt: Date;
  syncEnabled: boolean;
  historyId?: string;
  initialSyncDone: boolean;
  lastSyncAt?: Date;
  lastSyncError?: string;
  syncLockUntil?: Date;
}

const GmailReadSchema = new Schema<IGmailReadGrant>({
  address:         { type: String, required: true, lowercase: true },
  refreshToken:    { type: String, select: false },
  accessToken:     { type: String, select: false },
  tokenExpiry:     { type: Date },
  scope:           { type: String, default: '' },
  grantedAt:       { type: Date, default: Date.now },
  syncEnabled:     { type: Boolean, default: true },
  historyId:       { type: String },
  initialSyncDone: { type: Boolean, default: false },
  lastSyncAt:      { type: Date },
  lastSyncError:   { type: String },
  syncLockUntil:   { type: Date },
}, { _id: false });

const UserSchema = new Schema<IUser>({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  emailAddress: { type: String, required: true, unique: true, lowercase: true, trim: true },
  createdAt: { type: Date, default: Date.now },
  googleAccessToken:  { type: String, select: false },
  googleRefreshToken: { type: String, select: false },
  googleTokenExpiry:  { type: Date, select: false },
  gmailAddress:       { type: String },
  organizationId:     { type: Schema.Types.ObjectId, ref: 'Organization' },
  gmailRead:          { type: GmailReadSchema },
  digest:             { type: new Schema({ lastSeenAt: Date, queueKeys: { type: [String], default: [] } }, { _id: false }) },
});

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

UserSchema.methods.comparePassword = function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

export const User = mongoose.model<IUser>('User', UserSchema);
