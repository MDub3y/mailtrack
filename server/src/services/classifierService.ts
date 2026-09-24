import mongoose from 'mongoose';
import { FingerprintRule, IFingerprintRule } from '../models/FingerprintRule';
import { Signal, ISignal } from '../models/Signal';
import { Email } from '../models/Email';
import { Label } from '../models/Label';

// The deterministic signal-integrity classifier (ADR-1). Consulted by the
// pixel route on every hit: active FingerprintRules first, then the
// hard-coded floor the code shipped with. No model here, ever; the
// investigator (ai/investigate) only ever produces rules for this to read.
//
// The hard-coded floor is the README investigation: a synthetic scanner UA
// that claims to be three browsers at once, plus a timing floor small enough
// that no human input could explain a hit under it.
export const SEED_RULES: Array<Pick<IFingerprintRule, 'patternType' | 'pattern' | 'verdict' | 'signalType' | 'reasoning'>> = [
  { patternType: 'ua_regex', pattern: 'Edge\\/12\\.246', verdict: 'automated', signalType: 'open', reasoning: 'Known mail-security scanner fingerprint: Chrome/42 + Safari + Edge/12.246 in one User-Agent. No real browser sends this.' },
  { patternType: 'timing_floor_ms', pattern: '3000', verdict: 'automated', signalType: 'open', reasoning: 'An image fetch under 3 s after delivery is faster than any human notice-open-render.' },
  { patternType: 'timing_floor_ms', pattern: '3000', verdict: 'automated', signalType: 'link_click', reasoning: 'A link fetched under 3 s after delivery is a delivery-time scanner (Safe Links, Proofpoint, Mimecast), not a person reading and clicking.' },
];

export interface ClassifyInput {
  userAgent: string;
  ip: string;
  msSinceCreated: number;
  signalType?: 'open' | 'link_click' | 'doc_view';
}

export interface ClassifyResult {
  automated: boolean;
  ruleId?: mongoose.Types.ObjectId;
  matchedBy?: string; // human-readable, for the event timeline
}

interface CompiledRule {
  id: mongoose.Types.ObjectId;
  patternType: IFingerprintRule['patternType'];
  verdict: IFingerprintRule['verdict'];
  signalType: IFingerprintRule['signalType'];
  regex?: RegExp;
  cidr?: { base: number; bits: number };
  floorMs?: number;
  label: string;
}

const RULE_REFRESH_MS = Number(process.env.RULE_REFRESH_MS || 60_000);
let cache: { at: number; rules: CompiledRule[] } | null = null;

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4];
}

