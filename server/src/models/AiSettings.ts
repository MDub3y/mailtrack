import mongoose, { Document, Schema } from 'mongoose';

// BYOK: each owner's provider keys, endpoints, and model choices. Keys are
// stored encrypted (ai/crypto.ts) and never selected by default.
//
// Providers:
//   anthropic   native Messages API
//   openai      OpenAI API
//   openrouter  OpenAI-compatible, hundreds of models incl. free ones
//   custom      any OpenAI-compatible endpoint the user names: a local Ollama
//               or LM Studio, Groq, Together, a company gateway, etc.

export type ProviderName = 'anthropic' | 'openai' | 'openrouter' | 'custom';
export const PROVIDER_NAMES: ProviderName[] = ['anthropic', 'openai', 'openrouter', 'custom'];

export interface IProviderKeyMeta {
  last4: string;
  addedAt: Date;
}

export interface IAiSettings extends Document {
  ownerId: mongoose.Types.ObjectId;
  // Encrypted with ai/crypto.ts. select: false.
  keys: Partial<Record<ProviderName, string>>;
  // Safe to return: which providers are configured and the key's last 4.
  keyMeta: Partial<Record<ProviderName, IProviderKeyMeta>>;
  // For the custom provider only: the OpenAI-compatible base URL.
  customBaseUrl?: string;
  // Per-task model refs as `provider:model`, overriding server defaults.
  models: { primary?: string; extractor?: string };
  updatedAt: Date;
}

const KeyMetaSchema = new Schema<IProviderKeyMeta>({ last4: String, addedAt: Date }, { _id: false });

const AiSettingsSchema = new Schema<IAiSettings>({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  keys: {
    type: new Schema({ anthropic: String, openai: String, openrouter: String, custom: String }, { _id: false }),
    select: false,
    default: {},
  },
  keyMeta: {
    type: new Schema({ anthropic: KeyMetaSchema, openai: KeyMetaSchema, openrouter: KeyMetaSchema, custom: KeyMetaSchema }, { _id: false }),
    default: {},
  },
  customBaseUrl: { type: String },
  models: {
    type: new Schema({ primary: String, extractor: String }, { _id: false }),
    default: {},
  },
  updatedAt: { type: Date, default: Date.now },
});

export const AiSettings = mongoose.model<IAiSettings>('AiSettings', AiSettingsSchema);
