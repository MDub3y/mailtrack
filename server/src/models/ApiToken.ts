import mongoose, { Document, Schema } from 'mongoose';

// Stored, individually revocable read tokens for MCP clients (Phase 6).
// Only a hash is kept; the token itself is shown once at creation.

export interface IApiToken extends Document {
  ownerId: mongoose.Types.ObjectId;
  name: string;
  hash: string;           // sha256 of the token
  prefix: string;         // first 10 characters, for recognition in the list
  scope: 'mcp';
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
  revokedAt?: Date;
}

const ApiTokenSchema = new Schema<IApiToken>({
  ownerId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name:       { type: String, required: true, maxlength: 60 },
  hash:       { type: String, required: true, unique: true },
  prefix:     { type: String, required: true },
  scope:      { type: String, enum: ['mcp'], default: 'mcp' },
  createdAt:  { type: Date, default: Date.now },
  lastUsedAt: { type: Date },
  expiresAt:  { type: Date },
  revokedAt:  { type: Date },
});

ApiTokenSchema.index({ ownerId: 1, createdAt: -1 });

export const ApiToken = mongoose.model<IApiToken>('ApiToken', ApiTokenSchema);