export function compileRule(r: Pick<IFingerprintRule, 'patternType' | 'pattern' | 'verdict' | 'signalType'> & { _id?: mongoose.Types.ObjectId }): CompiledRule | null {
  const base = { id: r._id ?? new mongoose.Types.ObjectId(), patternType: r.patternType, verdict: r.verdict, signalType: r.signalType, label: `${r.patternType}:${r.pattern}` };
  try {
    if (r.patternType === 'ua_regex') return { ...base, regex: new RegExp(r.pattern, 'i') };
    if (r.patternType === 'timing_floor_ms') { const n = Number(r.pattern); return Number.isFinite(n) && n > 0 ? { ...base, floorMs: n } : null; }
    if (r.patternType === 'ip_cidr') {
      const [ip, bitsStr] = r.pattern.split('/');
      const ipInt = ipv4ToInt(ip); const bits = Number(bitsStr ?? 32);
      if (ipInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
      return { ...base, cidr: { base: ipInt, bits } };
    }
  } catch { return null; }
  return null;
}

function matches(rule: CompiledRule, input: ClassifyInput): boolean {
  if (rule.signalType !== (input.signalType ?? 'open')) return false;
  if (rule.regex) return rule.regex.test(input.userAgent || '');
  if (rule.floorMs !== undefined) return input.msSinceCreated >= 0 && input.msSinceCreated < rule.floorMs;
  if (rule.cidr) {
    const ipInt = ipv4ToInt(input.ip || '');
    if (ipInt === null) return false;
    const mask = rule.cidr.bits === 0 ? 0 : (~0 << (32 - rule.cidr.bits)) >>> 0;
    return ((ipInt & mask) >>> 0) === ((rule.cidr.base & mask) >>> 0);
  }
  return false;
}

export async function loadActiveRules(force = false): Promise<CompiledRule[]> {
  if (!force && cache && Date.now() - cache.at < RULE_REFRESH_MS) return cache.rules;
  const rows = await FingerprintRule.find({ status: 'active' }).lean();
  const rules = rows.map((r) => compileRule(r)).filter((r): r is CompiledRule => r !== null);
  cache = { at: Date.now(), rules };
  return rules;
}

export function invalidateRuleCache(): void { cache = null; }

// Pure: classify against a given rule set. Exported for the eval and for
// predicted-effect recomputation.
export function classifyWith(rules: CompiledRule[], input: ClassifyInput): ClassifyResult {
  // Explicit 'human' rules win (an allow-list for a proxy that is known to
  // be a real client), then 'automated' rules, then the seed floor.
  for (const r of rules) if (r.verdict === 'human' && matches(r, input)) return { automated: false, ruleId: r.id, matchedBy: r.label };
  for (const r of rules) if (r.verdict === 'automated' && matches(r, input)) return { automated: true, ruleId: r.id, matchedBy: r.label };
  for (const seed of SEED_RULES) {
    const c = compileRule(seed as IFingerprintRule);
    if (c && matches(c, input)) return { automated: true, matchedBy: `seed ${c.label}` };
  }
  return { automated: false };
}

export async function classify(input: ClassifyInput): Promise<ClassifyResult> {
  return classifyWith(await loadActiveRules(), input);
}

// ---------------------------------------------------------------------------
// Human labels: ground truth on one signal. The label overrides the verdict
// everywhere downstream (engagement, queue, brief) and is stored as a Label
// so the classifier eval grows from use.
// ---------------------------------------------------------------------------

export async function labelSignal(ownerId: string, signalId: string, label: 'human' | 'automated'): Promise<ISignal | null> {
  const signal = await Signal.findOne({ _id: signalId, ownerId });
  if (!signal || (signal.type !== 'open' && signal.type !== 'link_click')) return null;
  const previous = signal.integrity.verdict;
  signal.integrity.label = label;
  signal.integrity.verdict = label;
  signal.payload = { ...signal.payload, classifierVerdict: (signal.payload as { classifierVerdict?: string }).classifierVerdict ?? previous };
  signal.markModified('payload');
  await signal.save();

  await Label.create({
    ownerId, runKind: 'investigate', verdict: label,
    before: { signalId: signal._id.toString(), userAgent: (signal.payload as { userAgent?: string }).userAgent, msSinceCreated: (signal.payload as { msSinceCreated?: number }).msSinceCreated, classifierVerdict: previous },
    labeledBy: new mongoose.Types.ObjectId(ownerId),
  });

  if (signal.emailId) await syncEmailFromSignals(signal.emailId);
  return signal;
}

// Rebuilds the email's open bookkeeping (events[].automated, openCount,
// firstOpenedAt, lastOpenedAt, status) from its open signals, which are the
// source of truth once labels and reclassification exist.
export async function syncEmailFromSignals(emailId: mongoose.Types.ObjectId | string): Promise<void> {
  const email = await Email.findById(emailId);
  if (!email) return;
  const opens = await Signal.find({ emailId: email._id, type: 'open' }).sort({ at: 1 }).lean();
  const byIndex = new Map<number, { integrity: { verdict: string } }>();
  for (const s of opens) {
    const idx = (s.payload as { eventIndex?: number }).eventIndex;
    if (typeof idx === 'number') byIndex.set(idx, s);
  }
  let count = 0; let first: Date | undefined; let last: Date | undefined;
  email.events.forEach((ev, i) => {
    if (ev.type !== 'opened') return;
    const s = byIndex.get(i);
    const automated = s ? s.integrity.verdict === 'automated' : Boolean(ev.automated);
    ev.automated = automated;
    if (!automated) { count += 1; first = first ?? ev.timestamp; last = ev.timestamp; }
  });
  email.openCount = count;
  email.firstOpenedAt = first;
  email.lastOpenedAt = last;
  if (count > 0) email.status = 'opened';
  else if (email.status === 'opened') email.status = 'delivered';
  email.markModified('events');
  await email.save();
}

// Re-runs the classifier over historical open signals under the current
// rule set. Labelled signals are never touched. Returns how many changed.
export async function reclassifyOpens(opts: { ownerId?: string; limit?: number } = {}): Promise<{ scanned: number; changed: number; emailsTouched: number }> {
  const rules = await loadActiveRules(true);
  const q: Record<string, unknown> = { type: 'open', 'integrity.label': { $exists: false } };
  if (opts.ownerId) q.ownerId = opts.ownerId;
  const cursor = Signal.find(q).sort({ at: -1 }).limit(opts.limit ?? 50_000).cursor();
  let scanned = 0, changed = 0;
  const touched = new Set<string>();
  for await (const s of cursor) {
    scanned += 1;
    const p = s.payload as { userAgent?: string; ip?: string; msSinceCreated?: number };
    const r = classifyWith(rules, { userAgent: p.userAgent ?? '', ip: p.ip ?? '', msSinceCreated: p.msSinceCreated ?? 0 });
    const verdict = r.automated ? 'automated' : 'human';
    const ruleChanged = String(s.integrity.ruleId ?? '') !== String(r.ruleId ?? '');
    if (s.integrity.verdict !== verdict || ruleChanged) {
      s.integrity.verdict = verdict;
      s.integrity.ruleId = r.ruleId;
      await s.save();
      changed += 1;
      if (s.emailId) touched.add(s.emailId.toString());
    }
  }
  for (const id of touched) await syncEmailFromSignals(id);
  return { scanned, changed, emailsTouched: touched.size };
}
