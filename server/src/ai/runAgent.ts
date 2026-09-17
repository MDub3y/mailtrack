import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AgentRun, IAgentRun, RunKind } from '../models/AgentRun';
import { getClient, isAiEnabled, estimateCostUsd, usesAdaptiveThinking, UsageTotals } from './client';
import { checkBudget } from './budget';
import { BuiltContext, measureExact } from './context/builder';

// The one wrapper every model call goes through (doc/02-ai-architecture.md,
// §3.1; ADR-6). Responsibilities, in order:
//   1. feature flag and daily budget check
//   2. create the AgentRun record with the context receipt
//   3. stream the call; loop over read-only tools up to maxSteps
//   4. validate the output against the schema, then against the receipt
//   5. finalise usage, cost, status
// A run that fails validation is a failed run; nothing partial is stored as output.

export class AiDisabledError extends Error {
  constructor() { super('AI features are disabled (AI_ENABLED is not "true")'); }
}
export class BudgetExceededError extends Error {
  constructor(public kind: RunKind, public spent: number, public ceiling: number) {
    super(`Daily token ceiling reached for ${kind}: ${spent} of ${ceiling} used`);
  }
}
export class RunFailedError extends Error {
  constructor(public runId: string, message: string) { super(message); }
}

export interface AgentTool {
  definition: Anthropic.Tool;
  // Tools are read-only by design. A tool that writes must not exist here.
  execute: (input: unknown) => Promise<string>;
}

export interface RunSpec<TOut> {
  kind: RunKind;
  ownerId: string | mongoose.Types.ObjectId;
  model: string;
  effort?: 'low' | 'medium' | 'high';
  context: BuiltContext;
  outputSchema: z.ZodType<TOut>;
  tools?: AgentTool[];
  maxSteps?: number;
  maxTokens?: number;
  inputRefs?: IAgentRun['inputRefs'];
  // Ids the output claims to have relied on. Every one must be in the receipt.
  citedIds?: (output: TOut) => string[];
}

export interface RunResult<TOut> {
  runId: string;
  output: TOut;
  usage: UsageTotals;
  costUsd: number;
  receipt: IAgentRun['receipt'];
}

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOKENS = 16_000;

