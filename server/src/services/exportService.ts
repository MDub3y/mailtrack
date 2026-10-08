import mongoose from 'mongoose';
import { Contact } from '../models/Contact';
import { Memory } from '../models/Memory';
import { Email } from '../models/Email';
import { Signal, SignalType } from '../models/Signal';

// Portable export (doc/05, Elevation 7): one markdown document per contact
// with the brief, every active item with its source and date, and the
// human-verdict timeline. Memory that can leave is memory the owner owns.
// No model, no email bodies from other people: evidence is the quote the
// item was built on, capped, with the email's subject and date.

const QUOTE_MAX = 200;
const TYPE_LABEL: Record<SignalType, string> = {
  sent: 'sent', delivered: 'delivered', failed: 'failed', open: 'opened', link_click: 'clicked a link', doc_view: 'viewed a document',
  page_dwell: 'read a document', reply: 'replied', bounce: 'bounced', external: 'external event',
};

function day(d: Date): string { return d.toISOString().slice(0, 10); }
function stamp(d: Date): string { return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
function esc(s: string): string { return s.replace(/\r?\n/g, ' ').trim(); }

export async function renderContactMarkdown(ownerId: string | mongoose.Types.ObjectId, contactId: string | mongoose.Types.ObjectId): Promise<string | null> {
  const c = await Contact.findOne({ _id: contactId, ownerId }).lean();
  if (!c) return null;
  const [memory, signals] = await Promise.all([
    Memory.find({ ownerId, subjectId: c._id, status: 'active', kind: { $in: ['commitment', 'preference', 'fact', 'engagement'] } }).sort({ kind: 1, createdAt: 1 }).lean(),
    Signal.find({ ownerId, contactId: c._id, 'integrity.verdict': { $ne: 'automated' }, type: { $ne: 'page_dwell' } }).sort({ at: -1 }).limit(300).lean(),
  ]);
  const emailIds = [...new Set(memory.flatMap((m) => m.evidence.map((e) => e.emailId?.toString())).filter((x): x is string => !!x))];
  const emails = await Email.find({ _id: { $in: emailIds } }).select('subject createdAt direction').lean();
  const emailById = new Map(emails.map((e) => [e._id.toString(), e]));

  const out: string[] = [];
  out.push(`# ${c.displayName ? `${c.displayName} <${c.address}>` : c.address}`);
  out.push('');
  out.push(`Exported from Proofbox on ${stamp(new Date())}. Sent ${c.stats.sent}, opened ${c.stats.opened}, replied ${c.stats.replied}, document views ${c.stats.docViews}.${c.lastSignalAt ? ` Last activity ${day(c.lastSignalAt)}.` : ''}`);
  out.push('');

  out.push('## Brief');
  out.push('');
  out.push(c.brief ? `${esc(c.brief.text)}\n\n_Written ${day(c.brief.generatedAt)} from ${c.brief.citedMemoryIds.length} memory item${c.brief.citedMemoryIds.length === 1 ? '' : 's'} and ${c.brief.basedOnSignalCount} signals._` : '_No brief yet._');
  out.push('');

  for (const kind of ['commitment', 'preference', 'fact', 'engagement'] as const) {
    const items = memory.filter((m) => m.kind === kind);
    if (!items.length) continue;
    out.push(`## ${{ commitment: 'Commitments', preference: 'Preferences', fact: 'Facts', engagement: 'Engagement' }[kind]}`);
    out.push('');
    for (const m of items) {
      const s = (m.structured ?? {}) as Record<string, unknown>;
      const meta: string[] = [];
      if (kind === 'commitment') {
        if (s.by === 'sender') meta.push('you promised'); else if (s.by === 'contact') meta.push('they promised');
        if (m.expiresAt) meta.push(`due ${day(m.expiresAt)}`);
        if (s.fulfilledByEmailId) meta.push('fulfilled');
      }
      meta.push(`${m.source === 'user' ? 'added by you' : m.source === 'system' ? 'computed' : 'extracted'} ${day(m.createdAt)}`);
      if (m.source === 'agent') meta.push(`confidence ${m.confidence.toFixed(2)}`);
      out.push(`- ${esc(m.content)} _(${meta.join(', ')})_`);
      for (const e of m.evidence) {
        const em = e.emailId ? emailById.get(e.emailId.toString()) : undefined;
        const where = em ? `${em.direction === 'inbound' ? 'their email' : 'your email'} "${esc(em.subject)}" (${day(em.createdAt)})` : e.signalId ? 'a signal' : 'an email';
        out.push(`  - source: ${where}${e.quote ? `: "${esc(e.quote).slice(0, QUOTE_MAX)}"` : ''}`);
      }
    }
    out.push('');
  }

  out.push('## Timeline');
  out.push('');
  if (!signals.length) out.push('_No activity recorded._');
  for (const sg of signals) {
    const p = (sg.payload ?? {}) as Record<string, unknown>;
    const detail = sg.type === 'doc_view' && typeof p.documentName === 'string' ? ` (${esc(p.documentName)})`
      : sg.type === 'reply' && typeof p.subject === 'string' ? ` (${esc(p.subject)})`
      : sg.type === 'external' && typeof p.kind === 'string' ? ` (${esc(p.kind)})`
      : sg.type === 'link_click' && typeof p.url === 'string' ? ` (${esc(p.url)})` : '';
    out.push(`- ${stamp(sg.at)}: ${TYPE_LABEL[sg.type]}${detail}${sg.integrity.verdict === 'unknown' ? ' _(unverified)_' : ''}`);
  }
  out.push('');
  return out.join('\n');
}

export async function renderAllContactsMarkdown(ownerId: string | mongoose.Types.ObjectId): Promise<string> {
  const contacts = await Contact.find({ ownerId }).sort({ lastSignalAt: -1, createdAt: -1 }).limit(500).select('_id').lean();
  const parts: string[] = [`# Proofbox memory export\n\n${contacts.length} contact${contacts.length === 1 ? '' : 's'}, exported ${stamp(new Date())}.\n`];
  for (const c of contacts) {
    const md = await renderContactMarkdown(ownerId, c._id);
    if (md) parts.push(md.replace(/^# /, '## ').replace(/^## (Brief|Commitments|Preferences|Facts|Engagement|Timeline)$/gm, '### $1'));
  }
  return parts.join('\n---\n\n');
}
