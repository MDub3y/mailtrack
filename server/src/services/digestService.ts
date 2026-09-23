import mongoose from 'mongoose';
import { User } from '../models/User';
import { Contact } from '../models/Contact';
import { Signal, SignalType } from '../models/Signal';
import { Memory } from '../models/Memory';
import { Proposal } from '../models/Proposal';
import { FingerprintRule } from '../models/FingerprintRule';
import { Label } from '../models/Label';
import { buildQueue, QueueItem } from './queueService';

// "What changed since I last looked" (doc/05, Elevation 6). Deterministic:
// every line is a query over signals, the queue, proposals, memory, and
// rules. No model here; a two-sentence headline over this list is optional
// and lives in ai/digest.

export interface DigestContactLine {
  contact: { _id: string; address: string; displayName?: string };
  signals: Array<{ type: SignalType; count: number; last: Date; detail?: string }>;
  total: number;
}

export interface DigestView {
  since: Date;
  now: Date;
  firstLook: boolean;
  contacts: DigestContactLine[];
  queue: { appeared: QueueItem[]; resolved: Array<{ key: string; rule: string; contactAddress?: string }>; current: number };
  autoAccepted: Array<{ proposalId: string; kind: string; content: string; contact?: { _id: string; address: string; displayName?: string }; decidedAt: Date; memoryId?: string }>;
  commitmentsDue: Array<{ memoryId: string; contact: { _id: string; address: string; displayName?: string }; content: string; by: 'sender' | 'contact' | 'unknown'; dueAt: Date; overdue: boolean }>;
  integrity: { rulesAccepted: Array<{ ruleId: string; pattern: string; patternType: string; verdict: string; at: Date }>; corrections: number };
  hasSomething: boolean;
}

const DUE_WINDOW_DAYS = 2;
const DEFAULT_LOOKBACK_HOURS = 24;

export function queueKey(i: QueueItem): string {
  return `${i.rule}:${i.email?._id ?? ''}:${i.memoryId ?? ''}`;
}

function signalDetail(type: SignalType, payload: Record<string, unknown>): string | undefined {
  if (type === 'doc_view' || type === 'page_dwell') return typeof payload.documentName === 'string' ? payload.documentName : undefined;
  if (type === 'reply') return typeof payload.subject === 'string' ? payload.subject : undefined;
  if (type === 'link_click') return typeof payload.url === 'string' ? payload.url : undefined;
  if (type === 'external') return typeof payload.summary === 'string' ? payload.summary : typeof payload.kind === 'string' ? payload.kind : undefined;
  return undefined;
}

