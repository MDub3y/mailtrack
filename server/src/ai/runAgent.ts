import mongoose from 'mongoose';
import { z } from 'zod';
import { AgentRun, IAgentRun, RunKind } from '../models/AgentRun';
import { isAiEnabled, ModelTask } from './config';
import { checkBudget } from './budget';
import { BuiltContext } from './context/builder';
import { resolveProvider } from './providers';
import type { CompletionResponse, NeutralMessage, NeutralTool, ToolResult, Effort } from './providers/types';
import { estimateCost } from './providers/pricing';

// The one wrapper every model call goes through (doc/02-ai-architecture.md,
// §3.1; ADR-6). Provider-agnostic: it speaks the neutral shape in
// providers/types.ts and never sees an SDK. Responsibilities, in order:
//   1. feature flag and daily budget check
//   2. resolve the owner's provider and key (BYOK)
//   3. create the AgentRun record with the context receipt
//   4. call; loop over read-only tools up to maxSteps
//   5. validate the output against the schema, then against the receipt
//   6. finalise usage, cost, status
// A run that fails validation is a failed run; nothing partial is stored.

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
  definition: NeutralTool;
  // Tools are read-only by design. A tool that writes must not exist here.
  execute: (input: unknown) => Promise<string>;
}

export interface RunSpec<TOut> {
  kind: RunKind;
  ownerId: string | mongoose.Types.ObjectId;
  // A task name resolved through the owner's settings, or an explicit
  // "provider:model" ref.
  model: ModelTask | string;
  effort?: Effort;
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
  usage: IAgentRun['usage'];
  costUsd: number;
  receipt: IAgentRun['receipt'];
  provider: string;
  model: string;
  degraded: string[];
}

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOKENS = 16_000;

// Context editing for tool loops (doc/05 Elevation 5): the last few tool
// results stay in full; older ones are cut to a stub so the conversation
// stops growing with every step. The run record keeps every full result.
const KEEP_FULL_TOOL_RESULTS = 3;
const STUB_TOOL_RESULT_CHARS = 240;

export function editContext(messages: NeutralMessage[], keepFull = KEEP_FULL_TOOL_RESULTS, stubChars = STUB_TOOL_RESULT_CHARS): NeutralMessage[] {
  const resultTurns = messages.map((m, i) => (m.role === 'tool_results' ? i : -1)).filter((i) => i >= 0);
  const cutoff = resultTurns.length > keepFull ? resultTurns[resultTurns.length - keepFull] : -1;
  return messages.map((m, i) => {
    if (m.role !== 'tool_results' || i >= cutoff) return m;
    return {
      role: 'tool_results',
      results: m.results.map((r) => (r.content.length > stubChars
        ? { ...r, content: `${r.content.slice(0, stubChars)}… [earlier result trimmed; ${r.content.length} chars in full on the run record]` }
        : r)),
    };
  });
}

function summarize(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Compat models sometimes wrap JSON in fences or prose despite instructions.
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* fall through */ } }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) { try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* fall through */ } }
  throw new Error('no JSON object found');
}

