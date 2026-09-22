import mongoose from 'mongoose';
import { Signal } from '../../models/Signal';
import { FingerprintRule } from '../../models/FingerprintRule';
import { AgentTool } from '../runAgent';
import { compileRule, classifyWith } from '../../services/classifierService';

// The investigator's tools (doc/02-ai-architecture.md §3.4). All read-only,
// all over open signals. There is deliberately no tool that writes: the
// loop's output is a proposal a human reviews.

function summarizeUa(ua: string): string {
  return ua.length > 160 ? `${ua.slice(0, 160)}…` : ua;
}

const bucket = (ms: number): string => {
  if (ms < 1000) return '<1s';
  if (ms < 3000) return '1-3s';
  if (ms < 10_000) return '3-10s';
  if (ms < 60_000) return '10-60s';
  if (ms < 600_000) return '1-10m';
  if (ms < 3_600_000) return '10-60m';
  if (ms < 86_400_000) return '1-24h';
  return '>1d';
};

// Evidence stats for a UA regex across the corpus, so a hypothesis can be
// checked against everything, not just the event that raised it.
export async function uaStats(pattern: string, ownerId?: mongoose.Types.ObjectId | string) {
  let regex: RegExp;
  try { regex = new RegExp(pattern, 'i'); } catch { return { error: `invalid regex: ${pattern}` }; }
  const q: Record<string, unknown> = { type: 'open', 'payload.userAgent': { $regex: pattern, $options: 'i' } };
  if (ownerId) q.ownerId = ownerId;
  const rows = await Signal.find(q).select('payload integrity at').limit(5000).lean();
  const buckets: Record<string, number> = {};
  let labelledHuman = 0, labelledAutomated = 0, verdictAutomated = 0;
  for (const r of rows) {
    const ms = (r.payload as { msSinceCreated?: number }).msSinceCreated ?? -1;
    buckets[bucket(ms)] = (buckets[bucket(ms)] ?? 0) + 1;
    if (r.integrity.label === 'human') labelledHuman += 1;
    if (r.integrity.label === 'automated') labelledAutomated += 1;
    if (r.integrity.verdict === 'automated') verdictAutomated += 1;
  }
  void regex;
  return { pattern, matches: rows.length, currentlyAutomated: verdictAutomated, labelled: { human: labelledHuman, automated: labelledAutomated }, timing: buckets };
}

