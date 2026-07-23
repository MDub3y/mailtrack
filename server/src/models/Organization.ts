import mongoose, { Document, Schema } from 'mongoose';

export interface IOrganization extends Document {
  name: string;
  domain: string;
  sendgridApiKey: string;
  fromEmail: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
}

const OrganizationSchema = new Schema<IOrganization>({
  name:      { type: String, required: true, trim: true },
  domain:    { type: String, required: true, lowercase: true, trim: true },
  // Enterprise's own SendGrid API key, used to send as their already
  // domain-authenticated (SPF/DKIM) address — never returned in any API
  // response.
  sendgridApiKey: { type: String, required: true, select: false },
  fromEmail:      { type: String, required: true, lowercase: true, trim: true },
  createdBy:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt:      { type: Date, default: Date.now },
});

export const Organization = mongoose.model<IOrganization>('Organization', OrganizationSchema);
