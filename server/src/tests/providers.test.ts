import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { z } from 'zod';
import { anthropicProvider } from '../ai/providers/anthropic';
import { openaiCompatProvider } from '../ai/providers/openaiCompat';
import { parseModelRef } from '../ai/providers';
import { estimateCost } from '../ai/providers/pricing';
import type { CompletionRequest } from '../ai/providers/types';

// The adapters, driven with scripted SDK stand-ins. What matters is the
// mapping in both directions: the neutral request becomes the right native
// call, and the native response becomes the right neutral response —
// including the graceful degradation when a model rejects a feature.

const Out = z.object({ subject: z.string(), usedIds: z.array(z.string()) });

const request: CompletionRequest = {
  model: 'm',
  system: [
    { text: 'rules', cacheBoundary: false },
    { text: 'voice', cacheBoundary: true },
  ],
  messages: [
    { role: 'user', text: 'draft it' },
    { role: 'assistant', text: 'checking', toolCalls: [{ id: 'c1', name: 'get_email', input: { emailId: 'e1' } }] },
    { role: 'tool_results', results: [{ id: 'c1', content: 'body of e1' }, { id: 'c2', content: 'boom', isError: true }] },
  ],
  tools: [{ name: 'get_email', description: 'fetch', inputSchema: { type: 'object', properties: { emailId: { type: 'string' } } } }],
  outputSchema: Out,
  maxTokens: 500,
  effort: 'low',
};

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function fakeAnthropicSdk(message: Partial<Anthropic.Message>, countTokens: number | Error = 42) {
  const calls: { stream: Anthropic.MessageStreamParams[]; count: unknown[] } = { stream: [], count: [] };
  const sdk = {
    messages: {
      stream(params: Anthropic.MessageStreamParams) {
        calls.stream.push(params);
        return { finalMessage: async () => ({
          id: 'm', type: 'message', role: 'assistant', model: params.model, content: [], stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
          ...message,
        }) };
      },
      async countTokens(params: unknown) {
        calls.count.push(params);
        if (countTokens instanceof Error) throw countTokens;
        return { input_tokens: countTokens };
      },
    },
  } as unknown as Anthropic;
  return { sdk, calls };
}

test('anthropic: maps system cache boundary, tool loop messages, tools, schema, effort, thinking', async () => {
  const { sdk, calls } = fakeAnthropicSdk({
    content: [
      { type: 'text', text: '{"subject":"s","usedIds":[]}', citations: null } as Anthropic.TextBlock,
      { type: 'tool_use', id: 'c9', name: 'get_email', input: { emailId: 'e9' } } as Anthropic.ToolUseBlock,
    ],
    stop_reason: 'tool_use',
  });
  const p = anthropicProvider('key', undefined, sdk);
  const res = await p.complete({ ...request, model: 'claude-opus-5' });

  const params = calls.stream[0];
  assert.equal(params.model, 'claude-opus-5');
  assert.equal(params.max_tokens, 500);
  const system = params.system as Anthropic.TextBlockParam[];
  assert.equal(system[0].cache_control, undefined);
  assert.deepEqual(system[1].cache_control, { type: 'ephemeral' });
  assert.equal(params.messages.length, 3);
  assert.deepEqual(params.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'c1', name: 'get_email', input: { emailId: 'e1' } }] });
  assert.deepEqual(params.messages[2], { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'c1', content: 'body of e1' },
    { type: 'tool_result', tool_use_id: 'c2', content: 'boom', is_error: true },
  ] });
  assert.equal((params.tools![0] as Anthropic.Tool).name, 'get_email');
  assert.ok(params.output_config?.format);
  assert.equal(params.output_config?.effort, 'low');
  assert.deepEqual((params as { thinking?: unknown }).thinking, { type: 'adaptive' });

  assert.equal(res.stopReason, 'tool_use');
  assert.deepEqual(res.toolCalls, [{ id: 'c9', name: 'get_email', input: { emailId: 'e9' } }]);
  assert.equal(res.text, '{"subject":"s","usedIds":[]}');
  assert.deepEqual(res.usage, { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 });
  assert.equal(res.raw?.provider, 'anthropic');
  assert.deepEqual(res.degraded, []);
});

test('anthropic: echoes its own raw assistant content back in a loop, omits thinking for haiku, counts tokens', async () => {
  const rawContent = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'x' }];
  const { sdk, calls } = fakeAnthropicSdk({ stop_reason: 'end_turn' }, 77);
  const p = anthropicProvider('key', undefined, sdk);
  await p.complete({
    ...request,
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'ignored', raw: { provider: 'anthropic', content: rawContent } }, { role: 'user', text: 'again' }],
  });
  assert.equal((calls.stream[0] as { thinking?: unknown }).thinking, undefined);
  assert.deepEqual(calls.stream[0].messages[1], { role: 'assistant', content: rawContent });
  assert.equal(await p.countTokens(request), 77);
});