export function investigatorTools(ownerId: mongoose.Types.ObjectId | string): AgentTool[] {
  return [
    {
      definition: {
        name: 'get_event',
        description: 'The full open event by signal id: timestamp, user agent, ip, elapsed ms since delivery, current verdict, any human label.',
        inputSchema: { type: 'object', properties: { signalId: { type: 'string' } }, required: ['signalId'] },
      },
      execute: async (input) => {
        const { signalId } = input as { signalId?: string };
        if (!signalId || !mongoose.isValidObjectId(signalId)) return 'invalid signalId';
        const s = await Signal.findOne({ _id: signalId, ownerId, type: 'open' }).lean();
        if (!s) return 'not found';
        const p = s.payload as { userAgent?: string; ip?: string; msSinceCreated?: number; matchedBy?: string };
        return JSON.stringify({ signalId, at: s.at, userAgent: p.userAgent, ip: p.ip, msSinceCreated: p.msSinceCreated, verdict: s.integrity.verdict, label: s.integrity.label ?? null, matchedBy: p.matchedBy ?? null });
      },
    },
    {
      definition: {
        name: 'ua_stats',
        description: 'How many open events across the corpus match a User-Agent regex, their timing distribution, how many are currently classified automated, and how many carry a human label.',
        inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: 'a regular expression' } }, required: ['pattern'] },
      },
      execute: async (input) => JSON.stringify(await uaStats((input as { pattern: string }).pattern, ownerId)),
    },
    {
      definition: {
        name: 'timing_histogram',
        description: 'Distribution of elapsed-time-to-open for this owner\'s open events, split by current verdict.',
        inputSchema: { type: 'object', properties: { sinceDays: { type: 'number' } } },
      },
      execute: async (input) => {
        const sinceDays = Number((input as { sinceDays?: number }).sinceDays ?? 90);
        const rows = await Signal.find({ ownerId, type: 'open', at: { $gte: new Date(Date.now() - sinceDays * 86_400_000) } }).select('payload integrity').limit(10_000).lean();
        const out: Record<string, Record<string, number>> = { human: {}, automated: {} };
        for (const r of rows) {
          const ms = (r.payload as { msSinceCreated?: number }).msSinceCreated ?? -1;
          const v = r.integrity.verdict === 'automated' ? 'automated' : 'human';
          out[v][bucket(ms)] = (out[v][bucket(ms)] ?? 0) + 1;
        }
        return JSON.stringify({ events: rows.length, byVerdict: out });
      },
    },
    {
      definition: {
        name: 'list_rules',
        description: 'Active, proposed and rejected fingerprint rules with their measured precision, and the review notes on rejected ones.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        const rules = await FingerprintRule.find({ status: { $in: ['active', 'proposed', 'rejected'] } }).sort({ createdAt: -1 }).limit(50).lean();
        return JSON.stringify(rules.map((r) => ({ id: r._id, patternType: r.patternType, pattern: r.pattern, verdict: r.verdict, status: r.status, measured: r.measured ?? null, reviewNote: r.reviewNote ?? null })));
      },
    },
    {
      definition: {
        name: 'labelled_events',
        description: 'Open events a human has labelled, for checking a hypothesis against ground truth. Returns up to 100.',
        inputSchema: { type: 'object', properties: { label: { type: 'string', enum: ['human', 'automated'] } } },
      },
      execute: async (input) => {
        const label = (input as { label?: string }).label;
        const q: Record<string, unknown> = { ownerId, type: 'open', 'integrity.label': label ?? { $exists: true } };
        // Kept small on purpose: tool results live in the loop's context.
        const rows = await Signal.find(q).sort({ at: -1 }).limit(30).lean();
        return JSON.stringify(rows.map((s) => ({ id: s._id, label: s.integrity.label, verdict: s.integrity.verdict, ua: summarizeUa((s.payload as { userAgent?: string }).userAgent ?? '').slice(0, 90), ms: (s.payload as { msSinceCreated?: number }).msSinceCreated })));
      },
    },
  ];
}

// Server-side recomputation of a proposal's effect: how many currently
// human-classified opens the rule would flip, and how it agrees with labels.
// The model reports its own numbers; the reviewer sees both.
export async function predictedEffect(rule: { patternType: 'ua_regex' | 'ip_cidr' | 'timing_floor_ms'; pattern: string; verdict: 'automated' | 'human' }, ownerId?: mongoose.Types.ObjectId | string) {
  const compiled = compileRule({ ...rule, signalType: 'open' } as Parameters<typeof compileRule>[0]);
  if (!compiled) return { wouldReclassify: 0, matchesLabelled: { agree: 0, disagree: 0 }, invalid: true };
  const q: Record<string, unknown> = { type: 'open' };
  if (ownerId) q.ownerId = ownerId;
  const rows = await Signal.find(q).select('payload integrity').limit(20_000).lean();
  let wouldReclassify = 0, agree = 0, disagree = 0;
  for (const r of rows) {
    const p = r.payload as { userAgent?: string; ip?: string; msSinceCreated?: number };
    const hit = classifyWith([compiled], { userAgent: p.userAgent ?? '', ip: p.ip ?? '', msSinceCreated: p.msSinceCreated ?? 0 });
    const matched = hit.ruleId?.toString() === compiled.id.toString();
    if (!matched) continue;
    if (r.integrity.verdict !== rule.verdict) wouldReclassify += 1;
    if (r.integrity.label) { if (r.integrity.label === rule.verdict) agree += 1; else disagree += 1; }
  }
  return { wouldReclassify, matchesLabelled: { agree, disagree }, invalid: false };
}
