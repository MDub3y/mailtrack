import mongoose from 'mongoose';
import { InboundMessage, IInboundMessage } from '../../models/InboundMessage';
import { Email, IEmail } from '../../models/Email';
import { User } from '../../models/User';
import { ensureContact } from '../../services/signalService';
import { extractMemoryForEmail } from '../memory/extract';

// The expensive step, run only when the category's policy allows it or the
// user asks: the message enters the contact's thread as an inbound Email
// and the extractor reads it as untrusted text (everything it finds is
// proposed, never active). Idempotent: the Email's tracking token is
// derived from the Gmail id, so a retry finds the same row.

export type ProcessTrigger = 'auto' | 'user' | 'retry';

export interface ProcessResult {
  status: 'processed' | 'failed' | 'already_processed';
  emailId?: string;
  runId?: string;
  extracted?: number;
  error?: string;
}

export function inboundTrackingToken(ownerId: string | mongoose.Types.ObjectId, gmailMessageId: string): string {
  return `inbound:${ownerId}:${gmailMessageId}`;
}

export async function materialiseInboundEmail(m: IInboundMessage): Promise<IEmail> {
  const token = inboundTrackingToken(m.ownerId, m.gmailMessageId);
  const existing = await Email.findOne({ trackingToken: token });
  if (existing) return existing;
  if (!m.contactId) {
    const contact = await ensureContact(m.ownerId, m.from.address, { displayName: m.from.name });
    m.contactId = contact._id;
  }
  const owner = await User.findById(m.ownerId).select('gmailAddress email').lean();
  const email = await Email.create({
    senderId: m.ownerId,
    contactId: m.contactId,
    from: m.from.address,
    to: owner?.gmailAddress || owner?.email || m.to[0] || '',
    subject: m.subject,
    htmlBody: '',
    textBody: m.textExcerpt,
    status: 'received',
    direction: 'inbound',
    trackingToken: token,
    providerMessageId: m.gmailMessageId,
    gmailThreadId: m.gmailThreadId,
    rfcMessageId: m.headers.messageId,
    inReplyToEmailId: m.matchedEmailId,
    inboundMessageId: m._id,
    createdAt: m.internalDate,
  });
  m.emailId = email._id;
  await m.save();
  return email;
}

export async function processInboundMessage(inboundMessageId: string, trigger: ProcessTrigger): Promise<ProcessResult | null> {
  const m = await InboundMessage.findById(inboundMessageId);
  if (!m) return null;
  if (m.triage.status === 'processed' && m.emailId) return { status: 'already_processed', emailId: m.emailId.toString(), runId: m.triage.processRunId?.toString() };

  try {
    const email = await materialiseInboundEmail(m);
    const r = await extractMemoryForEmail(email._id.toString(), 'inbound');
    m.triage.status = 'processed';
    m.triage.processedAt = new Date();
    m.triage.processRunId = r ? new mongoose.Types.ObjectId(r.runId) : undefined;
    m.triage.error = undefined;
    await m.save();
    return { status: 'processed', emailId: email._id.toString(), runId: r?.runId, extracted: r?.extracted ?? 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    m.triage.status = 'failed';
    m.triage.error = `${trigger}: ${message}`.slice(0, 500);
    await m.save();
    return { status: 'failed', emailId: m.emailId?.toString(), error: message };
  }
}
