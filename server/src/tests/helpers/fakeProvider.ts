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
}

export function fakeProvider(script: ScriptedTurn[], opts: { name?: ProviderName; countTokens?: number | null; throwOnCall?: Error } = {}): FakeProvider {
  const queue = [...script];
  const requests: CompletionRequest[] = [];
  const self: FakeProvider = {
    name: opts.name ?? 'anthropic',
    requests,
    countTokensCalls: 0,
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
