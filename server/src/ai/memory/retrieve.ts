import mongoose from 'mongoose';
import { Memory, IMemory, MemoryKind } from '../../models/Memory';

// Retrieval is a query, not a search (ADR-5): owner + contact + active,
// ordered by kind priority, confidence, recency, with per-kind caps.

const KIND_PRIORITY: MemoryKind[] = ['commitment', 'engagement', 'preference', 'fact', 'voice', 'fingerprint'];

export interface RetrieveOptions {
  perKind?: Partial<Record<MemoryKind, number>>;
  kinds?: MemoryKind[];
  includeProposed?: boolean;
}

const DEFAULT_PER_KIND: Record<MemoryKind, number> = {
  commitment: 8, engagement: 1, preference: 5, fact: 12, voice: 1, fingerprint: 0,
};

// Lean shape returned by retrieval (plain objects, not hydrated documents).
export type MemoryLean = Pick<IMemory, "kind" | "content" | "structured" | "expiresAt" | "confidence" | "status" | "source" | "evidence" | "lastConfirmedAt" | "createdAt"> & { _id: mongoose.Types.ObjectId; subjectId?: mongoose.Types.ObjectId; ownerId: mongoose.Types.ObjectId };

export async function activeMemory(
  ownerId: mongoose.Types.ObjectId | string,
  contactId: mongoose.Types.ObjectId | string,
  opts: RetrieveOptions = {}
): Promise<MemoryLean[]> {
  const kinds = opts.kinds ?? KIND_PRIORITY;
  const status = opts.includeProposed ? { $in: ['active', 'proposed'] } : 'active';
  const items = await Memory.find({ ownerId, subjectId: contactId, status, kind: { $in: kinds } })
    .sort({ confidence: -1, lastConfirmedAt: -1, createdAt: -1 })
    .lean();

  const caps = { ...DEFAULT_PER_KIND, ...opts.perKind };
  const out: MemoryLean[] = [];
  for (const kind of kinds) {
    const cap = caps[kind] ?? 0;
    out.push(...(items.filter((m) => m.kind === kind).slice(0, cap) as unknown as MemoryLean[]));
  }
  return out;
}

// Compact rendering for prompts: one line per item, id first so the model
// can cite it and the receipt can verify the citation.
export function renderMemoryLine(m: Pick<IMemory, '_id' | 'kind' | 'content' | 'structured' | 'expiresAt'>): string {
  const extra: string[] = [];
  const s = (m.structured ?? {}) as Record<string, unknown>;
  if (m.kind === 'commitment') {
    if (s.by) extra.push(`by ${s.by}`);
    if (m.expiresAt) extra.push(`due ${m.expiresAt.toISOString().slice(0, 10)}`);
    if (s.fulfilledByEmailId) extra.push('fulfilled');
  }
  return `[${m._id}] (${m.kind}${extra.length ? `, ${extra.join(', ')}` : ''}) ${m.content}`;
}
