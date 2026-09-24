import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AgentRun, IAgentRun, RunKind } from '../../models/AgentRun';
import { Label } from '../../models/Label';
import { Proposal } from '../../models/Proposal';
import { ReplayReport, IReplayRow, IReplayReport } from '../../models/ReplayReport';
import { runAgent, RunFailedError } from '../runAgent';
import type { BuiltContext } from '../context/builder';
import type { NeutralMessage, NeutralTool, SystemBlock, Effort } from '../providers/types';
import { DraftOutput, Draft } from '../draft/followUp';
import { ExtractionOutput, quoteAppearsIn } from '../memory/extract';
import { BriefOutput } from '../memory/brief';
import { VoiceOutput } from '../voice/profile';
import { ClassifyOutput } from '../classify/llm';
import { HeadlineOutput } from '../digest/headline';
import { judgeDraft } from '../evals/judge';

// Replay (doc/05, Elevation 4): every run keeps the exact prompt it was
// shown, so it can be re-executed under a different prompt, model, or
// effort and the two outputs compared. No live data is rebuilt: the replay
// sees precisely what the original saw, which is what makes the comparison
// honest. Tool-using runs are replayed without tools (the stored prompt
// holds the initial turn only) and say so.

export const REPLAYABLE_KINDS: RunKind[] = ['extract_memory', 'draft_follow_up', 'contact_brief', 'voice_profile', 'classify', 'digest'];

const SCHEMAS: Partial<Record<RunKind, z.ZodType>> = {
  extract_memory: ExtractionOutput,
  draft_follow_up: DraftOutput,
  contact_brief: BriefOutput,
  voice_profile: VoiceOutput,
  classify: ClassifyOutput,
  digest: HeadlineOutput,
};

export interface ReplayOptions {
  variant?: string;          // replacement text for the system section (the first system block)
  variantSource?: string;    // where it came from (a file name), for the report
  model?: string;            // 'provider:model' or a task name; default the original run's model
  effort?: Effort;
  judge?: boolean;           // draft_follow_up only: run the rubric judge on both outputs
}

// Prompt variants live in the repo as versioned files: server/prompts/<name>.md
export function loadVariant(nameOrPath: string): { text: string; source: string } {
  const candidates = [nameOrPath, path.resolve(process.cwd(), 'prompts', nameOrPath), path.resolve(process.cwd(), 'prompts', `${nameOrPath}.md`)];
  for (const c of candidates) if (fs.existsSync(c) && fs.statSync(c).isFile()) return { text: fs.readFileSync(c, 'utf8').trim(), source: path.relative(process.cwd(), c) };
  throw new Error(`variant not found: ${nameOrPath} (looked in ./prompts)`);
}

function contextFromPrompt(prompt: NonNullable<IAgentRun['prompt']>, variant?: string): BuiltContext {
  const system = (prompt.system as SystemBlock[]).map((b, i) => (i === 0 && variant ? { ...b, text: variant } : b));
  const messages = prompt.messages as NeutralMessage[];
  return {
    system, messages, sections: [],
    receipt: { sections: [{ name: 'replay', tokens: Math.ceil(JSON.stringify({ system, messages }).length / 4), itemIds: [], droppedItemIds: [], cacheBoundary: false }], totalInputTokens: 0, exact: false, cacheReadTokens: 0 },
  };
}

// ---------------------------------------------------------------- scorers