export async function runAgent<TOut>(spec: RunSpec<TOut>): Promise<RunResult<TOut>> {
  if (!isAiEnabled()) throw new AiDisabledError();

  const budget = await checkBudget(spec.ownerId, spec.kind);
  if (!budget.allowed) {
    await AgentRun.create({
      ownerId: spec.ownerId,
      kind: spec.kind,
      modelId: String(spec.model),
      effort: spec.effort,
      status: 'refused',
      inputRefs: spec.inputRefs ?? {},
      receipt: spec.context.receipt,
      error: `budget: ${budget.spentToday} of ${budget.ceiling} tokens used today`,
      finishedAt: new Date(),
    });
    throw new BudgetExceededError(spec.kind, budget.spentToday, budget.ceiling);
  }

  // BYOK: the owner's key and model choice. Throws a readable error when no
  // key is configured; that is not a run, nothing is recorded.
  const resolved = await resolveProvider(spec.ownerId, spec.model);
  const toolDefs = spec.tools?.map((t) => t.definition);
  const maxTokens = spec.maxTokens ?? DEFAULT_MAX_TOKENS;

  const baseRequest = {
    model: resolved.model,
    system: spec.context.system,
    tools: toolDefs,
    toolChoice: undefined as 'auto' | 'none' | undefined,
    outputSchema: spec.outputSchema,
    maxTokens,
    effort: spec.effort,
  };

  const exact = await resolved.client.countTokens({ ...baseRequest, messages: spec.context.messages });
  if (exact !== null) {
    spec.context.receipt.totalInputTokens = exact;
    spec.context.receipt.exact = true;
  }

  const run = await AgentRun.create({
    ownerId: spec.ownerId,
    kind: spec.kind,
    provider: resolved.provider,
    modelId: resolved.ref,
    keySource: resolved.keySource,
    effort: spec.effort,
    status: 'running',
    inputRefs: spec.inputRefs ?? {},
    receipt: spec.context.receipt,
  });

  const usage: IAgentRun['usage'] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let reportedCost = 0;
  let anyReportedCost = false;
  const degraded = new Set<string>();
  const messages: NeutralMessage[] = [...spec.context.messages];
  const toolsByName = new Map((spec.tools ?? []).map((t) => [t.definition.name, t]));
  const maxSteps = spec.maxSteps ?? DEFAULT_MAX_STEPS;

  const finalizeUsage = () => {
    run.usage = usage;
    const cost = estimateCost(resolved.ref, usage, anyReportedCost ? reportedCost : undefined);
    run.costUsd = cost.costUsd;
    run.costSource = cost.costSource;
    run.receipt.cacheReadTokens = usage.cacheRead;
    run.degraded = [...degraded];
    run.finishedAt = new Date();
  };

  const fail = async (message: string): Promise<never> => {
    run.status = 'failed';
    run.error = message;
    finalizeUsage();
    await run.save();
    throw new RunFailedError(run._id.toString(), message);
  };

  const absorb = (res: CompletionResponse) => {
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    usage.cacheRead += res.usage.cacheRead;
    usage.cacheWrite += res.usage.cacheWrite;
    if (typeof res.costUsd === 'number') { reportedCost += res.costUsd; anyReportedCost = true; }
    for (const d of res.degraded) degraded.add(d);
  };

  try {
    let steps = 0;
    let wrappedUp = false;
    let final: CompletionResponse | null = null;

    while (true) {
      const res = await resolved.client.complete({ ...baseRequest, messages: editContext(messages) });
      absorb(res);

      if (res.stopReason === 'refusal') {
        run.status = 'refused';
        run.refusalCategory = res.refusalCategory;
        run.error = 'model declined the request';
        finalizeUsage();
        await run.save();
        throw new RunFailedError(run._id.toString(), 'model declined the request');
      }

      if (res.stopReason === 'max_tokens') {
        await fail('output truncated at max_tokens');
      }

      if (res.stopReason === 'tool_use' && res.toolCalls.length) {
        steps += 1;
        if (steps > maxSteps) {
          // Budget spent. One wrap-up turn with the tools withdrawn and a
          // plain instruction to answer from what it has; only if it still
          // insists on tools is the run failed.
          if (wrappedUp) await fail(`tool loop exceeded ${maxSteps} steps`);
          wrappedUp = true;
          messages.push({ role: 'assistant', text: res.text || undefined, toolCalls: res.toolCalls, raw: res.raw });
          messages.push({ role: 'tool_results', results: res.toolCalls.map((c) => ({ id: c.id, content: 'Tool budget exhausted. No more tool calls are available; produce your final answer now from what you already have.', isError: true })) });
          run.steps.push({ tool: '(budget)', input: { requested: res.toolCalls.map((c) => c.name) }, outputSummary: `step budget of ${maxSteps} reached; asked for a final answer with tool calls disabled`, ms: 0, isError: true });
          // Definitions stay (the history references them); new calls are forbidden.
          baseRequest.toolChoice = 'none';
          await run.save();
          continue;
        }

        messages.push({ role: 'assistant', text: res.text || undefined, toolCalls: res.toolCalls, raw: res.raw });

        const results: ToolResult[] = [];
        for (const call of res.toolCalls) {
          const tool = toolsByName.get(call.name);
          const started = Date.now();
          let content: string;
          let isError = false;
          if (!tool) {
            content = `unknown tool: ${call.name}`;
            isError = true;
          } else {
            try {
              content = await tool.execute(call.input);
            } catch (err) {
              content = `tool error: ${err instanceof Error ? err.message : String(err)}`;
              isError = true;
            }
          }
          run.steps.push({ tool: call.name, input: call.input, outputSummary: summarize(content), ms: Date.now() - started, isError });
          results.push({ id: call.id, content, isError });
        }
        // All results for one assistant turn go back together.
        messages.push({ role: 'tool_results', results });
        await run.save();
        continue;
      }

      final = res;
      break;
    }

    // Structured output: prefer the provider's parsed value, else the text.
    let candidate: unknown = final!.parsed;
    if (candidate === undefined || candidate === null) {
      try { candidate = extractJson(final!.text); } catch { await fail(`output was not valid JSON: ${summarize(final!.text, 200)}`); }
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
    finalizeUsage();
    await run.save();

    return {
      runId: run._id.toString(),
      output,
      usage,
      costUsd: run.costUsd,
      receipt: run.receipt,
      provider: resolved.provider,
      model: resolved.ref,
      degraded: [...degraded],
    };
  } catch (err) {
    if (err instanceof RunFailedError) throw err;
    // Provider or transport errors: record and rethrow with the run id attached.
    const status = (err as { status?: number }).status;
    const message = `${status ? `provider error ${status}: ` : ''}${err instanceof Error ? err.message : String(err)}`;
    await fail(message);
    throw err; // unreachable; fail() throws
  }
}
