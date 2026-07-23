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
  comparePassword(candidate: string): Promise<boolean>;
}

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
