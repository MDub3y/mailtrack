import { z } from 'zod';
import { Email } from '../../models/Email';
import { Contact } from '../../models/Contact';
import { Memory } from '../../models/Memory';
import { ContextBuilder, wrapUntrusted } from '../context/builder';
import { runAgent } from '../runAgent';
import { applyExtraction, ApplyExtractionResult, ExtractedItem } from './policy';
import { EXTRACTION_SYSTEM } from './extractPrompt';

// Turns one email into memory items (doc/02-ai-architecture.md §1.4).
// The one guard that matters: every item must quote a span that actually
// appears in the source text. A fabricated quote drops the item.

export const ExtractionOutput = z.object({
  items: z.array(z.object({
    kind: z.enum(['fact', 'commitment', 'preference']),
    content: z.string().min(3).max(160),
    structured: z.record(z.string(), z.unknown()).optional(),
    quote: z.string().min(3),
    confidence: z.number().min(0).max(1),
    supersedes: z.string().optional(),
  })),
});
export type ExtractionOutputT = z.infer<typeof ExtractionOutput>;

function normaliseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Verbatim check, tolerant of whitespace and case only.
export function quoteAppearsIn(quote: string, text: string): boolean {
  const q = normaliseWs(quote);
  return q.length >= 3 && normaliseWs(text).includes(q);
}

export interface ExtractResult {
  runId: string;
  extracted: number;
  droppedForQuote: number;
  applied: ApplyExtractionResult;
}

// `direction` says whose words these are. Only the sender's own text is
// trusted; a reply is wrapped as untrusted and lands as proposed (ADR-9).
export async function extractMemoryForEmail(emailId: string, direction: 'outbound' | 'inbound' = 'outbound'): Promise<ExtractResult | null> {
  const email = await Email.findById(emailId);
  if (!email) return null;
  const contactId = email.contactId ?? (await Contact.findOne({ ownerId: email.senderId, address: email.to }))?._id;
  if (!contactId) return null;
  const contact = await Contact.findById(contactId);

  const bodyText = (email.textBody || email.htmlBody.replace(/<[^>]+>/g, ' ')).trim();
  if (!bodyText) return null;

  const active = await Memory.find({ ownerId: email.senderId, subjectId: contactId, status: 'active', kind: { $in: ['fact', 'commitment', 'preference'] } })
    .sort({ createdAt: -1 }).limit(40).lean();

  const trusted = direction === 'outbound';
  const emailBlock = [
    `Date: ${email.createdAt.toISOString().slice(0, 10)}`,
    `${trusted ? 'From the sender to' : 'From'} ${contact?.displayName ? `${contact.displayName} <${email.to}>` : email.to}`,
    `Subject: ${email.subject}`,
    '',
    bodyText,
  ].join('\n');

  const ctx = new ContextBuilder()
    .add({ name: 'system', budgetTokens: 600, stable: true, text: EXTRACTION_SYSTEM })
    .add({
      name: 'memory',
      budgetTokens: 800,
      stable: false,
      items: active.map((m) => ({ id: m._id.toString(), text: `[${m._id}] (${m.kind}) ${m.content}` })),
    })
    .add({
      name: trusted ? 'task' : 'untrusted',
      budgetTokens: 3000,
      stable: false,
      text: trusted ? `Email to extract from:\n\n${emailBlock}` : wrapUntrusted('reply', emailBlock),
    })
    .build();

  const result = await runAgent({
    kind: 'extract_memory',
    ownerId: email.senderId,
    model: 'extractor',
    context: ctx,
    outputSchema: ExtractionOutput,
    maxTokens: 2000,
    inputRefs: { emailIds: [email._id.toString()], contactId: contactId.toString() },
  });

  const kept: ExtractedItem[] = [];
  let droppedForQuote = 0;
  for (const item of result.output.items) {
    if (!quoteAppearsIn(item.quote, bodyText)) { droppedForQuote += 1; continue; }
    kept.push(item);
  }

  const applied = await applyExtraction({
    ownerId: email.senderId,
    contactId,
    emailId: email._id,
    runId: new (await import('mongoose')).default.Types.ObjectId(result.runId),
    items: kept,
    trusted,
  });

  return { runId: result.runId, extracted: result.output.items.length, droppedForQuote, applied };
}