function summarize(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function addUsage(total: UsageTotals, u: Anthropic.Usage): void {
  total.input += u.input_tokens ?? 0;
  total.output += u.output_tokens ?? 0;
  total.cacheRead += u.cache_read_input_tokens ?? 0;
  total.cacheWrite += u.cache_creation_input_tokens ?? 0;
}

export async function runAgent<TOut>(spec: RunSpec<TOut>): Promise<RunResult<TOut>> {
  if (!isAiEnabled()) throw new AiDisabledError();

  const budget = await checkBudget(spec.ownerId, spec.kind);
  if (!budget.allowed) {
    await AgentRun.create({
      ownerId: spec.ownerId,
      kind: spec.kind,
      modelId: spec.model,
      effort: spec.effort,
      status: 'refused',
      inputRefs: spec.inputRefs ?? {},
      receipt: spec.context.receipt,
      error: `budget: ${budget.spentToday} of ${budget.ceiling} tokens used today`,
      finishedAt: new Date(),
    });
    throw new BudgetExceededError(spec.kind, budget.spentToday, budget.ceiling);
  }

  const client = getClient();
  const toolDefs = spec.tools?.map((t) => t.definition);
  await measureExact(client, spec.model, spec.context, toolDefs);

  const run = await AgentRun.create({
    ownerId: spec.ownerId,
    kind: spec.kind,
    modelId: spec.model,
    effort: spec.effort,
    status: 'running',
    inputRefs: spec.inputRefs ?? {},
    receipt: spec.context.receipt,
  });

  const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const messages: Anthropic.MessageParam[] = [...spec.context.messages];
  const toolsByName = new Map((spec.tools ?? []).map((t) => [t.definition.name, t]));
  const maxSteps = spec.maxSteps ?? DEFAULT_MAX_STEPS;

  const fail = async (message: string, extra: Partial<IAgentRun> = {}): Promise<never> => {
    run.status = 'failed';
    run.error = message;
    run.usage = usage;
    run.costUsd = estimateCostUsd(spec.model, usage);
    run.receipt.cacheReadTokens = usage.cacheRead;
    run.finishedAt = new Date();
    Object.assign(run, extra);
    await run.save();
    throw new RunFailedError(run._id.toString(), message);
  };

  try {
    let steps = 0;
    let final: Anthropic.Message | null = null;

    while (true) {
      const params: Anthropic.MessageStreamParams = {
        model: spec.model,
        max_tokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: spec.context.system.length ? spec.context.system : undefined,
        messages,
        tools: toolDefs,
        output_config: {
          format: zodOutputFormat(spec.outputSchema),
          ...(spec.effort ? { effort: spec.effort } : {}),
        },
        ...(usesAdaptiveThinking(spec.model) ? { thinking: { type: 'adaptive' as const } } : {}),
      };

      const message = await client.messages.stream(params).finalMessage();
      addUsage(usage, message.usage);

      if (message.stop_reason === 'refusal') {
        run.status = 'refused';
        run.refusalCategory = message.stop_details?.type === 'refusal' ? message.stop_details.category ?? undefined : undefined;
        run.error = 'model declined the request';
        run.usage = usage;
        run.costUsd = estimateCostUsd(spec.model, usage);
        run.finishedAt = new Date();
        await run.save();
        throw new RunFailedError(run._id.toString(), 'model declined the request');
      }

      if (message.stop_reason === 'max_tokens') {
        await fail('output truncated at max_tokens');
      }

      if (message.stop_reason === 'tool_use') {
        steps += 1;
        if (steps > maxSteps) await fail(`tool loop exceeded ${maxSteps} steps`);

        const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        messages.push({ role: 'assistant', content: message.content });

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const tool = toolsByName.get(use.name);
          const started = Date.now();
          let content: string;
          let isError = false;
          if (!tool) {
            content = `unknown tool: ${use.name}`;
            isError = true;
          } else {
            try {
              content = await tool.execute(use.input);
            } catch (err) {
              content = `tool error: ${err instanceof Error ? err.message : String(err)}`;
              isError = true;
            }
          }
          run.steps.push({ tool: use.name, input: use.input, outputSummary: summarize(content), ms: Date.now() - started, isError });
          results.push({ type: 'tool_result', tool_use_id: use.id, content, is_error: isError || undefined });
        }
        // All results for one assistant turn go back in a single user message.
        messages.push({ role: 'user', content: results });
        await run.save();
        continue;
      }

      final = message;
      break;
    }

    // Structured output: prefer the SDK's parsed value, fall back to the text.
    const parsedFromSdk = (final as Anthropic.Message & { parsed_output?: unknown }).parsed_output;
    const text = final!.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    let candidate: unknown = parsedFromSdk;
    if (candidate === undefined || candidate === null) {
      try { candidate = JSON.parse(text); } catch { await fail(`output was not valid JSON: ${summarize(text, 200)}`); }
    }
    const parsed = spec.outputSchema.safeParse(candidate);
    if (!parsed.success) {
      await fail(`output failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const output = parsed.data as TOut;

    // Receipt check: anything the output claims to have used must have been in context.
    if (spec.citedIds) {
      const inContext = new Set(spec.context.receipt.sections.flatMap((s) => s.itemIds));
      const bad = spec.citedIds(output).filter((id) => !inContext.has(id));
      if (bad.length) await fail(`output cited ids not in context: ${bad.join(', ')}`);
    }

    run.status = 'succeeded';
    run.output = output;
    run.usage = usage;
    run.costUsd = estimateCostUsd(spec.model, usage);
    run.receipt.cacheReadTokens = usage.cacheRead;
    run.finishedAt = new Date();
    await run.save();

    return { runId: run._id.toString(), output, usage, costUsd: run.costUsd, receipt: run.receipt };
  } catch (err) {
    if (err instanceof RunFailedError) throw err;
    // API or transport errors: record and rethrow with the run id attached.
    const message = err instanceof Anthropic.APIError ? `API error ${err.status}: ${err.message}` : (err instanceof Error ? err.message : String(err));
    await fail(message);
    throw err; // unreachable; fail() throws
  }
}
