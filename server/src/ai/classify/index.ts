import mongoose from 'mongoose';
import { InboundMessage, IInboundMessage } from '../../models/InboundMessage';
import { ICategory, CategoryPolicy } from '../../models/Category';
import { ensureContact, recordSignal } from '../../services/signalService';
import { enqueueProcessMessage } from '../../queues/aiQueue';
import { loadCategories, toDef, deleteCategory } from './categories';
import { preClassify, isAutoReply } from './headers';
import { classifyWithBestBackend } from './chooser';
import { processInboundMessage } from './process';
import { ClassifiableMessage, ClassificationResult, FALLBACK_KEY, REPLY_KEY } from './types';

// The classification pipeline (doc/plan Phase 4): header rules first, then
// the cheapest backend the owner's keys can serve, then the per-category
// policy decides whether the expensive step runs. The reply signal is
// recorded here, at classification time, because it is deterministic: a
// user who keeps replies on "ask" still gets queue resolution and the brief.

export const CLASSIFY_BATCH_MAX = Number(process.env.AI_CLASSIFY_BATCH_MAX || 50);

export function toClassifiable(m: IInboundMessage): ClassifiableMessage {
  return {
    id: m._id.toString(),
    subject: m.subject,
    text: m.textExcerpt,
    from: m.from.address,
    matchedTracked: !!m.matchedEmailId,
    headers: {
      listUnsubscribe: m.headers.listUnsubscribe,
      listId: m.headers.listId,
      precedence: m.headers.precedence,
      autoSubmitted: m.headers.autoSubmitted,
      hasCalendarPart: m.headers.hasCalendarPart,
      inReplyTo: m.headers.inReplyTo,
      references: m.headers.references,
      fromAddress: m.from.address,
    },
  };
}

export interface ClassifyRunSummary {
  considered: number;
  classified: number;
  byBackend: Record<string, number>;
  awaiting: number;
  auto: number;
  skipped: number;
  unclassified: number;
  replies: number;
  reasons: string[]; // why cheaper backends were passed over, or why nothing ran
}

export interface ClassifyOptions {
  ids?: string[];      // default: every unclassified message of the owner, oldest first
  force?: boolean;     // re-classify even if already classified (human labels are still kept)
  limit?: number;
}

export async function classifyInboundMessages(ownerId: string | mongoose.Types.ObjectId, opts: ClassifyOptions = {}): Promise<ClassifyRunSummary> {
  const cats = await loadCategories(ownerId);
  const byKey = new Map(cats.map((c) => [c.key, c]));
  const defs = cats.map(toDef);

  const q: Record<string, unknown> = { ownerId };
  if (opts.ids?.length) q._id = { $in: opts.ids.map((id) => new mongoose.Types.ObjectId(id)) };
  else q['triage.status'] = 'unclassified';
  const messages = await InboundMessage.find(q).sort({ internalDate: 1 }).limit(Math.min(opts.limit ?? CLASSIFY_BATCH_MAX, CLASSIFY_BATCH_MAX));

  const summary: ClassifyRunSummary = { considered: messages.length, classified: 0, byBackend: {}, awaiting: 0, auto: 0, skipped: 0, unclassified: 0, replies: 0, reasons: [] };
  const todo = messages.filter((m) => {
    if (m.classification?.backend === 'human') return false;           // a person's word is final
    if (!opts.force && m.triage.status !== 'unclassified') return false;
    return true;
  });

  const results = new Map<string, ClassificationResult>();
  const rest: ClassifiableMessage[] = [];
  for (const m of todo) {
    const cm = toClassifiable(m);
    const pre = preClassify(cm);
    if (pre && byKey.has(pre.categoryKey)) results.set(cm.id, pre);
    else rest.push(cm);
  }
  if (rest.length) {
    const out = await classifyWithBestBackend(ownerId.toString(), defs, rest);
    summary.reasons = out.reasons;
    for (const r of out.results) results.set(r.id, r);
  }

  for (const m of todo) {
    const r = results.get(m._id.toString());
    if (!r) {
      summary.unclassified += 1;
      m.triage.error = summary.reasons.length ? `no classifier available: ${summary.reasons.join('; ')}` : 'no classifier available';
      await m.save();
      continue;
    }
    const cat = byKey.get(r.categoryKey) ?? byKey.get(FALLBACK_KEY);
    m.classification = {
      categoryKey: cat?.key ?? r.categoryKey,
      categoryId: cat?._id,
      confidence: r.confidence,
      backend: r.backend,
      modelRef: r.modelRef,
      runId: r.runId ? new mongoose.Types.ObjectId(r.runId) : undefined,
      scores: r.scores,
      reason: r.reason,
      at: new Date(),
    };
    m.triage.error = undefined;
    summary.classified += 1;
    summary.byBackend[r.backend] = (summary.byBackend[r.backend] ?? 0) + 1;
    const decision = await applyPolicy(m, cat);
    if (decision !== 'unchanged') summary[decision] += 1;
    if (m.classification.categoryKey === REPLY_KEY && m.contactId && !m.classification.reason?.startsWith('auto-reply')) summary.replies += 1;
  }
  return summary;
}

