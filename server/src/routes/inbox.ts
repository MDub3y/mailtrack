import { Router, Request, Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { protect, AuthRequest } from '../middleware/auth';
import { InboundMessage } from '../models/InboundMessage';
import { Category, CATEGORY_KEY_RE } from '../models/Category';
import { isAiEnabled } from '../ai/config';
import { NoProviderKeyError } from '../ai/providers';
import { BudgetExceededError, RunFailedError } from '../ai/runAgent';
import { inboxStatus, syncInbox, backfillInbox, setInboxInitial, revokeGmailReadGrant, setInboxSyncEnabled, parsePushNotification, userForPushAddress, pushConfigured } from '../services/inboxService';
import { enqueueInboxSyncNow, enqueueProcessMessage, enqueueClassify, scheduleInboxSync, unscheduleInboxSync } from '../queues/aiQueue';
import { loadCategories, createCategory, updateCategory, addExample } from '../ai/classify/categories';
import { classifyInboundMessages, deleteCategoryAndReassign, CLASSIFY_BATCH_MAX } from '../ai/classify';
import { processInboundMessage } from '../ai/classify/process';
import { correctCategory } from '../ai/classify/corrections';

// The Triage page's API (Phase 4). Everything is scoped to the owner; the
// model only runs where a policy or an explicit click allows it.

// Pub/Sub push endpoint (public; the shared token in the query is the
// check). Acknowledges everything with 204 so Pub/Sub stops retrying, and
// only ever triggers the ordinary sync for the address named.
export const inboxPushRouter = Router();
inboxPushRouter.post('/push', async (req: Request, res: Response): Promise<void> => {
  if (!pushConfigured() || req.query.token !== process.env.GMAIL_PUSH_TOKEN) { res.status(404).end(); return; }
  const n = parsePushNotification(req.body);
  if (!n) { res.status(204).end(); return; }
  try {
    const userId = await userForPushAddress(n.emailAddress);
    if (userId && !(await enqueueInboxSyncNow(userId))) {
      const sync = await syncInbox(userId, { trigger: 'user' });
      for (let i = 0; i < sync.newIds.length; i += CLASSIFY_BATCH_MAX) await classifyInboundMessages(userId, { ids: sync.newIds.slice(i, i + CLASSIFY_BATCH_MAX) });
    }
  } catch (err) { console.error('[inbox push]', err); }
  res.status(204).end();
});

const router = Router();
router.use(protect);

function fail(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof NoProviderKeyError ? 400 : err instanceof BudgetExceededError ? 429 : err instanceof RunFailedError ? 502 : /not found/i.test(message) ? 404 : 400;
  res.status(status).json({ message, runId: err instanceof RunFailedError ? err.runId : undefined });
}

function invalid(res: Response, error: z.ZodError): void {
  res.status(400).json({ message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
}

const isId = (s: string) => mongoose.Types.ObjectId.isValid(s) && s.length === 24;

// ---------------------------------------------------------------- grant and sync

// GET /api/inbox/status
router.get('/status', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ aiEnabled: isAiEnabled(), ...(await inboxStatus(req.userId!)) });
  } catch (err) { fail(res, err); }
});

// POST /api/inbox/sync — "Sync now". Queued when the worker is on; inline
// (sync, then classification of what arrived) when it is off.
router.post('/sync', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (await enqueueInboxSyncNow(req.userId!)) { res.json({ queued: true }); return; }
    const sync = await syncInbox(req.userId!, { trigger: 'user' });
    const classify = { considered: 0, classified: 0, awaiting: 0, auto: 0, skipped: 0, unclassified: 0 };
    for (let i = 0; i < sync.newIds.length; i += CLASSIFY_BATCH_MAX) {
      const s = await classifyInboundMessages(req.userId!, { ids: sync.newIds.slice(i, i + CLASSIFY_BATCH_MAX) });
      for (const k of Object.keys(classify) as Array<keyof typeof classify>) classify[k] += s[k];
    }
    res.json({ queued: false, sync, classify });
  } catch (err) { fail(res, err); }
});

