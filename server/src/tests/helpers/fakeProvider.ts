import type { CompletionRequest, CompletionResponse, ProviderClient, ProviderName, ToolCall, UsageTotals } from '../../ai/providers/types';

// A scripted provider. Each complete() pops the next turn; tests assert on
// what runAgent did with it. Provider-agnostic on purpose: the same tests
// cover the wrapper whichever adapter is underneath.

export interface ScriptedTurn {
  text?: string;
  json?: unknown;                 // JSON.stringify'd into text
  parsed?: unknown;               // what a provider with native structured output would return
  toolCalls?: ToolCall[];
  stopReason?: CompletionResponse['stopReason'];
  refusalCategory?: string;
  usage?: Partial<UsageTotals>;
  costUsd?: number;
  degraded?: string[];
}

export interface FakeProvider extends ProviderClient {
  requests: CompletionRequest[];
  countTokensCalls: number;
  embedRequests: string[][];
}

// Deterministic test embeddings: a small bag-of-words over a fixed vocabulary,
// so texts sharing keywords land near each other and tests can reason about
// which centroid wins without a real model.
export const TEST_VOCAB = ['unsubscribe', 'newsletter', 'receipt', 'invoice', 'order', 'meeting', 'invite', 'calendar', 'reply', 'quote', 'urgent', 'action', 'deadline', 'hello', 'thanks', 'lunch'];
export function bagOfWords(text: string): number[] {
  const lower = text.toLowerCase();
  const v: number[] = TEST_VOCAB.map((w) => (lower.includes(w) ? 1 : 0));
  const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function fakeProvider(
  script: ScriptedTurn[],
  opts: { name?: ProviderName; countTokens?: number | null; throwOnCall?: Error; embed?: ((inputs: string[]) => number[][]) | 'unsupported' | null } = {}
): FakeProvider {
  const queue = [...script];
  const requests: CompletionRequest[] = [];
  const self: FakeProvider = {
    name: opts.name ?? 'anthropic',
    requests,
    countTokensCalls: 0,
    embedRequests: [],
    ...(opts.embed === undefined || opts.embed === null ? {} : {
      async embed(req) {
        self.embedRequests.push(req.inputs);
        if (opts.embed === 'unsupported') {
          const { UnsupportedCapabilityError } = await import('../../ai/providers/types');
          throw new UnsupportedCapabilityError(self.name, 'embeddings', 'HTTP 404');
        }
        const fn = opts.embed as (inputs: string[]) => number[][];
        return { vectors: fn(req.inputs), usage: { input: req.inputs.reduce((n, s) => n + Math.ceil(s.length / 4), 0) }, costUsd: self.name === 'openrouter' ? 0.00001 * req.inputs.length : undefined };
      },
    }),
    async complete(req) {
      requests.push(req);
      if (opts.throwOnCall) throw opts.throwOnCall;
      const turn = queue.shift();
      if (!turn) throw new Error('fakeProvider: script exhausted');
      const text = turn.json !== undefined ? JSON.stringify(turn.json) : (turn.text ?? '');
      return {
        text,
        toolCalls: turn.toolCalls ?? [],
        stopReason: turn.stopReason ?? (turn.toolCalls?.length ? 'tool_use' : 'end_turn'),
        refusalCategory: turn.refusalCategory,
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, ...turn.usage },
        costUsd: turn.costUsd,
        parsed: turn.parsed,
        raw: { provider: self.name, content: [{ type: 'text', text }] },
        degraded: turn.degraded ?? [],
      };
    },
    async countTokens() {
      self.countTokensCalls += 1;
      return opts.countTokens === undefined ? 123 : opts.countTokens;
    },
  };
  return self;
}