// Applies the category's policy to a classified message and, for a reply
// in a tracked thread, records the reply signal. Returns what happened. A
// message whose expensive step already ran is never re-run or demoted.
export async function applyPolicy(m: IInboundMessage, cat: Pick<ICategory, 'key' | 'policy'> | undefined): Promise<'auto' | 'awaiting' | 'skipped' | 'unchanged'> {
  const policy: CategoryPolicy = cat?.policy ?? 'ask';
  const isReply = m.classification?.categoryKey === REPLY_KEY && !!m.matchedEmailId;

  if (isReply) {
    if (isAutoReply(m.headers, m.subject)) {
      // An out-of-office is not a reply (ADR-10): no signal, no memory step.
      m.classification!.reason = 'auto-reply: no reply signal recorded';
      m.triage.status = 'skipped';
      m.triage.policyAtDecision = policy;
      await m.save();
      return 'skipped';
    }
    await recordReplySignal(m);
  }

  if (m.triage.status === 'processed') {
    await m.save();
    return 'unchanged';
  }

  m.triage.policyAtDecision = policy;
  if (policy === 'never') {
    m.triage.status = 'skipped';
    await m.save();
    return 'skipped';
  }
  if (policy === 'ask') {
    m.triage.status = 'awaiting_approval';
    await m.save();
    return 'awaiting';
  }
  m.triage.status = 'classified';
  await m.save();
  const queued = await enqueueProcessMessage(m._id.toString(), 'auto');
  if (!queued) await processInboundMessage(m._id.toString(), 'auto').catch(() => { /* recorded on the message */ });
  return 'auto';
}

export async function recordReplySignal(m: IInboundMessage): Promise<boolean> {
  if (!m.matchedEmailId) return false;
  if (!m.contactId) {
    const contact = await ensureContact(m.ownerId, m.from.address, { displayName: m.from.name });
    m.contactId = contact._id;
    await m.save();
  }
  const { isNew } = await recordSignal({
    ownerId: m.ownerId,
    contactId: m.contactId!,
    type: 'reply',
    at: m.internalDate,
    emailId: m.matchedEmailId,
    source: 'gmail',
    verdict: 'human',
    dedupeKey: `reply:${m.ownerId}:${m.gmailMessageId}`,
    payload: { gmailMessageId: m.gmailMessageId, matchedBy: m.matchedBy, subject: m.subject },
  });
  return isNew;
}

// Deleting a custom category moves its messages to the fallback. Lives here
// because categories.ts must not know about InboundMessage.
export async function deleteCategoryAndReassign(ownerId: string | mongoose.Types.ObjectId, key: string): Promise<'deleted' | 'builtin' | 'missing'> {
  const outcome = await deleteCategory(ownerId, key);
  if (outcome !== 'deleted') return outcome;
  await InboundMessage.updateMany(
    { ownerId, 'classification.categoryKey': key },
    { $set: { 'classification.categoryKey': FALLBACK_KEY, 'classification.reason': `category "${key}" was deleted` }, $unset: { 'classification.categoryId': 1 } }
  );
  return outcome;
}