// PUT /api/inbox/initial { days?, max? } — the owner's pull window, set
// before consent or any time after. null resets a field to the server
// default. Values are clamped server-side; the effective window comes back.
const InitialBody = z.object({ days: z.number().nullable().optional(), max: z.number().nullable().optional() });
router.put('/initial', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = InitialBody.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error); return; }
  try {
    res.json(await setInboxInitial(req.userId!, parsed.data));
  } catch (err) { fail(res, err); }
});

// POST /api/inbox/backfill { days?, max? } — a manual bounded pull over a
// window the owner chooses; stored mail dedupes, so repeating or widening
// is safe. Classification of what arrived follows, inline when the queue
// worker is off, exactly like "Sync now".
const BackfillBody = z.object({ days: z.number().optional(), max: z.number().optional() });
router.post('/backfill', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = BackfillBody.safeParse(req.body ?? {});
  if (!parsed.success) { invalid(res, parsed.error); return; }
  try {
    const sync = await backfillInbox(req.userId!, parsed.data);
    const classify = { considered: 0, classified: 0, awaiting: 0, auto: 0, skipped: 0, unclassified: 0 };
    for (let i = 0; i < sync.newIds.length; i += CLASSIFY_BATCH_MAX) {
      const s = await classifyInboundMessages(req.userId!, { ids: sync.newIds.slice(i, i + CLASSIFY_BATCH_MAX) });
      for (const k of Object.keys(classify) as Array<keyof typeof classify>) classify[k] += s[k];
    }
    res.json({ queued: false, sync, classify });
  } catch (err) { fail(res, err); }
});

// PUT /api/inbox/sync { enabled } — pause or resume polling without revoking.
router.put('/sync', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error); return; }
  try {
    const ok = await setInboxSyncEnabled(req.userId!, parsed.data.enabled);
    if (!ok) { res.status(404).json({ message: 'Inbox reading is not connected' }); return; }
    if (parsed.data.enabled) await scheduleInboxSync(req.userId!); else await unscheduleInboxSync(req.userId!);
    res.json({ enabled: parsed.data.enabled });
  } catch (err) { fail(res, err); }
});

// DELETE /api/inbox/grant — revoke the read consent.
router.delete('/grant', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await unscheduleInboxSync(req.userId!);
    res.json(await revokeGmailReadGrant(req.userId!));
  } catch (err) { fail(res, err); }
});

// ---------------------------------------------------------------- messages

const LIST_FIELDS = 'gmailMessageId gmailThreadId internalDate from subject snippet matchedEmailId matchedBy contactId emailId classification.categoryKey classification.confidence classification.backend classification.reason classification.correctedFrom classification.at triage headers.hasAttachments headers.hasCalendarPart headers.listUnsubscribe';

const ListQuery = z.object({
  category: z.string().regex(CATEGORY_KEY_RE).optional(),
  status: z.enum(['unclassified', 'classified', 'awaiting_approval', 'processed', 'skipped', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
});

// GET /api/inbox/messages?category&status&limit&before
router.get('/messages', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) { invalid(res, parsed.error); return; }
  const { category, status, limit, before } = parsed.data;
  try {
    const q: Record<string, unknown> = { ownerId: req.userId };
    if (category) q['classification.categoryKey'] = category;
    if (status) q['triage.status'] = status;
    if (before) q.internalDate = { $lt: new Date(before) };
    const rows = await InboundMessage.find(q).sort({ internalDate: -1 }).limit(limit + 1).select(LIST_FIELDS).lean();
    const page = rows.slice(0, limit);
    res.json({ messages: page, nextBefore: rows.length > limit ? page[page.length - 1].internalDate : null });
  } catch (err) { fail(res, err); }
});

