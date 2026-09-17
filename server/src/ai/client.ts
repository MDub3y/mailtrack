import Anthropic from '@anthropic-ai/sdk';

// The only place the SDK client is constructed. Everything in ai/ imports it
// from here so the hot paths (routes/track.ts, dispatch, gmail) have exactly
// one import to stay away from — enforced by src/tests/importBoundary.test.ts.

export const MODELS = {
  // Judgement tasks: drafting, investigation, brief, voice.
  primary: 'claude-opus-5',
  // High-volume, narrow-schema extraction on every delivered email.
  extractor: 'claude-haiku-4-5',
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

// USD per million tokens. Cache reads are ~0.1× input, cache writes ~1.25×.
// Kept here (not in env) because it changes with the model list, not the deploy.
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5':   { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function estimateCostUsd(model: string, u: UsageTotals): number {
  const p = PRICE_PER_MTOK[model];
  if (!p) return 0;
  const perTok = (usd: number) => usd / 1_000_000;
  return (
    u.input * perTok(p.input) +
    u.cacheRead * perTok(p.input) * 0.1 +
    u.cacheWrite * perTok(p.input) * 1.25 +
    u.output * perTok(p.output)
  );
}

export function isAiEnabled(): boolean {
  return process.env.AI_ENABLED === 'true';
}

let client: Anthropic | null = null;

// Test seam: lets the integration tests drive runAgent with a scripted client
// so the loop, validation, refusal and budget paths run for real without
// network access. Never called from product code.
export function __setClientForTests(fake: Anthropic | null): void {
  client = fake;
}

// Lazy so that importing ai/ never throws at boot when the key is absent —
// only an actual run does, with a clear message.
export function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    client = new Anthropic();
  }
  return client;
}

export function usesAdaptiveThinking(model: string): boolean {
  // Haiku 4.5 still takes budget_tokens-style thinking; we simply omit thinking there.
  return model !== MODELS.extractor;
}