export async function buildDigest(ownerId: string | mongoose.Types.ObjectId, opts: { since?: Date; now?: Date } = {}): Promise<DigestView> {
  const now = opts.now ?? new Date();
  const user = await User.findById(ownerId).select('digest').lean();
  const lastSeenAt = user?.digest?.lastSeenAt;
  const since = opts.since ?? lastSeenAt ?? new Date(now.getTime() - DEFAULT_LOOKBACK_HOURS * 3_600_000);
  const storedKeys = new Set(user?.digest?.queueKeys ?? []);

  // Signals since, human or unknown verdict only, grouped per contact and type.
  const signals = await Signal.find({ ownerId, at: { $gte: since, $lte: now }, 'integrity.verdict': { $ne: 'automated' } }).sort({ at: -1 }).lean();
  const perContact = new Map<string, Map<SignalType, { count: number; last: Date; detail?: string }>>();
  for (const s of signals) {
    const cid = s.contactId.toString();
    const byType = perContact.get(cid) ?? new Map();
    const cur = byType.get(s.type) ?? { count: 0, last: s.at, detail: undefined };
    cur.count += 1;
    if (s.at > cur.last) cur.last = s.at;
    cur.detail = cur.detail ?? signalDetail(s.type, (s.payload ?? {}) as Record<string, unknown>);
    byType.set(s.type, cur);
    perContact.set(cid, byType);
  }
  const contactIds = [...perContact.keys()].map((id) => new mongoose.Types.ObjectId(id));
  const contacts = await Contact.find({ _id: { $in: contactIds } }).select('address displayName').lean();
  const contactById = new Map(contacts.map((c) => [c._id.toString(), c]));
  const contactLines: DigestContactLine[] = [...perContact.entries()].map(([cid, byType]) => {
    const c = contactById.get(cid);
    const lines = [...byType.entries()].map(([type, v]) => ({ type, count: v.count, last: v.last, detail: v.detail })).sort((a, b) => b.last.getTime() - a.last.getTime());
    return { contact: { _id: cid, address: c?.address ?? '', displayName: c?.displayName }, signals: lines, total: lines.reduce((n, l) => n + l.count, 0) };
  }).sort((a, b) => b.signals[0].last.getTime() - a.signals[0].last.getTime());

  // Queue: what appeared and what resolved since the last look.
  const queue = await buildQueue(ownerId, { now });
  const currentKeys = new Map(queue.map((i) => [queueKey(i), i]));
  const appeared = queue.filter((i) => !storedKeys.has(queueKey(i)));
  const resolved = [...storedKeys].filter((k) => !currentKeys.has(k)).map((k) => ({ key: k, rule: k.split(':')[0], contactAddress: undefined as string | undefined }));

  // Proposals the policy accepted on its own: each one is revertable.
  const auto = await Proposal.find({ ownerId, status: 'auto_accepted', decidedAt: { $gte: since, $lte: now } }).sort({ decidedAt: -1 }).limit(50).lean();
  const autoMemory = await Memory.find({ proposalId: { $in: auto.map((p) => p._id) } }).select('_id proposalId subjectId').lean();
  const memByProposal = new Map(autoMemory.map((m) => [m.proposalId!.toString(), m]));
  const autoContactIds = [...new Set(autoMemory.map((m) => m.subjectId?.toString()).filter((x): x is string => !!x))];
  const autoContacts = await Contact.find({ _id: { $in: autoContactIds } }).select('address displayName').lean();
  const autoContactById = new Map(autoContacts.map((c) => [c._id.toString(), c]));
  const autoAccepted = auto.map((p) => {
    const payload = (p.payload ?? {}) as { content?: string; kind?: string };
    const mem = memByProposal.get(p._id.toString());
    const c = mem?.subjectId ? autoContactById.get(mem.subjectId.toString()) : undefined;
    return {
      proposalId: p._id.toString(), kind: p.kind, content: payload.content ?? p.kind, decidedAt: p.decidedAt!, memoryId: mem?._id.toString(),
      contact: c ? { _id: c._id.toString(), address: c.address, displayName: c.displayName } : undefined,
    };
  });

  // Commitments due within the window, both directions, plus anything overdue and open.
  const dueBefore = new Date(now.getTime() + DUE_WINDOW_DAYS * 86_400_000);
  const due = await Memory.find({ ownerId, kind: 'commitment', status: 'active', expiresAt: { $lte: dueBefore }, 'structured.fulfilledByEmailId': { $exists: false } }).sort({ expiresAt: 1 }).limit(50).lean();
  const dueContacts = await Contact.find({ _id: { $in: due.map((m) => m.subjectId).filter(Boolean) } }).select('address displayName').lean();
  const dueContactById = new Map(dueContacts.map((c) => [c._id.toString(), c]));
  const commitmentsDue = due.map((m) => {
    const c = m.subjectId ? dueContactById.get(m.subjectId.toString()) : undefined;
    const by = (m.structured as { by?: string } | undefined)?.by;
    return {
      memoryId: m._id.toString(), content: m.content, dueAt: m.expiresAt!, overdue: m.expiresAt! < now,
      by: (by === 'sender' || by === 'contact' ? by : 'unknown') as 'sender' | 'contact' | 'unknown',
      contact: { _id: m.subjectId?.toString() ?? '', address: c?.address ?? '', displayName: c?.displayName },
    };
  });

  // Integrity: rules that went live, and corrections made, since.
  const rules = await FingerprintRule.find({ status: 'active', origin: { $ne: 'seed' }, createdAt: { $gte: since, $lte: now } }).select('pattern patternType verdict createdAt').lean();
  const corrections = await Label.countDocuments({ ownerId, createdAt: { $gte: since, $lte: now }, labeledBy: { $ne: 'policy' } });

  const view: DigestView = {
    since, now, firstLook: !lastSeenAt,
    contacts: contactLines,
    queue: { appeared, resolved, current: queue.length },
    autoAccepted,
    commitmentsDue,
    integrity: { rulesAccepted: rules.map((r) => ({ ruleId: r._id.toString(), pattern: r.pattern, patternType: r.patternType, verdict: r.verdict, at: r.createdAt })), corrections },
    hasSomething: false,
  };
  view.hasSomething = view.contacts.length > 0 || appeared.length > 0 || resolved.length > 0 || autoAccepted.length > 0 || commitmentsDue.length > 0 || rules.length > 0;
  return view;
}