// GET /api/inbox/messages/:id
router.get('/messages/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!isId(req.params.id)) { res.status(404).json({ message: 'Message not found' }); return; }
  try {
    const m = await InboundMessage.findOne({ _id: req.params.id, ownerId: req.userId }).lean();
    if (!m) { res.status(404).json({ message: 'Message not found' }); return; }
    res.json(m);
  } catch (err) { fail(res, err); }
});

// POST /api/inbox/messages/:id/category { categoryKey } — a human correction.
router.post('/messages/:id/category', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = z.object({ categoryKey: z.string().regex(CATEGORY_KEY_RE) }).safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error); return; }
  if (!isId(req.params.id)) { res.status(404).json({ message: 'Message not found' }); return; }
  try {
    const m = await correctCategory(req.userId!, req.userId!, req.params.id, parsed.data.categoryKey);
    if (!m) { res.status(404).json({ message: 'Message not found' }); return; }
    res.json(m);
  } catch (err) { fail(res, err); }
});

// POST /api/inbox/messages/:id/process — run the expensive step now.
router.post('/messages/:id/process', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!isId(req.params.id)) { res.status(404).json({ message: 'Message not found' }); return; }
  try {
    const m = await InboundMessage.findOne({ _id: req.params.id, ownerId: req.userId }).select('_id triage');
    if (!m) { res.status(404).json({ message: 'Message not found' }); return; }
    const trigger = m.triage.status === 'failed' ? 'retry' : 'user';
    if (await enqueueProcessMessage(m._id.toString(), trigger)) { res.json({ queued: true }); return; }
    res.json({ queued: false, ...(await processInboundMessage(m._id.toString(), trigger)) });
  } catch (err) { fail(res, err); }
});

// POST /api/inbox/messages/:id/skip — leave it out of the expensive step.
router.post('/messages/:id/skip', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!isId(req.params.id)) { res.status(404).json({ message: 'Message not found' }); return; }
  try {
    const m = await InboundMessage.findOne({ _id: req.params.id, ownerId: req.userId });
    if (!m) { res.status(404).json({ message: 'Message not found' }); return; }
    if (m.triage.status === 'processed') { res.status(409).json({ message: 'Already processed' }); return; }
    m.triage.status = 'skipped';
    await m.save();
    res.json({ status: m.triage.status });
  } catch (err) { fail(res, err); }
});

// POST /api/inbox/reclassify { categoryKey?, status?, sinceDays? } — bounded.
const Reclassify = z.object({
  categoryKey: z.string().regex(CATEGORY_KEY_RE).optional(),
  status: z.enum(['unclassified', 'classified', 'awaiting_approval', 'skipped', 'failed']).optional(),
  sinceDays: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});
router.post('/reclassify', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = Reclassify.safeParse(req.body ?? {});
  if (!parsed.success) { invalid(res, parsed.error); return; }
  const { categoryKey, status, sinceDays, limit } = parsed.data;
  try {
    const q: Record<string, unknown> = { ownerId: req.userId, internalDate: { $gte: new Date(Date.now() - sinceDays * 86_400_000) }, 'classification.backend': { $ne: 'human' } };
    if (categoryKey) q['classification.categoryKey'] = categoryKey;
    if (status) q['triage.status'] = status;
    const ids = (await InboundMessage.find(q).sort({ internalDate: -1 }).limit(limit).select('_id').lean()).map((m) => m._id.toString());
    let queued = 0;
    const summary = { considered: 0, classified: 0, awaiting: 0, auto: 0, skipped: 0, unclassified: 0 };
    for (let i = 0; i < ids.length; i += CLASSIFY_BATCH_MAX) {
      const chunk = ids.slice(i, i + CLASSIFY_BATCH_MAX);
      if (await enqueueClassify(req.userId!, chunk)) { queued += chunk.length; continue; }
      const s = await classifyInboundMessages(req.userId!, { ids: chunk, force: true });
      for (const k of Object.keys(summary) as Array<keyof typeof summary>) summary[k] += s[k];
    }
    res.json({ selected: ids.length, queued, ...(queued ? {} : summary) });
  } catch (err) { fail(res, err); }
});