test('anthropic: refusal category surfaces; count_tokens failure returns null', async () => {
  const { sdk } = fakeAnthropicSdk(
    { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' } as unknown as Anthropic.Message['stop_details'] },
    new Error('nope')
  );
  const p = anthropicProvider('key', undefined, sdk);
  const res = await p.complete(request);
  assert.equal(res.stopReason, 'refusal');
  assert.equal(res.refusalCategory, 'cyber');
  assert.equal(await p.countTokens(request), null);
});

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, OpenRouter, custom)
// ---------------------------------------------------------------------------

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

function fakeOpenAiSdk(handler: (params: ChatParams, attempt: number) => Partial<OpenAI.Chat.Completions.ChatCompletion> | Error) {
  const calls: ChatParams[] = [];
  const sdk = {
    chat: { completions: {
      async create(params: ChatParams) {
        calls.push(params);
        const out = handler(params, calls.length);
        if (out instanceof Error) throw out;
        return {
          id: 'x', object: 'chat.completion', created: 0, model: params.model,
          choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: '{"subject":"s","usedIds":[]}', refusal: null } }],
          usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } },
          ...out,
        };
      },
    } },
  } as unknown as OpenAI;
  return { sdk, calls };
}

test('openai: merges system + schema instruction, maps tool loop and tools, sends response_format and reasoning_effort', async () => {
  const { sdk, calls } = fakeOpenAiSdk(() => ({}));
  const p = openaiCompatProvider('openai', 'key', undefined, sdk);
  const res = await p.complete({ ...request, model: 'gpt-5-mini' });

  const params = calls[0];
  assert.equal(params.model, 'gpt-5-mini');
  assert.equal(params.max_completion_tokens, 500);
  assert.equal(params.messages[0].role, 'system');
  const sys = params.messages[0].content as string;
  assert.match(sys, /^rules\n\nvoice\n\nRespond with a single JSON object/);
  assert.match(sys, /"additionalProperties":false/);
  assert.deepEqual(params.messages[1], { role: 'user', content: 'draft it' });
  assert.deepEqual(params.messages[2], { role: 'assistant', content: 'checking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_email', arguments: '{"emailId":"e1"}' } }] });
  assert.deepEqual(params.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'body of e1' });
  assert.deepEqual(params.messages[4], { role: 'tool', tool_call_id: 'c2', content: 'ERROR: boom' });
  assert.equal(params.tools![0].type, 'function');
  assert.equal((params.tools![0] as { function: { name: string } }).function.name, 'get_email');
  assert.equal(params.response_format?.type, 'json_schema');
  assert.equal(params.reasoning_effort, 'low');
  assert.equal((params as { usage?: unknown }).usage, undefined);

  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.text, '{"subject":"s","usedIds":[]}');
  // prompt_tokens includes the cached part; input is the uncached remainder
  assert.deepEqual(res.usage, { input: 100, output: 30, cacheRead: 20, cacheWrite: 0 });
  assert.equal(res.costUsd, undefined);
  assert.deepEqual(res.degraded, []);
});

test('openrouter: asks for cost, uses the unified reasoning param, and reports cost', async () => {
  const { sdk, calls } = fakeOpenAiSdk(() => ({ usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, cost: 0.00042 } as OpenAI.CompletionUsage }));
  const p = openaiCompatProvider('openrouter', 'key', undefined, sdk);
  const res = await p.complete({ ...request, model: 'meta-llama/llama-3.3-70b-instruct:free' });
  assert.deepEqual((calls[0] as { usage?: unknown }).usage, { include: true });
  assert.deepEqual((calls[0] as { reasoning?: unknown }).reasoning, { effort: 'low' });
  assert.equal(calls[0].reasoning_effort, undefined);
  assert.equal(res.costUsd, 0.00042);
  assert.deepEqual(res.usage, { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 });
});

test('compat: tool calls in the response map to neutral tool calls, bad JSON args are kept raw', async () => {
  const { sdk } = fakeOpenAiSdk(() => ({
    choices: [{ index: 0, finish_reason: 'tool_calls', logprobs: null, message: { role: 'assistant', content: null, refusal: null, tool_calls: [
      { id: 't1', type: 'function', function: { name: 'get_email', arguments: '{"emailId":"e1"}' } },
      { id: 't2', type: 'function', function: { name: 'get_email', arguments: '{oops' } },
    ] } }],
  }));
  const p = openaiCompatProvider('custom', '', 'http://localhost:11434/v1', sdk);
  const res = await p.complete({ ...request, model: 'llama3.2' });
  assert.equal(res.stopReason, 'tool_use');
  assert.deepEqual(res.toolCalls, [
    { id: 't1', name: 'get_email', input: { emailId: 'e1' } },
    { id: 't2', name: 'get_email', input: { _raw: '{oops' } },
  ]);
  assert.equal(res.text, '');
});

