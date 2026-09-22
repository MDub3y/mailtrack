import mongoose from 'mongoose';
import { z } from 'zod';
import { Signal } from '../../models/Signal';
import { FingerprintRule } from '../../models/FingerprintRule';
import { IProposal } from '../../models/Proposal';
import { ContextBuilder } from '../context/builder';
import { runAgent } from '../runAgent';
import { submitProposal, registerApplier } from '../corrections';
import { investigatorTools, predictedEffect } from './tools';
import { invalidateRuleCache } from '../../services/classifierService';

// The bounded investigator (doc/02-ai-architecture.md §3.4): the README's
// open-tracking investigation made repeatable. It examines anomalous open
// events with read-only tools, proposes fingerprint rules with evidence,
// and stops. A human accepts or rejects; accepted rules reclassify history.

export const ProposalOutput = z.object({
  proposals: z.array(z.object({
    patternType: z.enum(['ua_regex', 'ip_cidr', 'timing_floor_ms']),
    pattern: z.string().min(1).max(300),
    verdict: z.enum(['automated', 'human']),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(10).max(800),
    evidence: z.array(z.string()).min(1).max(50),   // signal ids
    predictedEffect: z.object({
      wouldReclassify: z.number().int().min(0),
      matchesLabelled: z.object({ agree: z.number().int().min(0), disagree: z.number().int().min(0) }),
    }),
  })).max(5),
  notes: z.string().max(600).optional(),
});

const SYSTEM = [
  'You investigate suspicious email-open events for a tracking product and propose classifier rules.',
  'Background: mail providers prefetch images for security scanning before any human opens anything, through the same proxies a real open uses. The one reliable signal is a fingerprint no legitimate client would send. Timing alone is not a disambiguator: a person watching for an email can open it within seconds.',
  'Use the tools to check any hypothesis against the whole corpus and against human labels before proposing it. A rule that would reclassify events a human labelled the other way is wrong.',
  'Prefer narrow, specific patterns (a distinctive User-Agent fragment, a proxy fingerprint) over broad ones. Never propose a timing floor above 5000 ms.',
  'Propose nothing if the evidence does not support a rule; an empty proposals list with a note is a good answer.',
  'Cite the signal ids you examined in evidence, and fill predictedEffect from ua_stats results; the server recomputes it and shows both numbers to the reviewer.',
].join('\n');

const MAX_CANDIDATES = 12;
const MAX_STEPS = 10;

// Anomaly selection is a query, not a model call (doc/02 §3.4 "Trigger").
export async function selectCandidates(ownerId: mongoose.Types.ObjectId | string, opts: { sinceDays?: number } = {}): Promise<Array<{ signalId: string; why: string }>> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 86_400_000);
  const opens = await Signal.find({ ownerId, type: 'open', at: { $gte: since } }).select('payload integrity emailId at').sort({ at: -1 }).limit(5000).lean();

  const uaCount = new Map<string, number>();
  for (const s of opens) { const ua = (s.payload as { userAgent?: string }).userAgent ?? ''; uaCount.set(ua, (uaCount.get(ua) ?? 0) + 1); }

  const out: Array<{ signalId: string; why: string }> = [];
  const seen = new Set<string>();
  const push = (s: typeof opens[number], why: string) => { const id = s._id.toString(); if (seen.has(id)) return; seen.add(id); out.push({ signalId: id, why }); };

  for (const s of opens) {
    const p = s.payload as { userAgent?: string; msSinceCreated?: number };
    // A human label that disagrees with the classifier is the strongest lead.
    if (s.integrity.label && s.integrity.label !== ((s.payload as { classifierVerdict?: string }).classifierVerdict ?? s.integrity.verdict)) push(s, `labelled ${s.integrity.label}, classifier said otherwise`);
  }
  for (const s of opens) {
    const p = s.payload as { userAgent?: string; msSinceCreated?: number };
    if (s.integrity.verdict === 'human' && (p.msSinceCreated ?? 1e9) < 15_000) push(s, `human verdict but only ${p.msSinceCreated} ms after delivery`);
  }
  for (const s of opens) {
    const ua = (s.payload as { userAgent?: string }).userAgent ?? '';
    if (s.integrity.verdict === 'human' && /bot|crawl|spider|scan|proxy|fetch|preview|python|curl|java|okhttp|wget/i.test(ua)) push(s, `human verdict but the User-Agent looks like software (seen ${uaCount.get(ua) ?? 1}×)`);
  }
  return out.slice(0, MAX_CANDIDATES);
}

