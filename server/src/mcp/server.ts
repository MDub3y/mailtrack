import mongoose from 'mongoose';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Contact } from '../models/Contact';
import { Memory, MemoryKind } from '../models/Memory';
import { Signal } from '../models/Signal';
import { buildQueue } from '../services/queueService';
import { sharedContactView } from '../services/sharedMemoryService';

// Memory that other agents can use (doc/05, Elevation 7): four read-only
// tools over the same queries the app uses. No tool writes, no tool sends,
// no tool returns another person's email body; evidence is a short quote
// with the email it came from, so an answer always carries provenance.

const QUOTE_MAX = 160;
const KIND_ORDER: MemoryKind[] = ['commitment', 'preference', 'fact', 'engagement'];

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}

function notFound(email: string) {
  return { content: [{ type: 'text' as const, text: `No contact with address ${email} in this account.` }], isError: true };
}

async function findContact(ownerId: string, email: string) {
  return Contact.findOne({ ownerId, address: email.trim().toLowerCase() }).lean();
}

function memoryView(m: { _id: mongoose.Types.ObjectId; kind: string; content: string; structured?: Record<string, unknown>; confidence: number; status: string; source: string; evidence: Array<{ emailId?: mongoose.Types.ObjectId; signalId?: mongoose.Types.ObjectId; quote?: string }>; createdAt: Date; lastConfirmedAt?: Date; expiresAt?: Date }) {
  return {
    id: m._id.toString(), kind: m.kind, content: m.content, structured: m.structured ?? {}, confidence: m.confidence, status: m.status, source: m.source,
    dueAt: m.expiresAt?.toISOString() ?? null, createdAt: m.createdAt.toISOString(), lastConfirmedAt: m.lastConfirmedAt?.toISOString() ?? null,
    evidence: m.evidence.map((e) => ({ emailId: e.emailId?.toString() ?? null, signalId: e.signalId?.toString() ?? null, quote: e.quote ? e.quote.slice(0, QUOTE_MAX) : null })),
  };
}

