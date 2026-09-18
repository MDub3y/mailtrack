import mongoose from 'mongoose';
import { Contact, IContact } from '../models/Contact';
import { Signal, SignalType, SignalSource, IntegrityVerdict, ISignal } from '../models/Signal';
import { IEmail } from '../models/Email';

// The single write path for contacts and signals. Deliberately free of any
// ai/ import: the pixel route and the queue call this and must stay off the
// model's path (ADR-1). Memory-side reactions (engagement recompute, brief
// scheduling) are hooked in from ai/ via `onSignal`, not imported here.

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}

export async function ensureContact(
  ownerId: string | mongoose.Types.ObjectId,
  address: string,
  opts: { displayName?: string } = {}
): Promise<IContact> {
  const addr = address.toLowerCase().trim();
  const contact = await Contact.findOneAndUpdate(
    { ownerId, address: addr },
    {
      $setOnInsert: { ownerId, address: addr, domain: domainOf(addr), createdAt: new Date() },
      ...(opts.displayName ? { $set: { displayName: opts.displayName } } : {}),
    },
    { upsert: true, new: true }
  );
  return contact!;
}

export interface RecordSignalInput {
  ownerId: string | mongoose.Types.ObjectId;
  contactId: string | mongoose.Types.ObjectId;
  type: SignalType;
  at?: Date;
  emailId?: string | mongoose.Types.ObjectId;
  documentId?: string | mongoose.Types.ObjectId;
  payload?: Record<string, unknown>;
  verdict?: IntegrityVerdict;
  ruleId?: string | mongoose.Types.ObjectId;
  source: SignalSource;
  // Idempotency. Callers derive it from what makes the observation unique
  // (e.g. `open:<emailId>:<eventIndex>`), so replays and backfills are safe.
  dedupeKey: string;
}

type SignalListener = (signal: ISignal, isNew: boolean) => void | Promise<void>;
const listeners: SignalListener[] = [];

// Registered from ai/ at boot. Listeners run after the write and never
// block or fail it.
export function onSignal(listener: SignalListener): void {
  listeners.push(listener);
}

export async function recordSignal(input: RecordSignalInput): Promise<{ signal: ISignal; isNew: boolean }> {
  const at = input.at ?? new Date();
  const existing = await Signal.findOne({ dedupeKey: input.dedupeKey });
  if (existing) {
    for (const l of listeners) Promise.resolve(l(existing, false)).catch(() => {});
    return { signal: existing, isNew: false };
  }

  const signal = await Signal.create({
    ownerId: input.ownerId,
    contactId: input.contactId,
    emailId: input.emailId,
    documentId: input.documentId,
    type: input.type,
    at,
    payload: input.payload ?? {},
    integrity: { verdict: input.verdict ?? 'unknown', ruleId: input.ruleId },
    source: input.source,
    dedupeKey: input.dedupeKey,
  });

  const inc: Record<string, number> = {};
  if (input.type === 'sent') inc['stats.sent'] = 1;
  if (input.type === 'open' && (input.verdict ?? 'unknown') === 'human') inc['stats.opened'] = 1;
  if (input.type === 'reply') inc['stats.replied'] = 1;
  if (input.type === 'doc_view') inc['stats.docViews'] = 1;
  await Contact.updateOne(
    { _id: input.contactId },
    {
      $max: { lastSignalAt: at, ...(input.type === 'sent' ? { lastSentAt: at } : {}) },
      $min: input.type === 'sent' ? { firstSentAt: at } : {},
      ...(Object.keys(inc).length ? { $inc: inc } : {}),
    }
  );

  for (const l of listeners) Promise.resolve(l(signal, true)).catch((err) => console.error('[signal listener]', err));
  return { signal, isNew: true };
}

// For signals updated in place (page dwell accumulates on one row): re-run
// the listeners so engagement and the brief pick up the new payload.
export async function notifySignalUpdated(dedupeKey: string): Promise<void> {
  const signal = await Signal.findOne({ dedupeKey });
  if (!signal) return;
  await Contact.updateOne({ _id: signal.contactId }, { $max: { lastSignalAt: new Date() } });
  for (const l of listeners) Promise.resolve(l(signal, false)).catch((err) => console.error('[signal listener]', err));
}

// Convenience for the send path: the contact for an email's recipient.
export async function contactForEmail(email: Pick<IEmail, 'senderId' | 'to' | 'contactId'>): Promise<IContact> {
  if (email.contactId) {
    const c = await Contact.findById(email.contactId);
    if (c) return c;
  }
  return ensureContact(email.senderId, email.to);
}

// Human-verdict signals for a contact, newest first.
export async function timeline(ownerId: string | mongoose.Types.ObjectId, contactId: string | mongoose.Types.ObjectId, opts: { since?: Date; limit?: number; includeAutomated?: boolean } = {}) {
  const q: Record<string, unknown> = { ownerId, contactId };
  if (opts.since) q.at = { $gte: opts.since };
  if (!opts.includeAutomated) q['integrity.verdict'] = { $ne: 'automated' };
  return Signal.find(q).sort({ at: -1 }).limit(opts.limit ?? 200).lean();
}
