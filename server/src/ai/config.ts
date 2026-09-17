// Feature flags and defaults for the AI layer. Everything here is read at
// call time, not import time, so tests can flip env between cases.

export function isAiEnabled(): boolean {
  return process.env.AI_ENABLED === 'true';
}

// BYOK: users bring their own provider keys. In local development it is
// convenient to fall back to keys in the server's env; in production this
// should be false so no call is ever made on the operator's account.
export function allowServerKeys(): boolean {
  return process.env.AI_ALLOW_SERVER_KEYS === 'true';
}

export type ModelTask = 'primary' | 'extractor';

// Default model per task as `provider:model`. Users can override per task in
// their AI settings.
export function defaultModelRef(task: ModelTask): string {
  if (task === 'extractor') return process.env.AI_MODEL_EXTRACTOR || 'anthropic:claude-haiku-4-5';
  return process.env.AI_MODEL_PRIMARY || 'anthropic:claude-opus-5';
}
