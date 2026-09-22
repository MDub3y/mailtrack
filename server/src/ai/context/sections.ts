import mongoose from 'mongoose';
import { Email } from '../../models/Email';
import { Contact, IContact } from '../../models/Contact';
import { MemoryKind } from '../../models/Memory';
import { activeMemory, renderMemoryLine, MemoryLean } from '../memory/retrieve';
import { voiceTextFor } from '../voice/profile';
import { SectionInput } from './builder';
import type { QueueRule } from '../../models/QueueState';

// Section loaders for the drafting task (doc/02 §2.2, doc/05 Elevation 5).
// Each returns a SectionInput the ContextBuilder packs under budget. Order
// and stability are the builder's business; content is this file's.

// Task-aware priority: the queue reason decides which kinds go first so a
// fixed budget fills with what matters for this draft.
const PRIORITY_BY_RULE: Record<QueueRule | 'default', MemoryKind[]> = {
  your_commitment_due:  ['commitment', 'engagement', 'fact', 'preference'],
  their_commitment_due: ['commitment', 'engagement', 'fact', 'preference'],
  document_interest:    ['engagement', 'fact', 'commitment', 'preference'],
  opened_no_reply:      ['engagement', 'commitment', 'preference', 'fact'],
  renewed_interest:     ['engagement', 'commitment', 'fact', 'preference'],
  unopened:             ['preference', 'commitment', 'engagement', 'fact'],
  default:              ['commitment', 'engagement', 'preference', 'fact'],
};

const DEFAULT_VOICE = 'No voice profile yet. Write plainly: short sentences, no exclamation marks, no filler, sign off with the sender\'s first name if known.';

export async function voiceSection(ownerId: mongoose.Types.ObjectId | string): Promise<SectionInput & { hasProfile: boolean }> {
  const text = await voiceTextFor(ownerId);
  return {
    name: 'voice',
    budgetTokens: 400,
    stable: true,
    cacheBoundary: true,
    text: `How the sender writes:\n${text ?? DEFAULT_VOICE}`,
    hasProfile: Boolean(text),
  };
}

export async function memorySection(
  contact: IContact,
  rule?: QueueRule,
  budgetTokens = 1200
): Promise<SectionInput & { items: Array<{ id: string; text: string }>; memory: MemoryLean[] }> {
  const kinds = PRIORITY_BY_RULE[rule ?? 'default'];
  const memory = await activeMemory(contact.ownerId, contact._id, { kinds });
  const items: Array<{ id: string; text: string }> = [];
  if (contact.brief?.text) {
    items.push({ id: `brief:${contact._id}`, text: `Brief: ${contact.brief.text}` });
  }
  for (const m of memory) items.push({ id: m._id.toString(), text: renderMemoryLine(m) });
  return { name: 'memory', budgetTokens, stable: false, items, memory };
}

export interface ThreadEmail {
  id: string;
  date: string;
  subject: string;
  summary: string;
  direction: 'outbound' | 'inbound';
}

// The last N emails with this contact, one line each. Prefers the stored
// summary (written once at extraction) so the section is stable between
// requests; falls back to a truncated body only when none exists.
export async function threadSection(contact: IContact, limit = 8, budgetTokens = 2500): Promise<SectionInput & { emails: ThreadEmail[] }> {
  const rows = await Email.find({ senderId: contact.ownerId, contactId: contact._id })
    .sort({ createdAt: -1 }).limit(limit).select('_id subject textBody htmlBody summary direction createdAt').lean();
  const emails: ThreadEmail[] = rows.map((e) => ({
    id: e._id.toString(),
    date: e.createdAt.toISOString().slice(0, 10),
    subject: e.subject,
    summary: e.summary || (e.textBody || e.htmlBody.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 240),
    direction: e.direction ?? 'outbound',
  }));
  return {
    name: 'thread',
    budgetTokens,
    stable: false,
    items: emails.map((e) => ({ id: e.id, text: `[${e.id}] ${e.date} ${e.direction === 'inbound' ? 'they wrote' : 'you wrote'} "${e.subject}": ${e.summary}` })),
    emails,
  };
}

export interface KnownGaps {
  noVoiceProfile: boolean;
  noReplyData: boolean;
  noMemoryBeyondEngagement: boolean;
  lastEmailDaysAgo?: number;
}

// What the model does not have. Told plainly so it hedges in the right
// places instead of inventing (doc/05 Elevation 5, item 3).
export function describeGaps(g: KnownGaps): string[] {
  const lines: string[] = [];
  if (g.noVoiceProfile) lines.push('There is no voice profile for the sender yet; keep the style neutral and plain.');
  if (g.noReplyData) lines.push('No replies from this contact are on record, so nothing is known about what they said back.');
  if (g.noMemoryBeyondEngagement) lines.push('Nothing specific is remembered about this contact beyond engagement; do not invent details.');
  if (g.lastEmailDaysAgo !== undefined && g.lastEmailDaysAgo > 60) lines.push(`The last email was ${g.lastEmailDaysAgo} days ago; acknowledge the gap rather than pretending continuity.`);
  return lines;
}

export async function loadContact(ownerId: mongoose.Types.ObjectId | string, contactId: mongoose.Types.ObjectId | string): Promise<IContact | null> {
  return Contact.findOne({ _id: contactId, ownerId });
}
