import mongoose from 'mongoose';
import { z } from 'zod';
import { Contact } from '../../models/Contact';
import { Signal } from '../../models/Signal';
import { ContextBuilder } from '../context/builder';
import { runAgent } from '../runAgent';
import { activeMemory, renderMemoryLine } from './retrieve';

// The consolidated brief (doc/02-ai-architecture.md §1.7): two to four
// sentences above the items, every sentence backed by cited item ids. New
// episodes fold into the previous brief; older history is not re-read.

export const BriefOutput = z.object({
  text: z.string().min(10).max(700),
  citedMemoryIds: z.array(z.string()).min(1),
});

const SYSTEM = [
  'You maintain a short brief about one contact for the person who emails them.',
  'Write two to four plain sentences: where things stand, what is owed in either direction, and what the engagement pattern says.',
  'Only say things supported by the memory items or signals given; cite the ids of every memory item you relied on in citedMemoryIds.',
  'Fold new signals into the previous brief rather than rewriting from scratch; keep what is still true.',
  'No greetings, no advice, no scores. Facts and their dates.',
].join('\n');

const MIN_SIGNALS_FOR_BRIEF = 2;
const MAX_SIGNALS_IN_CONTEXT = 40;

export async function generateBrief(contactId: mongoose.Types.ObjectId | string): Promise<{ runId: string; text: string } | null> {
  const contact = await Contact.findById(contactId);
  if (!contact) return null;

  const memory = await activeMemory(contact.ownerId, contact._id);
  const since = contact.brief?.generatedAt;
  const signalQuery: Record<string, unknown> = { ownerId: contact.ownerId, contactId: contact._id, 'integrity.verdict': { $ne: 'automated' } };
  if (since) signalQuery.at = { $gt: since };
  const signals = await Signal.find(signalQuery).sort({ at: -1 }).limit(MAX_SIGNALS_IN_CONTEXT).lean();
  const totalSignals = await Signal.countDocuments({ ownerId: contact.ownerId, contactId: contact._id });

  // Nothing to say yet: no memory beyond the engagement line and too few events.
  const nonEngagement = memory.filter((m) => m.kind !== 'engagement');
  if (nonEngagement.length === 0 && totalSignals < MIN_SIGNALS_FOR_BRIEF) {
    await Contact.updateOne({ _id: contact._id }, { $unset: { briefDirtyAt: 1 } });
    return null;
  }
  if (memory.length === 0) {
    await Contact.updateOne({ _id: contact._id }, { $unset: { briefDirtyAt: 1 } });
    return null;
  }

  const signalLines = signals.map((s) => {
    const p = (s.payload ?? {}) as Record<string, unknown>;
    const when = s.at.toISOString().slice(0, 16).replace('T', ' ');
    switch (s.type) {
      case 'sent': return `${when} sent: "${p.subject ?? ''}"`;
      case 'open': return `${when} opened`;
      case 'doc_view': return `${when} viewed document "${p.documentName ?? ''}"`;
      case 'page_dwell': return `${when} spent ${p.totalSeconds ?? '?'}s in "${p.documentName ?? ''}", longest on page ${p.topPage ?? '?'}`;
      case 'reply': return `${when} replied`;
      default: return `${when} ${s.type}`;
    }
  });

  const ctx = new ContextBuilder()
    .add({ name: 'system', budgetTokens: 400, stable: true, text: SYSTEM })
    .add({
      name: 'memory',
      budgetTokens: 1500,
      stable: false,
      items: memory.map((m) => ({ id: m._id.toString(), text: renderMemoryLine(m) })),
    })
    .add({
      name: 'thread',
      budgetTokens: 900,
      stable: false,
      text: [
        contact.brief ? `Previous brief (${contact.brief.generatedAt.toISOString().slice(0, 10)}):\n${contact.brief.text}` : 'No previous brief.',
        '',
        signals.length ? `Signals since then (newest first):\n${signalLines.join('\n')}` : 'No new signals since the previous brief.',
      ].join('\n'),
    })
    .add({
      name: 'task',
      budgetTokens: 120,
      stable: false,
      text: `Write the brief for ${contact.displayName ? `${contact.displayName} <${contact.address}>` : contact.address}. Today is ${new Date().toISOString().slice(0, 10)}.`,
    })
    .build();

  const result = await runAgent({
    kind: 'contact_brief',
    ownerId: contact.ownerId,
    model: 'primary',
    effort: 'low',
    context: ctx,
    outputSchema: BriefOutput,
    maxTokens: 1200,
    inputRefs: { contactId: contact._id.toString() },
    citedIds: (o) => o.citedMemoryIds,
  });

  await Contact.updateOne(
    { _id: contact._id },
    {
      $set: {
        brief: {
          text: result.output.text,
          citedMemoryIds: result.output.citedMemoryIds.map((id) => new mongoose.Types.ObjectId(id)),
          basedOnSignalCount: totalSignals,
          generatedAt: new Date(),
          runId: new mongoose.Types.ObjectId(result.runId),
        },
      },
      $unset: { briefDirtyAt: 1 },
    }
  );
  return { runId: result.runId, text: result.output.text };
}
