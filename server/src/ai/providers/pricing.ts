import type { UsageTotals } from './types';

// USD per million tokens for models whose price we know. Cost is a
// best-effort estimate unless the provider reports it (OpenRouter does);
// the run records which (`costSource`). Unknown models get cost 0 and
// costSource 'unknown' — never a made-up number.

const PRICE_PER_MTOK: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  'anthropic:claude-opus-5':    { input: 5.0, output: 25.0, cacheRead: 0.5,  cacheWrite: 6.25 },
  'anthropic:claude-sonnet-5':  { input: 2.0, output: 10.0, cacheRead: 0.2,  cacheWrite: 2.5 },
  'anthropic:claude-haiku-4-5': { input: 1.0, output: 5.0,  cacheRead: 0.1,  cacheWrite: 1.25 },
};

export type CostSource = 'provider' | 'table' | 'unknown';

export function estimateCost(ref: string, u: UsageTotals, reported?: number): { costUsd: number; costSource: CostSource } {
  if (typeof reported === 'number' && Number.isFinite(reported)) {
    return { costUsd: reported, costSource: 'provider' };
  }
  const p = PRICE_PER_MTOK[ref] ?? PRICE_PER_MTOK[envOverrideKey(ref)];
  if (!p) return { costUsd: 0, costSource: 'unknown' };
  const M = 1_000_000;
  const costUsd =
    (u.input * p.input) / M +
    (u.output * p.output) / M +
    (u.cacheRead * (p.cacheRead ?? p.input * 0.1)) / M +
    (u.cacheWrite * (p.cacheWrite ?? p.input * 1.25)) / M;
  return { costUsd, costSource: 'table' };
}

// Operators can add prices for their own models via env, e.g.
//   AI_PRICE_openrouter_meta-llama/llama-3.3-70b-instruct=0.12,0.30
function envOverrideKey(ref: string): string {
  const raw = process.env[`AI_PRICE_${ref.replace(':', '_')}`];
  if (!raw) return ref;
  const [input, output] = raw.split(',').map(Number);
  if (Number.isFinite(input) && Number.isFinite(output)) PRICE_PER_MTOK[ref] = { input, output };
  return ref;
}