export function createMcpServer(ownerId: string): McpServer {
  const server = new McpServer({ name: 'mailtrack', version: '1.0.0' }, { instructions: 'Read-only memory about the owner\'s email contacts: briefs, sourced memory items, human-verdict timelines, the follow-through queue, and open commitments. Nothing here sends or changes anything.' });

  server.registerTool('contact_brief', {
    title: 'Contact brief',
    description: 'The brief and the active memory (commitments, preferences, facts, engagement) for one contact, each item with its evidence.',
    inputSchema: { email: z.string().describe('The contact\'s email address') },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ email }) => {
    const c = await findContact(ownerId, email);
    if (!c) return notFound(email);
    const items = await Memory.find({ ownerId, subjectId: c._id, status: 'active', kind: { $in: KIND_ORDER } }).sort({ confidence: -1, createdAt: -1 }).lean();
    const grouped: Record<string, ReturnType<typeof memoryView>[]> = {};
    for (const k of KIND_ORDER) grouped[k] = items.filter((m) => m.kind === k).map((m) => memoryView(m as Parameters<typeof memoryView>[0]));
    const shared = await sharedContactView(ownerId, c.address);
    return text({
      contact: { id: c._id.toString(), address: c.address, displayName: c.displayName ?? null, domain: c.domain, stats: c.stats, lastSignalAt: c.lastSignalAt?.toISOString() ?? null },
      brief: c.brief ? { text: c.brief.text, generatedAt: c.brief.generatedAt.toISOString(), citedMemoryIds: c.brief.citedMemoryIds.map(String) } : null,
      memory: grouped,
      // What colleagues in the owner's organisation who share memory know about the same address, attributed per member.
      ...(shared.colleagues.length ? { colleagues: shared.colleagues.map((col) => ({ member: col.member, brief: col.brief?.text ?? null, memory: col.memory.map((m) => ({ id: m._id, kind: m.kind, content: m.content, confidence: m.confidence, dueAt: m.expiresAt?.toISOString() ?? null })) })) } : {}),
    });
  });

  server.registerTool('contact_timeline', {
    title: 'Contact timeline',
    description: 'Signals about one contact, newest first: sent, opens judged human, document views, replies, external events. Automated opens are excluded.',
    inputSchema: {
      email: z.string().describe('The contact\'s email address'),
      since: z.string().optional().describe('ISO date; only signals after this'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
      include_unknown: z.boolean().optional().describe('Also include signals whose integrity verdict is unknown (external events). Default true'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ email, since, limit, include_unknown }) => {
    const c = await findContact(ownerId, email);
    if (!c) return notFound(email);
    const q: Record<string, unknown> = { ownerId, contactId: c._id, 'integrity.verdict': include_unknown === false ? 'human' : { $ne: 'automated' } };
    if (since) q.at = { $gte: new Date(since) };
    const rows = await Signal.find(q).sort({ at: -1 }).limit(limit ?? 50).lean();
    return text({
      contact: { id: c._id.toString(), address: c.address, displayName: c.displayName ?? null },
      signals: rows.map((s) => ({ id: s._id.toString(), type: s.type, at: s.at.toISOString(), verdict: s.integrity.verdict, source: s.source, emailId: s.emailId?.toString() ?? null, documentId: s.documentId?.toString() ?? null, payload: s.payload ?? {} })),
    });
  });

  server.registerTool('queue', {
    title: 'Follow-through queue',
    description: 'Who needs follow-through and why. Each item is a rule over what happened (unopened, opened with no reply, read the document, a promise due either way, back after a quiet spell), not a score.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const items = await buildQueue(ownerId);
    return text({ items: items.map((i) => ({ rule: i.rule, reason: i.reason, contact: { id: i.contact._id, address: i.contact.address, displayName: i.contact.displayName ?? null }, email: i.email ? { id: i.email._id, subject: i.email.subject, sentAt: i.email.createdAt } : null, memoryId: i.memoryId ?? null, at: i.at })) });
  });

  server.registerTool('search_commitments', {
    title: 'Search commitments',
    description: 'Open commitments in either direction: what the owner promised contacts, or what contacts promised the owner.',
    inputSchema: {
      direction: z.enum(['sender', 'contact']).optional().describe('"sender" = the owner promised; "contact" = the contact promised. Default both'),
      due_before: z.string().optional().describe('ISO date; only commitments due before this'),
      email: z.string().optional().describe('Limit to one contact'),
      include_fulfilled: z.boolean().optional().describe('Default false'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ direction, due_before, email, include_fulfilled }) => {
    const q: Record<string, unknown> = { ownerId, kind: 'commitment', status: 'active' };
    if (direction) q['structured.by'] = direction;
    if (due_before) q.expiresAt = { $lte: new Date(due_before) };
    if (!include_fulfilled) q['structured.fulfilledByEmailId'] = { $exists: false };
    if (email) {
      const c = await findContact(ownerId, email);
      if (!c) return notFound(email);
      q.subjectId = c._id;
    }
    const items = await Memory.find(q).sort({ expiresAt: 1, createdAt: -1 }).limit(100).lean();
    const contacts = await Contact.find({ _id: { $in: items.map((m) => m.subjectId).filter(Boolean) } }).select('address displayName').lean();
    const byId = new Map(contacts.map((c) => [c._id.toString(), c]));
    return text({
      commitments: items.map((m) => {
        const c = m.subjectId ? byId.get(m.subjectId.toString()) : undefined;
        return { ...memoryView(m as Parameters<typeof memoryView>[0]), by: (m.structured as { by?: string } | undefined)?.by ?? null, contact: c ? { id: c._id.toString(), address: c.address, displayName: c.displayName ?? null } : null };
      }),
    });
  });

  return server;
}