export interface InvestigationResult {
  runId: string;
  candidates: number;
  proposals: Array<{ ruleId: string; proposalId: string; pattern: string; verdict: string; modelDisagreed: boolean }>;
  notes?: string;
}

export async function investigate(ownerId: mongoose.Types.ObjectId | string, opts: { candidates?: Array<{ signalId: string; why: string }> } = {}): Promise<InvestigationResult | null> {
  const candidates = opts.candidates ?? await selectCandidates(ownerId);
  if (candidates.length === 0) return null;

  const ctx = new ContextBuilder()
    .add({ name: 'system', budgetTokens: 700, stable: true, text: SYSTEM })
    .add({
      name: 'task', budgetTokens: 2500, stable: false,
      text: [
        `Candidate events (signal ids) and why they were flagged:`,
        ...candidates.map((c) => `- ${c.signalId}: ${c.why}`),
        '',
        `You have a budget of ${MAX_STEPS} tool calls in total. Start with ua_stats on the fragments you suspect and labelled_events; look at individual events only where the aggregate is ambiguous. Then return proposals (possibly none).`,
      ].join('\n'),
    })
    .build();

  const result = await runAgent({
    kind: 'investigate',
    ownerId,
    model: 'primary',
    effort: 'high',
    context: ctx,
    outputSchema: ProposalOutput,
    tools: investigatorTools(ownerId),
    maxSteps: MAX_STEPS,
    maxTokens: 8000,
    inputRefs: { note: `investigate ${candidates.length} candidates` },
  });

  const proposals: InvestigationResult['proposals'] = [];
  for (const p of result.output.proposals) {
    const evidenceIds = p.evidence.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
    const server = await predictedEffect({ patternType: p.patternType, pattern: p.pattern, verdict: p.verdict }, ownerId);
    if (server.invalid) continue; // an unusable pattern is not a proposal
    const modelDisagreed = server.wouldReclassify !== p.predictedEffect.wouldReclassify
      || server.matchesLabelled.agree !== p.predictedEffect.matchesLabelled.agree
      || server.matchesLabelled.disagree !== p.predictedEffect.matchesLabelled.disagree;

    const rule = await FingerprintRule.create({
      patternType: p.patternType, pattern: p.pattern, verdict: p.verdict, signalType: 'open', status: 'proposed',
      confidence: p.confidence, reasoning: p.reasoning,
      evidence: evidenceIds.map((signalId) => ({ signalId })),
      predictedEffect: { ...server, recomputedByServer: true, modelDisagreed, modelReported: p.predictedEffect },
      proposedByRunId: new mongoose.Types.ObjectId(result.runId),
      origin: 'investigator',
    });
    const proposal = await submitProposal({
      ownerId,
      kind: 'fingerprint_rule',
      payload: { ruleId: rule._id.toString(), patternType: p.patternType, pattern: p.pattern, verdict: p.verdict, reasoning: p.reasoning, predictedEffect: rule.predictedEffect },
      evidence: evidenceIds.map((id) => ({ signalId: id.toString() })),
      confidence: p.confidence,
      runId: new mongoose.Types.ObjectId(result.runId),
    });
    rule.proposalId = proposal._id;
    await rule.save();
    proposals.push({ ruleId: rule._id.toString(), proposalId: proposal._id.toString(), pattern: p.pattern, verdict: p.verdict, modelDisagreed });
  }

  return { runId: result.runId, candidates: candidates.length, proposals, notes: result.output.notes };
}

// Applier: the human's decision on a fingerprint_rule proposal activates or
// rejects the rule. Activation reclassifies history in a background job.
registerApplier('fingerprint_rule', async (proposal: IProposal, outcome) => {
  const { ruleId } = proposal.payload as { ruleId?: string };
  if (!ruleId) return;
  const rule = await FingerprintRule.findById(ruleId);
  if (!rule) return;
  rule.status = outcome === 'accepted' ? 'active' : 'rejected';
  rule.reviewedBy = proposal.decidedBy instanceof mongoose.Types.ObjectId ? proposal.decidedBy : undefined;
  rule.reviewNote = proposal.reason;
  await rule.save();
  invalidateRuleCache();
  if (outcome === 'accepted') {
    const { enqueueReclassify } = await import('../../queues/aiQueue');
    await enqueueReclassify(proposal.ownerId.toString()).catch(() => {});
  }
});