// Records that the owner looked, so the next digest starts here and the
// queue diff has a baseline.
export async function markDigestSeen(ownerId: string | mongoose.Types.ObjectId, opts: { now?: Date } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const queue = await buildQueue(ownerId, { now });
  await User.updateOne({ _id: ownerId }, { $set: { 'digest.lastSeenAt': now, 'digest.queueKeys': queue.map(queueKey) } });
}

// ---------------------------------------------------------------- rendering

const TYPE_LABEL: Record<SignalType, string> = {
  sent: 'sent', delivered: 'delivered', failed: 'failed to send', open: 'opened', link_click: 'clicked a link', doc_view: 'read a document',
  page_dwell: 'spent time on a document', reply: 'replied', bounce: 'bounced', external: 'external event',
};

function who(c: { address: string; displayName?: string }): string {
  return c.displayName ? `${c.displayName} <${c.address}>` : c.address;
}

function day(d: Date): string { return d.toISOString().slice(0, 10); }

// Plain text and markdown are the same document here: short lines, no
// styling, readable in any client. Used for the email and as the model's
// input for the headline.
export function renderDigestText(v: DigestView): string {
  const out: string[] = [];
  out.push(`What changed since ${v.since.toISOString().replace('T', ' ').slice(0, 16)} UTC`);
  out.push('');
  if (!v.hasSomething) { out.push('Nothing new. No signals from people, no queue changes, nothing accepted on its own, nothing due.'); return out.join('\n'); }

  if (v.contacts.length) {
    out.push('## Activity');
    for (const line of v.contacts) {
      const parts = line.signals.map((s) => `${TYPE_LABEL[s.type]}${s.count > 1 ? ` ×${s.count}` : ''}${s.detail ? ` (${s.detail})` : ''}`);
      out.push(`- ${who(line.contact)}: ${parts.join(', ')}`);
    }
    out.push('');
  }
  if (v.queue.appeared.length || v.queue.resolved.length) {
    out.push(`## Follow-through (${v.queue.current} open)`);
    for (const i of v.queue.appeared) out.push(`- new: ${who(i.contact)}: ${i.reason}`);
    for (const r of v.queue.resolved) out.push(`- resolved: ${r.rule.replace(/_/g, ' ')}`);
    out.push('');
  }
  if (v.commitmentsDue.length) {
    out.push('## Commitments due');
    for (const c of v.commitmentsDue) out.push(`- ${c.overdue ? 'overdue' : `due ${day(c.dueAt)}`}, ${c.by === 'sender' ? 'you promised' : c.by === 'contact' ? 'they promised' : 'promised'}: ${c.content} (${who(c.contact)})`);
    out.push('');
  }
  if (v.autoAccepted.length) {
    out.push('## Remembered without asking (each can be reverted)');
    for (const a of v.autoAccepted) out.push(`- ${a.content}${a.contact ? ` (${who(a.contact)})` : ''}`);
    out.push('');
  }
  if (v.integrity.rulesAccepted.length || v.integrity.corrections) {
    out.push('## Signal integrity');
    for (const r of v.integrity.rulesAccepted) out.push(`- rule live: ${r.patternType} ${r.pattern} → ${r.verdict}`);
    if (v.integrity.corrections) out.push(`- corrections you made: ${v.integrity.corrections}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

export function renderDigestHtml(v: DigestView, headline?: string): string {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));
  const text = renderDigestText(v);
  const body = text.split('\n').map((l) => {
    if (l.startsWith('## ')) return `<h3 style="margin:16px 0 6px;font-size:14px">${esc(l.slice(3))}</h3>`;
    if (l.startsWith('- ')) return `<div style="margin:2px 0 2px 12px">• ${esc(l.slice(2))}</div>`;
    if (!l.trim()) return '';
    return `<div>${esc(l)}</div>`;
  }).join('');
  return `<div style="font-family:system-ui,sans-serif;font-size:13px;color:#0f172a;line-height:1.5">${headline ? `<p style="font-size:14px;margin:0 0 12px">${esc(headline)}</p>` : ''}${body}</div>`;
}