test('compat: a model that rejects response_format gets retried without it, and the drop is recorded', async () => {
  const { sdk, calls } = fakeOpenAiSdk((params) => {
    if (params.response_format) return new OpenAI.APIError(400, { error: { message: 'response_format is not supported by this model' } }, 'response_format is not supported by this model', new Headers());
    return {};
  });
  const p = openaiCompatProvider('custom', '', 'http://localhost:11434/v1', sdk);
  const res = await p.complete({ ...request, model: 'tiny' });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].response_format);
  assert.equal(calls[1].response_format, undefined);
  assert.ok(calls[1].tools); // tools were kept
  assert.deepEqual(res.degraded, ['json_schema']);
  assert.match(calls[1].messages[0].content as string, /Respond with a single JSON object/); // prompt fallback still present
});

test('compat: rejects both json_schema and tools → drops both in order; other 400s propagate', async () => {
  const { sdk, calls } = fakeOpenAiSdk((params) => {
    if (params.response_format) return new OpenAI.APIError(400, { error: { message: 'Invalid parameter: response_format' } }, 'Invalid parameter: response_format', new Headers());
    if (params.tools) return new OpenAI.APIError(400, { error: { message: 'This model does not support tools' } }, 'This model does not support tools', new Headers());
    return {};
  });
  const p = openaiCompatProvider('custom', '', 'http://x/v1', sdk);
  const res = await p.complete({ ...request, model: 'tiny' });
  assert.equal(calls.length, 3);
  assert.deepEqual(res.degraded, ['json_schema', 'tools']);

  const { sdk: sdk2 } = fakeOpenAiSdk(() => new OpenAI.APIError(401, { error: { message: 'invalid api key' } }, 'invalid api key', new Headers()));
  const p2 = openaiCompatProvider('openai', 'bad', undefined, sdk2);
  await assert.rejects(p2.complete(request), (e: unknown) => e instanceof OpenAI.APIError && e.status === 401);
});

test('compat: finish reasons map; length → max_tokens, content_filter → refusal; countTokens is null', async () => {
  for (const [reason, expected] of [['length', 'max_tokens'], ['content_filter', 'refusal'], ['stop', 'end_turn']] as const) {
    const { sdk } = fakeOpenAiSdk(() => ({ choices: [{ index: 0, finish_reason: reason, logprobs: null, message: { role: 'assistant', content: 'x', refusal: null } }] }));
    const p = openaiCompatProvider('openai', 'k', undefined, sdk);
    assert.equal((await p.complete(request)).stopReason, expected, reason);
    assert.equal(await p.countTokens(request), null);
  }
});

test('custom provider without a base URL is rejected up front', () => {
  assert.throws(() => openaiCompatProvider('custom', ''), /base URL/);
});

// ---------------------------------------------------------------------------
// Refs and pricing
// ---------------------------------------------------------------------------

test('parseModelRef handles model ids that themselves contain colons and slashes', () => {
  assert.deepEqual(parseModelRef('openrouter:meta-llama/llama-3.3-70b-instruct:free'), { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', ref: 'openrouter:meta-llama/llama-3.3-70b-instruct:free' });
  assert.deepEqual(parseModelRef('custom:llama3.2'), { provider: 'custom', model: 'llama3.2', ref: 'custom:llama3.2' });
  assert.throws(() => parseModelRef('claude-opus-5'), /provider:model/);
  assert.throws(() => parseModelRef('gemini:pro'), /unknown provider/);
  assert.throws(() => parseModelRef('openai:'), /empty model/);
});

test('estimateCost: provider-reported beats the table, table beats unknown, env override works', () => {
  const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.deepEqual(estimateCost('anthropic:claude-opus-5', u, 0.01), { costUsd: 0.01, costSource: 'provider' });
  assert.deepEqual(estimateCost('anthropic:claude-opus-5', u), { costUsd: 5, costSource: 'table' });
  assert.deepEqual(estimateCost('openai:gpt-5-mini', u), { costUsd: 0, costSource: 'unknown' });
  process.env['AI_PRICE_openrouter_some/model'] = '0.5,1.5';
  assert.deepEqual(estimateCost('openrouter:some/model', { ...u, output: 1_000_000 }), { costUsd: 2, costSource: 'table' });
  delete process.env['AI_PRICE_openrouter_some/model'];
});
