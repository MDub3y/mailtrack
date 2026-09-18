import mongoose from 'mongoose';
import { Email } from '../models/Email';
import { Contact } from '../models/Contact';
import { Memory } from '../models/Memory';
import { Signal } from '../models/Signal';
import { QueueState, QueueRule } from '../models/QueueState';

// The follow-through queue is a query over emails, contacts, signals, and
// memory (doc/02-ai-architecture.md §1.9; ADR-3). Each rule produces a reason
// string that is the explanation; there is no scoring step and no model.

const DAY = 86_400_000;

export interface QueueThresholds {
  unopenedAfterDays: number;
  minOpensNoReply: number;
  minDwellSeconds: number;
  commitmentDueWithinDays: number;
  renewedInterestQuietDays: number;
  dismissCooldownDays: number;
}

export const DEFAULT_THRESHOLDS: QueueThresholds = {
  unopenedAfterDays: 3,
  minOpensNoReply: 2,
  minDwellSeconds: 60,
  commitmentDueWithinDays: 2,
  renewedInterestQuietDays: 7,
  dismissCooldownDays: 7,
};

export interface QueueItem {
  rule: QueueRule;
  reason: string;
  contact: { _id: string; address: string; displayName?: string; brief?: string };
  email?: { _id: string; subject: string; createdAt: Date; status: string };
  memoryId?: string;
  at: Date; // what the item is "about", for ordering
}

function daysAgo(d: Date, now: Date): number {
  return Math.floor((now.getTime() - d.getTime()) / DAY);
}
function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function ago(d: Date, now: Date): string {
  const n = daysAgo(d, now);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return `${n} days ago`;
}

