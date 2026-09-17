import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { CompletionRequest, CompletionResponse, ProviderClient, StopReason, ToolCall } from './types';

// Native Anthropic adapter: explicit cache breakpoints, structured outputs,
// adaptive thinking, exact token counting, refusal categories.

function usesAdaptiveThinking(model: string): boolean {
  // Haiku 4.5 still takes budget_tokens-style thinking; omit thinking there.
  return !/haiku/i.test(model);
}

function toParams(req: CompletionRequest): Anthropic.MessageStreamParams {
  const system: Anthropic.TextBlockParam[] = req.system.map((b) => ({
    type: 'text',
    text: b.text,
    ...(b.cacheBoundary ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));

  const messages: Anthropic.MessageParam[] = req.messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'user') return { role: 'user', content: m.text };
    if (m.role === 'assistant') {
      if (m.raw?.provider === 'anthropic') return { role: 'assistant', content: m.raw.content as Anthropic.ContentBlock[] };
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input as Record<string, unknown> });
      return { role: 'assistant', content };
    }
    return {
      role: 'user',
      content: m.results.map((r): Anthropic.ToolResultBlockParam => ({
        type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}),
      })),
    };
  });

  const tools: Anthropic.Tool[] | undefined = req.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }));

  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: system.length ? system : undefined,
    messages,
    tools,
    output_config: {
      ...(req.outputSchema ? { format: zodOutputFormat(req.outputSchema) } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
    },
    ...(usesAdaptiveThinking(req.model) ? { thinking: { type: 'adaptive' as const } } : {}),
  };
}

function mapStop(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case 'end_turn': case 'stop_sequence': return 'end_turn';
    case 'tool_use': return 'tool_use';
    case 'max_tokens': return 'max_tokens';
    case 'refusal': return 'refusal';
    default: return 'other';
  }
}

// `clientForTests` lets the adapter tests drive the mapping with a scripted
// SDK stand-in. Product code never passes it.
export function anthropicProvider(apiKey: string, baseURL?: string, clientForTests?: Anthropic): ProviderClient {
  const client = clientForTests ?? new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return {
    name: 'anthropic',
    async complete(req): Promise<CompletionResponse> {
      const params = toParams(req);
      const message = await client.messages.stream(params).finalMessage();
      const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
      const toolCalls: ToolCall[] = message.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const u = message.usage;
      const parsed = (message as Anthropic.Message & { parsed_output?: unknown }).parsed_output;
      return {
        text,
        toolCalls,
        stopReason: mapStop(message.stop_reason),
        refusalCategory: message.stop_reason === 'refusal' && message.stop_details?.type === 'refusal'
          ? message.stop_details.category ?? undefined : undefined,
        usage: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        },
        parsed: parsed ?? undefined,
        raw: { provider: 'anthropic', content: message.content },
        degraded: [],
      };
    },
    async countTokens(req): Promise<number | null> {
      try {
        const { system, messages, tools } = toParams(req);
        const res = await client.messages.countTokens({ model: req.model, system, messages, tools });
        return res.input_tokens;
      } catch {
        return null;
      }
    },
  };
}