type Checks = IReplayRow['checks'];

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));
export function jaccard(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function promptText(prompt: NonNullable<IAgentRun['prompt']>): string {
  return (prompt.messages as NeutralMessage[]).map((m) => (m.role === 'user' ? m.text : '')).join('\n');
}

// Extraction: items the human kept (accepted/edited labels on the original
// run's proposals) should still be found; items rejected should not
// return; every quote must be verbatim in the source.
async function scoreExtraction(run: IAgentRun, out: z.infer<typeof ExtractionOutput>): Promise<{ checks: Checks; agreement: number }> {
  const original = (run.output ?? { items: [] }) as z.infer<typeof ExtractionOutput>;
  const source = promptText(run.prompt!);
  const quotesOk = out.items.filter((i) => quoteAppearsIn(i.quote, source)).length;
  const checks: Checks = { quotesVerbatim: { value: out.items.length ? quotesOk / out.items.length : 1, note: `${quotesOk}/${out.items.length} quotes found in the source` } };

  const proposals = await Proposal.find({ runId: run._id, kind: 'memory_item' }).select('_id payload').lean();
  const labels = await Label.find({ runId: run._id, runKind: 'extract_memory', proposalId: { $in: proposals.map((p) => p._id) } }).lean();
  const kept: string[] = [], rejected: string[] = [];
  for (const l of labels) {
    const p = proposals.find((x) => x._id.equals(l.proposalId!));
    const content = (l.after as { content?: string } | undefined)?.content ?? (p?.payload as { content?: string } | undefined)?.content;
    if (!content) continue;
    if (l.verdict === 'accepted' || l.verdict === 'edited') kept.push(content);
    else if (l.verdict === 'rejected') rejected.push(content);
  }
  const found = (c: string) => out.items.some((i) => jaccard(i.content, c) >= 0.5);
  if (kept.length) checks.keptItemsFound = { value: kept.filter(found).length / kept.length, note: `${kept.filter(found).length}/${kept.length} human-kept items found again` };
  if (rejected.length) checks.rejectedItemsAvoided = { value: rejected.filter((c) => !found(c)).length / rejected.length, note: `${rejected.filter((c) => !found(c)).length}/${rejected.length} human-rejected items not repeated` };

  const orig = original.items ?? [];
  const matched = orig.filter((o) => out.items.some((i) => i.kind === o.kind && jaccard(i.content, o.content) >= 0.5)).length;
  const agreement = orig.length || out.items.length ? (2 * matched) / (orig.length + out.items.length) : 1;
  checks.itemCountDelta = { value: out.items.length - orig.length, note: `${orig.length} items originally, ${out.items.length} now` };
  return { checks, agreement };
}

async function scoreDraft(run: IAgentRun, out: Draft, opts: ReplayOptions): Promise<{ checks: Checks; agreement: number; judgeCost: number }> {
  const original = run.output as Draft | undefined;
  const source = promptText(run.prompt!);
  const ids = new Set([...source.matchAll(/\[([0-9a-f]{24})\]/g)].map((m) => m[1]));
  const cited = [...out.usedMemoryIds, ...out.usedEmailIds];
  const validCites = cited.filter((id) => ids.has(id)).length;
  const checks: Checks = {
    citationsInContext: { value: cited.length ? validCites / cited.length : 1, note: `${validCites}/${cited.length} cited ids were in the prompt` },
    lengthDelta: { value: original ? out.body.length - original.body.length : 0, note: `${original?.body.length ?? 0} chars originally, ${out.body.length} now` },
  };
  let judgeCost = 0;
  if (opts.judge && original) {
    const reason = /Reason for (?:the )?follow-up:\s*(.+)/i.exec(source)?.[1] ?? 'follow up';
    const voiceText = (run.prompt!.system as SystemBlock[])[1]?.text ?? null;
    const [a, b] = await Promise.all([
      judgeDraft(run.ownerId, { draft: original, reason, voiceText, note: `replay judge (original ${run._id})` }),
      judgeDraft(run.ownerId, { draft: out, reason, voiceText, note: `replay judge (variant of ${run._id})` }),
    ]);
    judgeCost = a.costUsd + b.costUsd;
    for (const k of ['traceable', 'voice', 'addresses', 'noLeak'] as const) {
      checks[`judge.${k}`] = { value: b.verdict[k], note: `original ${a.verdict[k] ? 'pass' : 'fail'}, replay ${b.verdict[k] ? 'pass' : 'fail'}: ${b.verdict[`${k}Note`]}` };
    }
  }
  return { checks, agreement: original ? jaccard(out.body, original.body) : 0, judgeCost };
}

function scoreBriefLike(run: IAgentRun, text: string, citedIds: string[] | undefined): { checks: Checks; agreement: number } {
  const source = promptText(run.prompt!);
  const ids = new Set([...source.matchAll(/\[([0-9a-f]{24})\]/g)].map((m) => m[1]));
  const checks: Checks = {};
  if (citedIds) {
    const ok = citedIds.filter((id) => ids.has(id)).length;
    checks.citationsInContext = { value: citedIds.length ? ok / citedIds.length : 1, note: `${ok}/${citedIds.length} cited ids were in the prompt` };
  }
  const originalText = (run.output as { text?: string; prose?: string; headline?: string } | undefined);
  const before = originalText?.text ?? originalText?.prose ?? originalText?.headline ?? '';
  checks.lengthDelta = { value: text.length - before.length, note: `${before.length} chars originally, ${text.length} now` };
  return { checks, agreement: before ? jaccard(text, before) : 0 };
}

async function scoreClassify(run: IAgentRun, out: z.infer<typeof ClassifyOutput>): Promise<{ checks: Checks; agreement: number }> {
  const original = (run.output ?? { results: [] }) as z.infer<typeof ClassifyOutput>;
  const byId = new Map(original.results.map((r) => [r.id, r.categoryKey]));
  const same = out.results.filter((r) => byId.get(r.id) === r.categoryKey).length;
  const checks: Checks = { allIdsAnswered: { value: original.results.length ? out.results.filter((r) => byId.has(r.id)).length / original.results.length : 1 } };
  // Human corrections on these messages are the ground truth where they exist.
  const labels = await Label.find({ runId: run._id, runKind: 'classify', verdict: { $in: ['edited', 'accepted'] } }).lean();
  if (labels.length) {
    let agree = 0;
    for (const l of labels) {
      const truth = ((l.after ?? l.before) as { categoryKey?: string } | undefined)?.categoryKey;
      const msgKey = (l.before as { categoryKey?: string } | undefined)?.categoryKey;
      const row = out.results.find((r) => byId.get(r.id) === msgKey);
      if (truth && row && row.categoryKey === truth) agree += 1;
    }
    checks.matchesHumanLabels = { value: agree / labels.length, note: `${agree}/${labels.length} corrected messages classified as the human did` };
  }
  return { checks, agreement: original.results.length ? same / original.results.length : 1 };
}

// ---------------------------------------------------------------- one run

export async function replayRun(runId: string | mongoose.Types.ObjectId, opts: ReplayOptions = {}): Promise<IReplayRow> {
  const run = await AgentRun.findById(runId).select('+prompt');
  const base = (r: IAgentRun) => ({ model: r.modelId, costUsd: r.costUsd ?? 0, tokens: (r.usage?.input ?? 0) + (r.usage?.output ?? 0) });
  if (!run) throw new Error(`run ${runId} not found`);
  const row: IReplayRow = { runId: run._id, status: 'skipped', original: base(run), checks: {} };
  if (run.status !== 'succeeded') return { ...row, error: `original run ${run.status}` };
  if (!run.prompt || !run.promptStored) return { ...row, error: 'no stored prompt (older run, or over the size limit)' };
  const schema = SCHEMAS[run.kind];
  if (!schema) return { ...row, error: `kind ${run.kind} is not replayable` };

  const ctx = contextFromPrompt(run.prompt, opts.variant);
  const t0 = Date.now();
  let result;
  try {
    result = await runAgent({
      kind: 'replay', ownerId: run.ownerId, model: opts.model ?? run.modelId, effort: opts.effort ?? (run.effort as Effort | undefined), context: ctx, outputSchema: schema, maxTokens: 4000,
      inputRefs: { ...run.inputRefs, replayOf: run._id.toString(), variant: opts.variantSource ?? (opts.variant ? 'inline' : undefined), note: `replay of ${run.kind} ${run._id}` },
    });
  } catch (err) {
    return { ...row, status: 'failed', replayRunId: err instanceof RunFailedError ? new mongoose.Types.ObjectId(err.runId) : undefined, error: err instanceof Error ? err.message : String(err) };
  }
  row.status = 'ok';
  row.replayRunId = new mongoose.Types.ObjectId(result.runId);
  row.replay = { model: result.model, costUsd: result.costUsd, tokens: result.usage.input + result.usage.output, ms: Date.now() - t0 };
  if ((run.prompt.tools as NeutralTool[] | undefined)?.length) row.checks.toolsUnavailable = { value: true, note: 'the original used tools; the replay ran on the stored first turn only' };

  let scored: { checks: Checks; agreement: number; judgeCost?: number };
  switch (run.kind) {
    case 'extract_memory': scored = await scoreExtraction(run, result.output as z.infer<typeof ExtractionOutput>); break;
    case 'draft_follow_up': scored = await scoreDraft(run, result.output as Draft, opts); break;
    case 'contact_brief': { const o = result.output as z.infer<typeof BriefOutput>; scored = scoreBriefLike(run, o.text, o.citedMemoryIds); break; }
    case 'voice_profile': { const o = result.output as z.infer<typeof VoiceOutput>; scored = scoreBriefLike(run, o.prose, undefined); break; }
    case 'digest': { const o = result.output as z.infer<typeof HeadlineOutput>; scored = scoreBriefLike(run, o.headline, undefined); break; }
    case 'classify': scored = await scoreClassify(run, result.output as z.infer<typeof ClassifyOutput>); break;
    default: scored = { checks: {}, agreement: 0 };
  }
  row.checks = { ...row.checks, ...scored.checks };
  row.agreement = Number(scored.agreement.toFixed(3));
  if (scored.judgeCost) row.checks.judgeCostUsd = { value: scored.judgeCost };
  return row;
}

// ---------------------------------------------------------------- a sample

export interface SampleOptions extends ReplayOptions {
  kind: RunKind;
  since: Date;
  limit: number;
  trigger: IReplayReport['trigger'];
}

export async function replaySample(ownerId: string | mongoose.Types.ObjectId, opts: SampleOptions): Promise<IReplayReport> {
  const runs = await AgentRun.find({ ownerId, kind: opts.kind, status: 'succeeded', promptStored: true, startedAt: { $gte: opts.since } }).sort({ startedAt: -1 }).limit(opts.limit).select('_id').lean();
  const report = await ReplayReport.create({
    ownerId, kind: opts.kind, trigger: opts.trigger,
    params: { since: opts.since, limit: opts.limit, variant: opts.variant, variantSource: opts.variantSource, model: opts.model, effort: opts.effort, judge: opts.judge },
    rows: [], summary: { n: runs.length, ok: 0, failed: 0, checks: {}, costUsd: { original: 0, replay: 0, judge: 0 }, tokens: { original: 0, replay: 0 } },
  });
  const rows: IReplayRow[] = [];
  for (const r of runs) rows.push(await replayRun(r._id, opts));
  report.rows = rows;
  report.summary = summarize(rows);
  report.finishedAt = new Date();
  await report.save();
  return report;
}

export function summarize(rows: IReplayRow[]): IReplayReport['summary'] {
  const ok = rows.filter((r) => r.status === 'ok');
  const checks: IReplayReport['summary']['checks'] = {};
  for (const r of ok) {
    for (const [k, c] of Object.entries(r.checks)) {
      if (k === 'judgeCostUsd' || k === 'toolsUnavailable') continue;
      const entry = checks[k] ?? { pass: 0, of: 0, mean: 0 };
      entry.of += 1;
      if (typeof c.value === 'boolean') { if (c.value) entry.pass += 1; entry.mean = undefined; }
      else if (k.endsWith('Delta')) { entry.mean = ((entry.mean ?? 0) * (entry.of - 1) + c.value) / entry.of; entry.pass += 1; }
      else { entry.mean = ((entry.mean ?? 0) * (entry.of - 1) + c.value) / entry.of; if (c.value >= 0.999) entry.pass += 1; }
      checks[k] = entry;
    }
  }
  const agreements = ok.map((r) => r.agreement).filter((a): a is number => typeof a === 'number');
  return {
    n: rows.length, ok: ok.length, failed: rows.filter((r) => r.status === 'failed').length,
    meanAgreement: agreements.length ? Number((agreements.reduce((a, b) => a + b, 0) / agreements.length).toFixed(3)) : undefined,
    checks,
    costUsd: {
      original: Number(rows.reduce((n, r) => n + r.original.costUsd, 0).toFixed(6)),
      replay: Number(ok.reduce((n, r) => n + (r.replay?.costUsd ?? 0), 0).toFixed(6)),
      judge: Number(ok.reduce((n, r) => n + (typeof r.checks.judgeCostUsd?.value === 'number' ? r.checks.judgeCostUsd.value : 0), 0).toFixed(6)),
    },
    tokens: { original: rows.reduce((n, r) => n + r.original.tokens, 0), replay: ok.reduce((n, r) => n + (r.replay?.tokens ?? 0), 0) },
  };
}

// Weekly drift: a sample of each replayable kind under the current prompt
// and the same model, compared with what was produced at the time.
export const DRIFT_KINDS: RunKind[] = ['extract_memory', 'classify', 'draft_follow_up'];
export async function runDriftReplay(ownerId: string | mongoose.Types.ObjectId, opts: { perKind?: number; days?: number } = {}): Promise<IReplayReport[]> {
  const since = new Date(Date.now() - (opts.days ?? 7) * 86_400_000);
  const out: IReplayReport[] = [];
  for (const kind of DRIFT_KINDS) {
    const n = await AgentRun.countDocuments({ ownerId, kind, status: 'succeeded', promptStored: true, startedAt: { $gte: since } });
    if (!n) continue;
    out.push(await replaySample(ownerId, { kind, since, limit: opts.perKind ?? 5, trigger: 'drift' }));
  }
  return out;
}

export function renderReportText(r: IReplayReport): string {
  const lines: string[] = [];
  lines.push(`replay ${r.kind}: ${r.summary.ok}/${r.summary.n} ok${r.summary.failed ? `, ${r.summary.failed} failed` : ''}${r.params.variantSource ? `, variant ${r.params.variantSource}` : ''}${r.params.model ? `, model ${r.params.model}` : ''}${r.params.effort ? `, effort ${r.params.effort}` : ''}`);
  if (r.summary.meanAgreement !== undefined) lines.push(`agreement with the original: ${(100 * r.summary.meanAgreement).toFixed(0)}%`);
  for (const [k, c] of Object.entries(r.summary.checks)) lines.push(`  ${k.padEnd(24)} ${c.mean !== undefined && !k.endsWith('Delta') ? `${(100 * c.mean).toFixed(0)}%` : c.mean !== undefined ? `mean ${c.mean.toFixed(1)}` : `${c.pass}/${c.of}`}`);
  lines.push(`cost: original $${r.summary.costUsd.original.toFixed(5)}, replay $${r.summary.costUsd.replay.toFixed(5)}${r.summary.costUsd.judge ? `, judge $${r.summary.costUsd.judge.toFixed(5)}` : ''}; tokens ${r.summary.tokens.original} → ${r.summary.tokens.replay}`);
  for (const row of r.rows) {
    const bits = Object.entries(row.checks).filter(([k]) => k !== 'judgeCostUsd').map(([k, c]) => `${k}=${typeof c.value === 'boolean' ? (c.value ? 'Y' : 'N') : typeof c.value === 'number' && k.endsWith('Delta') ? c.value : typeof c.value === 'number' ? c.value.toFixed(2) : c.value}`);
    lines.push(`  ${row.runId} ${row.status}${row.agreement !== undefined ? ` agree ${row.agreement.toFixed(2)}` : ''}${bits.length ? ` ${bits.join(' ')}` : ''}${row.error ? ` (${row.error})` : ''}`);
  }
  return lines.join('\n');
}
