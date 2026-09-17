import mongoose from 'mongoose';
import { AiSettings } from '../../models/AiSettings';
import type { ProviderName } from '../../models/AiSettings';
import { PROVIDER_NAMES } from '../../models/AiSettings';
import { decryptSecret } from '../crypto';
import { allowServerKeys, defaultModelRef, ModelTask } from '../config';
import { anthropicProvider } from './anthropic';
import { openaiCompatProvider } from './openaiCompat';
import type { ProviderClient } from './types';

export * from './types';

// Turns "who is calling, for which task" into a ready provider client with
// that owner's key. This is the BYOK seam: nothing else in ai/ knows where
// keys come from.

export class NoProviderKeyError extends Error {
  constructor(public provider: ProviderName) {
    super(`No API key configured for provider "${provider}". Add one in AI settings.`);
  }
}

export interface ModelRef {
  provider: ProviderName;
  model: string;
  ref: string; // "provider:model"
}

export function parseModelRef(ref: string): ModelRef {
  const i = ref.indexOf(':');
  if (i <= 0) throw new Error(`model ref must be "provider:model", got "${ref}"`);
  const provider = ref.slice(0, i) as ProviderName;
  const model = ref.slice(i + 1);
  if (!PROVIDER_NAMES.includes(provider)) throw new Error(`unknown provider "${provider}" in "${ref}"`);
  if (!model) throw new Error(`empty model in "${ref}"`);
  return { provider, model, ref };
}

export interface Resolved {
  client: ProviderClient;
  provider: ProviderName;
  model: string;
  ref: string;
  keySource: 'owner' | 'server' | 'none';
}

const SERVER_KEY_ENV: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  custom: 'CUSTOM_LLM_API_KEY',
};

let testOverride: ProviderClient | null = null;
// Test seam: every resolve returns this client. Never called from product code.
export function __setProviderForTests(client: ProviderClient | null): void {
  testOverride = client;
}

export function buildClient(provider: ProviderName, apiKey: string, baseUrl?: string): ProviderClient {
  if (provider === 'anthropic') return anthropicProvider(apiKey, baseUrl);
  return openaiCompatProvider(provider, apiKey, baseUrl);
}

// `modelOrTask` is a task name ('primary' | 'extractor') resolved through the
// owner's settings and server defaults, or an explicit "provider:model" ref.
export async function resolveProvider(ownerId: string | mongoose.Types.ObjectId, modelOrTask: ModelTask | string): Promise<Resolved> {
  const settings = await AiSettings.findOne({ ownerId }).select('+keys').lean();

  let ref: string;
  if (modelOrTask === 'primary' || modelOrTask === 'extractor') {
    ref = settings?.models?.[modelOrTask] || defaultModelRef(modelOrTask);
  } else {
    ref = modelOrTask;
  }
  const parsed = parseModelRef(ref);

  if (testOverride) {
    return { client: testOverride, provider: parsed.provider, model: parsed.model, ref, keySource: 'owner' };
  }

  const stored = settings?.keys?.[parsed.provider];
  let apiKey: string | undefined;
  let keySource: Resolved['keySource'] = 'none';
  if (stored) {
    apiKey = decryptSecret(stored);
    keySource = 'owner';
  } else if (allowServerKeys() && process.env[SERVER_KEY_ENV[parsed.provider]]) {
    apiKey = process.env[SERVER_KEY_ENV[parsed.provider]];
    keySource = 'server';
  }

  // A custom endpoint may legitimately have no key (a local Ollama).
  if (!apiKey && parsed.provider !== 'custom') throw new NoProviderKeyError(parsed.provider);

  const baseUrl = parsed.provider === 'custom'
    ? settings?.customBaseUrl || process.env.CUSTOM_LLM_BASE_URL
    : undefined;
  if (parsed.provider === 'custom' && !baseUrl) {
    throw new Error('custom provider needs a base URL. Set it in AI settings.');
  }

  return {
    client: buildClient(parsed.provider, apiKey ?? '', baseUrl),
    provider: parsed.provider,
    model: parsed.model,
    ref,
    keySource,
  };
}