// ---------------------------------------------------------------- categories

// GET /api/inbox/categories — with message counts.
router.get('/categories', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cats = await loadCategories(req.userId!);
    const counts = await InboundMessage.aggregate<{ _id: string; n: number; awaiting: number }>([
      { $match: { ownerId: new mongoose.Types.ObjectId(req.userId!), 'classification.categoryKey': { $exists: true } } },
      { $group: { _id: '$classification.categoryKey', n: { $sum: 1 }, awaiting: { $sum: { $cond: [{ $eq: ['$triage.status', 'awaiting_approval'] }, 1, 0] } } } },
    ]);
    const byKey = new Map(counts.map((c) => [c._id, c]));
    res.json(cats.map((c) => ({
      key: c.key, name: c.name, description: c.description, policy: c.policy, builtin: c.builtin, order: c.order,
      examples: c.examples.map((e) => ({ text: e.text, source: e.source, addedAt: e.addedAt })),
      counts: { total: byKey.get(c.key)?.n ?? 0, awaiting: byKey.get(c.key)?.awaiting ?? 0 },
    })));
  } catch (err) { fail(res, err); }
});

const CategoryBody = z.object({
  key: z.string().regex(CATEGORY_KEY_RE).optional(),
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(400),
  examples: z.array(z.string().max(600)).max(20).optional(),
  policy: z.enum(['never', 'ask', 'auto']).optional(),
});

// POST /api/inbox/categories
router.post('/categories', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = CategoryBody.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error); return; }
  try {
    const c = await createCategory(req.userId!, parsed.data);
    res.status(201).json(c);
  } catch (err) { fail(res, err); }
});

// PUT /api/inbox/categories/:key
router.put('/categories/:key', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = CategoryBody.partial().safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error); return; }
  try {
    const c = await updateCategory(req.userId!, req.params.key, parsed.data);
    if (!c) { res.status(404).json({ message: 'Category not found' }); return; }
    res.json(c);
  } catch (err) { fail(res, err); }
});

// DELETE /api/inbox/categories/:key — customs only; messages move to the fallback.
router.delete('/categories/:key', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const outcome = await deleteCategoryAndReassign(req.userId!, req.params.key);
    if (outcome === 'missing') { res.status(404).json({ message: 'Category not found' }); return; }
    if (outcome === 'builtin') { res.status(400).json({ message: 'Built-in categories cannot be deleted; edit them instead' }); return; }
    res.json({ deleted: true });
  } catch (err) { fail(res, err); }
});

// POST /api/inbox/categories/:key/examples { text }
router.post('/categories/:key/examples', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = z.object({ text: z.string().min(3).max(600) }).safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error); return; }
  try {
    const c = await addExample(req.userId!, req.params.key, { text: parsed.data.text, source: 'user' });
    if (!c) { res.status(404).json({ message: 'Category not found' }); return; }
    res.json(c);
  } catch (err) { fail(res, err); }
});

// DELETE /api/inbox/categories/:key/examples/:index
router.delete('/categories/:key/examples/:index', async (req: AuthRequest, res: Response): Promise<void> => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) { res.status(400).json({ message: 'index must be a non-negative integer' }); return; }
  try {
    const c = await Category.findOne({ ownerId: req.userId, key: req.params.key });
    if (!c) { res.status(404).json({ message: 'Category not found' }); return; }
    if (index >= c.examples.length) { res.status(404).json({ message: 'Example not found' }); return; }
    c.examples.splice(index, 1);
    c.updatedAt = new Date();
    await c.save();
    res.json(c);
  } catch (err) { fail(res, err); }
});

export default router;
