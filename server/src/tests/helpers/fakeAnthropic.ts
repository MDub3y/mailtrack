import Anthropic from '@anthropic-ai/sdk';

// A scripted stand-in for the Anthropic client. Each call to
// messages.stream(...).finalMessage() pops the next scripted turn; the tests
// assert on what runAgent did with it. countTokens returns a deterministic
// number so receipts can be checked for exactness.

export interface ScriptedTurn {
  // What the "model" replies with. Text is sent as a single text block;
  // toolUses become tool_use blocks and set stop_reason to 'tool_use'.
  text?: string;
  json?: unknown;                 // convenience: JSON.stringify'd into text
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason?: Anthropic.StopReason;
  refusalCategory?: string;
  usage?: Partial<Anthropic.Usage>;
}

export interface FakeClient {
  client: Anthropic;
  requests: Anthropic.MessageStreamParams[];   // every request runAgent made
  countTokensCalls: number;
}

function usageOf(u: Partial<Anthropic.Usage> = {}): Anthropic.Usage {
  return {
    input_tokens: u.input_tokens ?? 100,
    output_tokens: u.output_tokens ?? 20,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
    inference_geo: null,
  } as Anthropic.Usage;
}

function messageOf(turn: ScriptedTurn, model: string): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  const text = turn.json !== undefined ? JSON.stringify(turn.json) : turn.text;
  if (text !== undefined) content.push({ type: 'text', text, citations: null } as Anthropic.TextBlock);
  for (const t of turn.toolUses ?? []) {
    content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input } as Anthropic.ToolUseBlock);
  }
  const stop_reason: Anthropic.StopReason = turn.stopReason ?? (turn.toolUses?.length ? 'tool_use' : 'end_turn');
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: stop_reason === 'refusal'
      ? ({ type: 'refusal', category: turn.refusalCategory ?? 'other', explanation: 'scripted' } as unknown as Anthropic.Message['stop_details'])
      : null,
    usage: usageOf(turn.usage),
  } as unknown as Anthropic.Message;
}

export function fakeAnthropic(script: ScriptedTurn[], opts: { countTokens?: number | 'fail' } = {}): FakeClient {
  const queue = [...script];
  const requests: Anthropic.MessageStreamParams[] = [];
  const state = { countTokensCalls: 0 };

  const messages = {
    stream(params: Anthropic.MessageStreamParams) {
      requests.push(params);
      const turn = queue.shift();
      if (!turn) throw new Error('fakeAnthropic: script exhausted');
      return {
        finalMessage: async () => messageOf(turn, params.model),
      };
    },
    async countTokens(): Promise<Anthropic.MessageTokensCount> {
      state.countTokensCalls += 1;
      if (opts.countTokens === 'fail') throw new Error('count_tokens unavailable');
      return { input_tokens: opts.countTokens ?? 123 } as Anthropic.MessageTokensCount;
    },
  };

  const client = { messages } as unknown as Anthropic;
  return {
    client,
    requests,
    get countTokensCalls() { return state.countTokensCalls; },
  };
}
