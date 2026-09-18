import mongoose from 'mongoose';
import { Memory, IMemory, MemoryKind } from '../../models/Memory';
import { IProposal } from '../../models/Proposal';
import { submitProposal, registerApplier, acceptByPolicy } from '../corrections';

// The only place that inserts or changes memory status
// (doc/02-ai-architecture.md §1.5). Every agent-extracted item is a
// Proposal; this module decides whether it goes active now (the sender's
// own words, a verified quote, confidence ≥ AUTO_ACCEPT_CONFIDENCE) or waits.

export const AUTO_ACCEPT_CONFIDENCE = 0.7;

export interface ExtractedItem {
  kind: Extract<MemoryKind, 'fact' | 'commitment' | 'preference'>;
  content: string;
  structured?: Record<string, unknown>;
  quote: string;
  confidence: number;
  supersedes?: string;
}

export interface ApplyExtractionInput {
  ownerId: mongoose.Types.ObjectId;
  contactId: mongoose.Types.ObjectId;
  emailId: mongoose.Types.ObjectId;
  runId: mongoose.Types.ObjectId;
  items: ExtractedItem[];
  // Text the sender wrote themselves is trusted; a reply is not (ADR-9).
  trusted: boolean;
}

export interface ApplyExtractionResult {
  activated: IMemory[];
  proposed: IMemory[];
  confirmed: IMemory[];
  superseded: IMemory[];
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function dueAtOf(item: ExtractedItem): Date | undefined {
  const due = item.structured?.dueAt;
  if (typeof due !== 'string') return undefined;
  const d = new Date(due);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function applyExtraction(input: ApplyExtractionInput): Promise<ApplyExtractionResult> {
  const result: ApplyExtractionResult = { activated: [], proposed: [], confirmed: [], superseded: [] };
  const active = await Memory.find({ ownerId: input.ownerId, subjectId: input.contactId, status: 'active' });

  for (const item of input.items) {
    // Confirm on re-support: an item we already hold gets its
    // lastConfirmedAt bumped instead of a duplicate.
    const same = active.find((m) => m.kind === item.kind && normalise(m.content) === normalise(item.content));
    if (same) {
      same.lastConfirmedAt = new Date();
      same.evidence.push({ emailId: input.emailId, quote: item.quote });
      await same.save();
      result.confirmed.push(same);
      continue;
    }

    const memory = await Memory.create({
      ownerId: input.ownerId,
      scope: 'contact',
      subjectId: input.contactId,
      kind: item.kind,
      content: item.content,
      structured: item.structured,
      evidence: [{ emailId: input.emailId, quote: item.quote }],
      confidence: input.trusted ? item.confidence : Math.min(item.confidence, 0.6),
      source: 'agent',
      status: 'proposed',
      createdByRunId: input.runId,
      expiresAt: item.kind === 'commitment' ? dueAtOf(item) : undefined,
    });

    const proposal = await submitProposal({
      ownerId: input.ownerId,
      kind: 'memory_item',
      payload: { memoryId: memory._id.toString(), kind: item.kind, content: item.content, structured: item.structured, supersedes: item.supersedes },
      evidence: [{ emailId: input.emailId.toString(), quote: item.quote }],
      confidence: memory.confidence,
      runId: input.runId,
    });
    memory.proposalId = proposal._id;
    await memory.save();

    if (proposal.status === 'auto_accepted') {
      // Earned trust already applied it (registerApplier below).
      result.activated.push((await Memory.findById(memory._id))!);
      continue;
    }

    // Domain policy: the sender's own words, a quote that was verified
    // against the email, and confidence above the line → active now.
    if (input.trusted && memory.confidence >= AUTO_ACCEPT_CONFIDENCE) {
      await acceptByPolicy(proposal._id, `memory policy: sender's own words, verified quote, confidence ${memory.confidence.toFixed(2)} ≥ ${AUTO_ACCEPT_CONFIDENCE}`);
      const fresh = (await Memory.findById(memory._id))!;
      result.activated.push(fresh);
      const sup = await supersedeIfNamed(fresh, item.supersedes, active);
      if (sup) result.superseded.push(sup);
    } else {
      result.proposed.push(memory);
    }
  }

  return result;
}

// Supersede rather than overwrite: history is kept. A user-sourced item is
// never superseded by an agent item (user edits win).
async function supersedeIfNamed(newItem: IMemory, supersedes: string | undefined, active: IMemory[]): Promise<IMemory | null> {
  if (!supersedes) return null;
  const target = active.find((m) => m.kind === newItem.kind && normalise(m.content) === normalise(supersedes) && m.source !== 'user');
  if (!target || target._id.equals(newItem._id)) return null;
  target.status = 'superseded';
  target.supersededBy = newItem._id;
  await target.save();
  return target;
}

// Human-added items are active immediately with full confidence.
export async function addUserMemory(input: {
  ownerId: mongoose.Types.ObjectId | string;
  contactId: mongoose.Types.ObjectId | string;
  kind: Extract<MemoryKind, 'fact' | 'commitment' | 'preference'>;
  content: string;
  structured?: Record<string, unknown>;
}): Promise<IMemory> {
  return Memory.create({
    ownerId: input.ownerId,
    scope: 'contact',
    subjectId: input.contactId,
    kind: input.kind,
    content: input.content,
    structured: input.structured,
    evidence: [],
    confidence: 1,
    source: 'user',
    status: 'active',
    lastConfirmedAt: new Date(),
    expiresAt: input.kind === 'commitment' && typeof input.structured?.dueAt === 'string' ? new Date(input.structured.dueAt) : undefined,
  });
}

// Direct human decision on an item (the contact page): routes through the
// proposal when one exists so the label is written; otherwise sets status.
export async function decideMemory(memoryId: string, userId: string, decision: 'accept' | 'reject' | 'edit', edited?: { content?: string; structured?: Record<string, unknown> }): Promise<IMemory | null> {
  const memory = await Memory.findOne({ _id: memoryId, ownerId: userId });
  if (!memory) return null;
  if (memory.proposalId) {
    const { decideProposal } = await import('../corrections');
    const payload = edited ? { memoryId: memory._id.toString(), kind: memory.kind, content: edited.content ?? memory.content, structured: edited.structured ?? memory.structured } : undefined;
    await decideProposal(memory.proposalId.toString(), userId, decision, { edited: payload });
    return Memory.findById(memory._id);
  }
  if (decision === 'reject') memory.status = 'rejected';
  else {
    memory.status = 'active';
    memory.lastConfirmedAt = new Date();
    if (edited?.content) memory.content = edited.content;
    if (edited?.structured) memory.structured = edited.structured;
  }
  await memory.save();
  return memory;
}

// Applier: when a memory_item proposal is decided, the item follows.
registerApplier('memory_item', async (proposal: IProposal, outcome) => {
  const payload = proposal.payload as { memoryId?: string; content?: string; structured?: Record<string, unknown>; supersedes?: string };
  if (!payload.memoryId) return;
  const memory = await Memory.findById(payload.memoryId);
  if (!memory) return;
  if (outcome === 'rejected') {
    memory.status = 'rejected';
  } else {
    memory.status = 'active';
    memory.lastConfirmedAt = new Date();
    if (payload.content && payload.content !== memory.content) memory.content = payload.content;
    if (payload.structured) memory.structured = payload.structured;
  }
  await memory.save();
  if (outcome === 'accepted' && payload.supersedes) {
    const active = await Memory.find({ ownerId: memory.ownerId, subjectId: memory.subjectId, status: 'active' });
    await supersedeIfNamed(memory, payload.supersedes, active);
  }
});
