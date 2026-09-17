import OpenAI from 'openai';
import { z } from 'zod';
import type { CompletionRequest, CompletionResponse, ProviderClient, ProviderName, StopReason, ToolCall } from './types';
import { jsonSchemaInstruction } from './types';

// One adapter for everything that speaks the OpenAI Chat Completions shape:
// OpenAI itself, OpenRouter, and any custom endpoint (Ollama, LM Studio,
// Groq, Together, a gateway). Capabilities are not assumed: if a model
// rejects `response_format` or `tools`, the request is retried without that
// feature and the drop is recorded in `degraded` so the run log shows it.

type CompatName = Exclude<ProviderName, 'anthropic'>;

const DEFAULT_BASE_URLS: Partial<Record<CompatName, string>> = {
  openrouter: 'https://openrouter.ai/api/v1',
};

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

function toParams(name: CompatName, req: CompletionRequest, drop: Set<string>): ChatParams {
  const systemText = [
    ...req.system.map((b) => b.text),
    // Always include the schema in the prompt: some compat models honour
    // response_format loosely, and it costs little.
    ...(req.outputSchema ? [jsonSchemaInstruction(req.outputSchema)] : []),
  ].join('\n\n');

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (systemText) messages.push({ role: 'system', content: systemText });
  for (const m of req.messages) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: m.text ?? null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
          : {}),
      });
    } else {
      for (const r of m.results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
      }
    }
  }

  const params: ChatParams = {
    model: req.model,
    messages,
    max_completion_tokens: req.maxTokens,
  };

  if (req.tools?.length && !drop.has('tools')) {
    params.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  if (req.outputSchema && !drop.has('json_schema')) {
    params.response_format = {
      type: 'json_schema',
      json_schema: { name: 'output', schema: z.toJSONSchema(req.outputSchema) as Record<string, unknown>, strict: false },
    };
  }

  if (req.effort && !drop.has('reasoning')) {
    if (name === 'openai') {
      params.reasoning_effort = req.effort;
    } else {
      // OpenRouter's unified reasoning parameter; harmless on models without it.
      (params as ChatParams & { reasoning?: { effort: string } }).reasoning = { effort: req.effort };
    }
  }

  if (name === 'openrouter') {
    // Ask OpenRouter to include the actual cost in usage.
    (params as ChatParams & { usage?: { include: boolean } }).usage = { include: true };
  }

  return params;
}

function mapStop(reason: string | null | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'content_filter': return 'refusal';
    default: return reason ? 'other' : 'end_turn';
  }
}

// Which feature a 400 is complaining about, if any. Providers word these
// differently; the match is deliberately loose.
function unsupportedFeature(err: unknown): string | null {
  if (!(err instanceof OpenAI.APIError) || err.status !== 400) return null;
  const msg = (err.message || '').toLowerCase();
  if (/response_format|json_schema|structured output/.test(msg)) return 'json_schema';
  if (/tools|tool_choice|function/.test(msg)) return 'tools';
  if (/reasoning/.test(msg)) return 'reasoning';
  return null;
}

// `clientForTests` lets the adapter tests drive the mapping with a scripted
// SDK stand-in. Product code never passes it.
export function openaiCompatProvider(name: CompatName, apiKey: string, baseURL?: string, clientForTests?: OpenAI): ProviderClient {
  const resolvedBase = baseURL || DEFAULT_BASE_URLS[name];
  if (name === 'custom' && !resolvedBase && !clientForTests) throw new Error('custom provider requires a base URL');
  const client = clientForTests ?? new OpenAI({
    apiKey: apiKey || 'not-needed', // local endpoints often need no key but the SDK insists on a string
    ...(resolvedBase ? { baseURL: resolvedBase } : {}),
    ...(name === 'openrouter' ? { defaultHeaders: { 'HTTP-Referer': 'https://github.com/MDub3y/mailtrack', 'X-Title': 'MailTrack' } } : {}),
  });

  return {
    name,
    async complete(req): Promise<CompletionResponse> {
      const drop = new Set<string>();
      // At most three retries, one per droppable feature.
      for (let attempt = 0; attempt < 4; attempt++) {
        const params = toParams(name, req, drop);
        let completion: OpenAI.Chat.Completions.ChatCompletion;
        try {
          completion = await client.chat.completions.create(params);
        } catch (err) {
          const feature = unsupportedFeature(err);
          if (feature && !drop.has(feature)) { drop.add(feature); continue; }
          throw err;
        }

        const choice = completion.choices[0];
        const msg = choice?.message;
        const toolCalls: ToolCall[] = (msg?.tool_calls ?? [])
          .filter((c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => c.type === 'function')
          .map((c) => {
            let input: unknown = {};
            try { input = JSON.parse(c.function.arguments || '{}'); } catch { input = { _raw: c.function.arguments }; }
            return { id: c.id, name: c.function.name, input };
          });

        const u = completion.usage;
        const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
        const reportedCost = (u as (typeof u & { cost?: number }) | undefined)?.cost;
        const text = typeof msg?.content === 'string' ? msg.content : '';

        return {
          text,
          toolCalls,
          stopReason: mapStop(choice?.finish_reason, toolCalls.length > 0),
          usage: {
            input: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
            output: u?.completion_tokens ?? 0,
            cacheRead: cached,
            cacheWrite: 0,
          },
          costUsd: typeof reportedCost === 'number' ? reportedCost : undefined,
          degraded: [...drop],
        };
      }
      throw new Error('provider request failed after dropping unsupported features');
    },
    async countTokens(): Promise<number | null> {
      return null; // no pre-call counting on the Chat Completions shape
    },
  };
}