export async function buildQueue(ownerId: mongoose.Types.ObjectId | string, opts: { now?: Date; thresholds?: Partial<QueueThresholds> } = {}): Promise<QueueItem[]> {
  const now = opts.now ?? new Date();
  const t = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const items: QueueItem[] = [];

  const contacts = await Contact.find({ ownerId }).lean();
  const contactById = new Map(contacts.map((c) => [c._id.toString(), c]));
  const contactView = (id: mongoose.Types.ObjectId) => {
    const c = contactById.get(id.toString());
    return c ? { _id: c._id.toString(), address: c.address, displayName: c.displayName, brief: c.brief?.text } : { _id: id.toString(), address: 'unknown' };
  };

  // Latest email per contact drives the per-email rules; older emails in
  // the same thread are not separately nagged about.
  const emails = await Email.find({ senderId: ownerId, contactId: { $exists: true }, status: { $in: ['delivered', 'opened'] } })
    .sort({ createdAt: -1 }).select('_id contactId subject createdAt status').lean();
  const latestByContact = new Map<string, typeof emails[number]>();
  for (const e of emails) {
    const key = e.contactId!.toString();
    if (!latestByContact.has(key)) latestByContact.set(key, e);
  }

  const contactIds = [...latestByContact.keys()].map((id) => new mongoose.Types.ObjectId(id));
  const signals = await Signal.find({ ownerId, contactId: { $in: contactIds }, type: { $in: ['open', 'reply', 'doc_view', 'page_dwell'] } })
    .sort({ at: 1 }).lean();
  const byContact = new Map<string, typeof signals>();
  for (const s of signals) {
    const key = s.contactId.toString();
    if (!byContact.has(key)) byContact.set(key, []);
    byContact.get(key)!.push(s);
  }

  for (const [contactKey, email] of latestByContact) {
    const sigs = byContact.get(contactKey) ?? [];
    const sentAt = email.createdAt;
    const humanOpens = sigs.filter((s) => s.type === 'open' && s.integrity.verdict !== 'automated');
    const opensOnThis = humanOpens.filter((s) => s.emailId?.toString() === email._id.toString());
    const repliedSince = sigs.some((s) => s.type === 'reply' && s.at > sentAt);
    const emailView = { _id: email._id.toString(), subject: email.subject, createdAt: email.createdAt, status: email.status };

    if (repliedSince) continue; // a reply resolves every per-email rule

    // Unopened
    if (opensOnThis.length === 0 && daysAgo(sentAt, now) >= t.unopenedAfterDays) {
      items.push({ rule: 'unopened', reason: `Delivered ${ago(sentAt, now)}, not opened`, contact: contactView(email.contactId!), email: emailView, at: sentAt });
    }

    // Opened, no reply
    if (opensOnThis.length >= t.minOpensNoReply) {
      const first = opensOnThis[0].at;
      items.push({ rule: 'opened_no_reply', reason: `Opened ${opensOnThis.length} times since ${ago(first, now)}, no reply`, contact: contactView(email.contactId!), email: emailView, at: opensOnThis[opensOnThis.length - 1].at });
    }

    // Document interest (dwell on a document linked from this email)
    const dwell = sigs.filter((s) => s.type === 'page_dwell' && s.emailId?.toString() === email._id.toString());
    const best = dwell.reduce<typeof dwell[number] | null>((a, b) => {
      const bt = (b.payload as { totalSeconds?: number }).totalSeconds ?? 0;
      const at = a ? ((a.payload as { totalSeconds?: number }).totalSeconds ?? 0) : -1;
      return bt > at ? b : a;
    }, null);
    if (best) {
      const p = best.payload as { totalSeconds?: number; documentName?: string; topPage?: number };
      if ((p.totalSeconds ?? 0) >= t.minDwellSeconds) {
        const mins = Math.round((p.totalSeconds ?? 0) / 60);
        items.push({
          rule: 'document_interest',
          reason: `Read "${p.documentName ?? 'the document'}" for ${mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${p.totalSeconds} seconds`} ${ago(best.at, now)}${p.topPage ? `, longest on page ${p.topPage}` : ''}, no reply`,
          contact: contactView(email.contactId!), email: emailView, at: best.at,
        });
      }
    }

    // Renewed interest: an open after a quiet stretch
    if (humanOpens.length >= 2) {
      const last = humanOpens[humanOpens.length - 1];
      const prev = humanOpens[humanOpens.length - 2];
      const quiet = daysAgo(prev.at, last.at);
      if (quiet >= t.renewedInterestQuietDays && daysAgo(last.at, now) <= 2) {
        items.push({ rule: 'renewed_interest', reason: `Opened again ${ago(last.at, now)} after ${quiet} quiet days`, contact: contactView(email.contactId!), email: emailView, at: last.at });
      }
    }
  }

  // Commitments, both directions
  const horizon = new Date(now.getTime() + t.commitmentDueWithinDays * DAY);
  const commitments = await Memory.find({ ownerId, kind: 'commitment', status: 'active', expiresAt: { $lte: horizon }, 'structured.fulfilledByEmailId': { $exists: false } }).lean();
  for (const m of commitments) {
    const by = (m.structured as { by?: string } | undefined)?.by;
    const due = m.expiresAt!;
    const dueText = due < now ? `was due ${ago(due, now)}` : `due ${fmtDay(due)}`;
    const contact = m.subjectId ? contactView(m.subjectId) : { _id: '', address: 'unknown' };
    const linkedEmailId = m.evidence.find((e) => e.emailId)?.emailId;
    const linked = linkedEmailId ? emails.find((e) => e._id.toString() === linkedEmailId.toString()) : undefined;
    const emailView = linked ? { _id: linked._id.toString(), subject: linked.subject, createdAt: linked.createdAt, status: linked.status } : undefined;
    if (by === 'contact') {
      items.push({ rule: 'their_commitment_due', reason: `They said: ${m.content} (${dueText})`, contact, email: emailView, memoryId: m._id.toString(), at: due });
    } else {
      items.push({ rule: 'your_commitment_due', reason: `${m.content} (${dueText})`, contact, email: emailView, memoryId: m._id.toString(), at: due });
    }
  }

  // Snooze / dismiss
  const states = await QueueState.find({ ownerId, until: { $gt: now } }).lean();
  // Commitment items are keyed by the memory item; per-email rules by the email.
  const keyOf = (rule: string, emailId?: string, memoryId?: string) => (memoryId ? `${rule}:m:${memoryId}` : `${rule}:e:${emailId ?? ''}`);
  const hidden = new Set(states.map((s) => keyOf(s.rule, s.emailId?.toString(), s.memoryId?.toString())));
  const visible = items.filter((i) => !hidden.has(keyOf(i.rule, i.email?._id, i.memoryId)));

  visible.sort((a, b) => b.at.getTime() - a.at.getTime());
  return visible;
}

export async function snoozeItem(ownerId: string, rule: QueueRule, ref: { emailId?: string; memoryId?: string }, until: Date): Promise<void> {
  await QueueState.findOneAndUpdate(
    { ownerId, rule, emailId: ref.emailId, memoryId: ref.memoryId },
    { $set: { action: 'snoozed', until }, $setOnInsert: { ownerId, rule, emailId: ref.emailId, memoryId: ref.memoryId, createdAt: new Date() } },
    { upsert: true }
  );
}

export async function dismissItem(ownerId: string, rule: QueueRule, ref: { emailId?: string; memoryId?: string }, cooldownDays = DEFAULT_THRESHOLDS.dismissCooldownDays): Promise<void> {
  const until = new Date(Date.now() + cooldownDays * DAY);
  await QueueState.findOneAndUpdate(
    { ownerId, rule, emailId: ref.emailId, memoryId: ref.memoryId },
    { $set: { action: 'dismissed', until }, $setOnInsert: { ownerId, rule, emailId: ref.emailId, memoryId: ref.memoryId, createdAt: new Date() } },
    { upsert: true }
  );
}
