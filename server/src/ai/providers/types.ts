import { z } from 'zod';
import type { ProviderName } from '../../models/AiSettings';

// The neutral request/response shape every provider adapter speaks. Kept
// deliberately small: system text (with cache hints), a message list with
// tool calls and tool results, tool definitions as JSON schema, an optional
// output schema, and an effort hint. Anything provider-specific lives in the
// adapter, never in runAgent.

export type { ProviderName };

export interface SystemBlock {
  text: string;
  // Ask the provider to cache the prefix up to and including this block, if
  // it supports explicit caching. Providers with automatic prefix caching
  // simply benefit from the stable ordering.
  cacheBoundary: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export type NeutralMessage =
  | { role: 'user'; text: string }
  // `raw` carries the provider-native assistant content so it can be echoed
  // back verbatim in a tool loop (e.g. Anthropic thinking blocks). Adapters
  // use it only when it came from the same provider.
  | { role: 'assistant'; text?: string; toolCalls?: ToolCall[]; raw?: { provider: ProviderName; content: unknown } }
  | { role: 'tool_results'; results: ToolResult[] };

export interface NeutralTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type Effort = 'low' | 'medium' | 'high';

export interface CompletionRequest {
  model: string;
  system: SystemBlock[];
  messages: NeutralMessage[];
  tools?: NeutralTool[];
  outputSchema?: z.ZodType;
  maxTokens: number;
  effort?: Effort;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CompletionResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  refusalCategory?: string;
  usage: UsageTotals;
  // Cost as reported by the provider, when it reports one (OpenRouter does).
  costUsd?: number;
  // The provider's own parsed structured output, when it produced one.
  parsed?: unknown;
  // Native assistant content, for echoing back in a tool loop.
  raw?: { provider: ProviderName; content: unknown };
  // Features the adapter had to drop to get a response from this model
  // (e.g. 'json_schema', 'tools'). Recorded on the run so the receipt is honest.
  degraded: string[];
}

export interface ProviderClient {
  readonly name: ProviderName;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  // Exact prompt size when the provider can count; null otherwise.
  countTokens(req: CompletionRequest): Promise<number | null>;
}

// Rendered into the system prompt for providers without native structured
// outputs, and as belt-and-braces for those with. Zod validation after the
// call is what actually guarantees the shape.
export function jsonSchemaInstruction(schema: z.ZodType): string {
  return [
    'Respond with a single JSON object and nothing else — no prose, no code fences.',
    'It must match this JSON Schema exactly:',
    JSON.stringify(z.toJSONSchema(schema)),
  ].join('\n');
}
