import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { fakeProvider, bagOfWords, ScriptedTurn } from './helpers/fakeProvider';
import { __setProviderForTests } from '../ai/providers';
import { User } from '../models/User';
import { Email } from '../models/Email';
import { Contact } from '../models/Contact';
import { Signal } from '../models/Signal';
import { Label } from '../models/Label';
import { Proposal } from '../models/Proposal';
import { Category } from '../models/Category';
import { InboundMessage, IInboundMessage } from '../models/InboundMessage';
import { ensureDefaultCategories, updateCategory, createCategory } from '../ai/classify/categories';
import { classifyInboundMessages, deleteCategoryAndReassign } from '../ai/classify';
import { processInboundMessage, inboundTrackingToken } from '../ai/classify/process';
import { correctCategory } from '../ai/classify/corrections';

// The pipeline end to end on stored messages: header stage, cheap backend,
// per-category policy, the deterministic reply signal (never for an
// out-of-office), the promotion to an inbound Email with untrusted
// extraction, corrections as labels plus examples, and idempotency of all
// of it. Provider is a fake; the queue is off so 'auto' runs inline.

const owner = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const TOKEN = '4a7c1b1e-9f2d-4c33-8a1e-0b6d2f9c1a55';

before(async () => {
  process.env.AI_ENABLED = 'true';
  process.env.AI_ALLOW_SERVER_KEYS = 'false';
  await connectTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  __setProviderForTests(null);
  await User.create({ _id: owner, email: 'me@example.com', emailAddress: 'me@example.com', password: 'x', name: 'Me', gmailAddress: 'me@gmail.com' });
  await ensureDefaultCategories(owner);
});
after(async () => { __setProviderForTests(null); await disconnectTestDb(); });

const extractionTurn = (quote: string): ScriptedTurn => ({
  json: { items: [{ kind: 'commitment', content: 'Will send headcount by Friday', quote, confidence: 0.8 }], summary: 'They will confirm headcount by Friday.' },
});

async function seedTracked(): Promise<{ email: mongoose.Types.ObjectId; contact: mongoose.Types.ObjectId }> {
  const contact = await Contact.create({ ownerId: owner, address: 'priya@example.com', domain: 'example.com', displayName: 'Priya' });
  const email = await Email.create({ senderId: owner, contactId: contact._id, from: 'me@gmail.com', to: 'priya@example.com', subject: 'Proposal', htmlBody: '<p>x</p>', textBody: 'x', trackingToken: TOKEN, status: 'delivered', direction: 'outbound', gmailThreadId: 'thread-1', rfcMessageId: `<mt-${TOKEN}@gmail.com>` });
  return { email: email._id, contact: contact._id };
}

let seq = 0;
async function inbound(over: Partial<Omit<IInboundMessage, 'headers' | 'from'>> & { headers?: Partial<IInboundMessage['headers']>; from?: string; name?: string } = {}): Promise<IInboundMessage> {
  seq += 1;
  const { headers, from, name, ...rest } = over;
  return InboundMessage.create({
    ownerId: owner, gmailMessageId: `g${seq}`, gmailThreadId: `t${seq}`, internalDate: new Date(Date.now() - (100 - seq) * 60_000),
    from: { address: from ?? `sender${seq}@example.com`, name }, to: ['me@gmail.com'], subject: `Subject ${seq}`, snippet: '', textExcerpt: `Body ${seq}`, labelIds: ['INBOX'],
    headers: { references: [], listUnsubscribe: false, hasCalendarPart: false, hasAttachments: false, ...(headers ?? {}) },
    ...rest,
  });
}

test('header stage, cheap backend and policies: replies auto-process with a signal, OOO is skipped, ask waits, never skips', async () => {
  const { email: trackedId, contact: contactId } = await seedTracked();
  const fake = fakeProvider([extractionTurn('confirm headcount by Friday')], { name: 'openai', embed: (i) => i.map(bagOfWords) });
  __setProviderForTests(fake);
  await updateCategory(owner, 'personal_or_other', { policy: 'never' });

  const reply = await inbound({ from: 'priya@example.com', name: 'Priya', subject: 'Re: Proposal', textExcerpt: 'Thanks, I will confirm headcount by Friday.', gmailThreadId: 'thread-1', matchedEmailId: trackedId, matchedBy: 'thread', headers: { inReplyTo: `<mt-${TOKEN}@gmail.com>` } });
  const ooo = await inbound({ from: 'priya@example.com', subject: 'Automatic reply: Proposal', textExcerpt: 'I am out of the office.', gmailThreadId: 'thread-1', matchedEmailId: trackedId, matchedBy: 'thread', headers: { autoSubmitted: 'auto-replied' } });
  const news = await inbound({ subject: 'Weekly digest', textExcerpt: 'Top stories', headers: { listUnsubscribe: true } });
  const receipt = await inbound({ from: 'noreply@shop.example', subject: 'Your receipt', textExcerpt: 'Receipt for order #12, invoice attached' });
  const lunch = await inbound({ subject: 'Lunch', textExcerpt: 'hello, lunch tomorrow?' });

  const s = await classifyInboundMessages(owner);
  assert.equal(s.considered, 5);
  assert.equal(s.classified, 5);
  assert.deepEqual(s.byBackend, { headers: 3, embeddings: 2 });
  assert.deepEqual([s.auto, s.awaiting, s.skipped, s.unclassified, s.replies], [1, 2, 2, 0, 1]);

  const get = (id: mongoose.Types.ObjectId) => InboundMessage.findById(id).then((m) => m!);
  const r = await get(reply._id);
  assert.equal(r.classification?.categoryKey, 'reply_to_tracked');
  assert.equal(r.classification?.backend, 'headers');
  assert.equal(r.classification?.confidence, 1);
  assert.equal(r.triage.status, 'processed', r.triage.error);
  assert.equal(r.triage.policyAtDecision, 'auto');
  assert.ok(r.triage.processRunId);
  assert.equal(r.contactId?.toString(), contactId.toString());

  // The promoted inbound Email: in the contact's thread, never in Sent.
  const promoted = await Email.findById(r.emailId);
  assert.ok(promoted);
  assert.equal(promoted.direction, 'inbound');
  assert.equal(promoted.status, 'received');
  assert.equal(promoted.from, 'priya@example.com');
  assert.equal(promoted.to, 'me@gmail.com');
  assert.equal(promoted.contactId?.toString(), contactId.toString());
  assert.equal(promoted.inReplyToEmailId?.toString(), trackedId.toString());
  assert.equal(promoted.inboundMessageId?.toString(), r._id.toString());
  assert.equal(promoted.trackingToken, inboundTrackingToken(owner, r.gmailMessageId));
  assert.equal(promoted.gmailThreadId, 'thread-1');
  assert.equal(promoted.summary, 'They will confirm headcount by Friday.');
  assert.equal(promoted.createdAt.getTime(), r.internalDate.getTime());

  // Extraction treated the reply as untrusted: proposed, not active.
  const extractReq = fake.requests[0];
  const userText = extractReq.messages.filter((m) => m.role === 'user').map((m) => (m as { text: string }).text).join('\n');
  assert.match(userText, /<untrusted source="reply">/);
  assert.equal(await Proposal.countDocuments({ ownerId: owner, kind: 'memory_item', status: 'pending' }), 1);

  // One reply signal, from gmail, on the tracked email; none for the OOO.
  const signals = await Signal.find({ ownerId: owner, type: 'reply' }).lean();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'gmail');
  assert.equal(signals[0].dedupeKey, `reply:${owner}:${r.gmailMessageId}`);
  assert.equal(signals[0].emailId?.toString(), trackedId.toString());
  assert.equal(signals[0].at.getTime(), r.internalDate.getTime());
  assert.equal((await Contact.findById(contactId))!.stats.replied, 1);

  const o = await get(ooo._id);
  assert.equal(o.classification?.categoryKey, 'reply_to_tracked');
  assert.equal(o.triage.status, 'skipped');
  assert.match(o.classification!.reason!, /auto-reply/);
  assert.equal(o.emailId, undefined);

  const n = await get(news._id);
  assert.equal(n.classification?.categoryKey, 'newsletter_or_bulk');
  assert.equal(n.classification?.backend, 'headers');
  assert.equal(n.triage.status, 'awaiting_approval');
  assert.equal(n.triage.policyAtDecision, 'ask');

  const t = await get(receipt._id);
  assert.equal(t.classification?.categoryKey, 'transactional');
  assert.equal(t.classification?.backend, 'embeddings');
  assert.ok(t.classification?.runId && t.classification.scores);
  assert.equal(t.triage.status, 'awaiting_approval');

  const l = await get(lunch._id);
  assert.equal(l.classification?.categoryKey, 'personal_or_other');
  assert.equal(l.triage.status, 'skipped');
  assert.equal(l.triage.policyAtDecision, 'never');

  // Running again is a no-op: nothing unclassified, no second signal, no second Email.
  const again = await classifyInboundMessages(owner);
  assert.equal(again.considered, 0);
  assert.equal(await Signal.countDocuments({ ownerId: owner, type: 'reply' }), 1);
  assert.equal(await Email.countDocuments({ senderId: owner, direction: 'inbound' }), 1);
  assert.equal(fake.requests.length, 1);

  // Force re-classifies but never re-processes or re-signals.
  const forced = await classifyInboundMessages(owner, { ids: [reply._id.toString(), receipt._id.toString()], force: true });
  assert.equal(forced.classified, 2);
  assert.equal(await Signal.countDocuments({ ownerId: owner, type: 'reply' }), 1);
  assert.equal(await Email.countDocuments({ senderId: owner, direction: 'inbound' }), 1);
  assert.equal((await get(reply._id)).triage.status, 'processed');
});

test('with no classifier available, header matches still classify and the rest stay unclassified with the reasons', async () => {
  const news = await inbound({ headers: { listId: '<list.example>' } });
  const plain = await inbound({ subject: 'Hi', textExcerpt: 'hello there' });
  const s = await classifyInboundMessages(owner);
  assert.deepEqual([s.classified, s.unclassified], [1, 1]);
  assert.equal(s.reasons.length, 2);
  assert.equal((await InboundMessage.findById(news._id))!.classification?.categoryKey, 'newsletter_or_bulk');
  const p = (await InboundMessage.findById(plain._id))!;
  assert.equal(p.classification, undefined);
  assert.equal(p.triage.status, 'unclassified');
  assert.match(p.triage.error!, /no classifier available: embeddings: no key .*; llm: no key/);

  // Once a key arrives it is picked up on the next run.
  __setProviderForTests(fakeProvider([], { name: 'openai', embed: (i) => i.map(bagOfWords) }));
  const s2 = await classifyInboundMessages(owner);
  assert.deepEqual([s2.considered, s2.classified], [1, 1]);
  assert.equal((await InboundMessage.findById(plain._id))!.triage.error, undefined);
});

test('correcting a category writes a label, adds a correction example, keeps the human verdict, and re-applies the policy', async () => {
  __setProviderForTests(fakeProvider([], { name: 'openai', embed: (i) => i.map(bagOfWords) }));
  await createCategory(owner, { name: 'Vendors', description: 'Mail from suppliers about orders.', policy: 'never' });
  const receipt = await inbound({ subject: 'Your receipt', textExcerpt: 'Receipt for order #12' });
  await classifyInboundMessages(owner);
  let m: IInboundMessage = (await InboundMessage.findById(receipt._id))!;
  assert.equal(m.classification?.categoryKey, 'transactional');
  const runId = m.classification!.runId!;

  m = (await correctCategory(owner, userId, receipt._id.toString(), 'vendors'))!;
  assert.equal(m.classification?.categoryKey, 'vendors');
  assert.equal(m.classification?.backend, 'human');
  assert.equal(m.classification?.confidence, 1);
  assert.equal(m.classification?.correctedFrom, 'transactional');
  assert.equal(m.classification?.correctedBy?.toString(), userId.toString());
  assert.equal(m.triage.status, 'skipped'); // vendors is 'never'
  assert.equal(m.triage.policyAtDecision, 'never');

  const labels = await Label.find({ ownerId: owner, runKind: 'classify' }).lean();
  assert.equal(labels.length, 1);
  assert.equal(labels[0].verdict, 'edited');
  assert.equal(labels[0].runId?.toString(), runId.toString());
  const before = labels[0].before as { categoryKey: string; backend: string; confidence: number };
  assert.deepEqual([before.categoryKey, before.backend], ['transactional', 'embeddings']);
  assert.equal(before.confidence, labels[0].confidence);
  assert.deepEqual(labels[0].after, { categoryKey: 'vendors' });
  assert.equal(labels[0].labeledBy?.toString(), userId.toString());

  const vendors = (await Category.findOne({ ownerId: owner, key: 'vendors' }))!;
  assert.equal(vendors.examples.length, 1);
  assert.equal(vendors.examples[0].source, 'correction');
  assert.equal(vendors.examples[0].inboundMessageId?.toString(), receipt._id.toString());
  assert.match(vendors.examples[0].text, /^Your receipt\nReceipt for order #12$/);

  // Confirming the same key is an 'accepted' label and no new example.
  await correctCategory(owner, userId, receipt._id.toString(), 'vendors');
  assert.equal(await Label.countDocuments({ ownerId: owner, runKind: 'classify', verdict: 'accepted' }), 1);
  assert.equal((await Category.findOne({ ownerId: owner, key: 'vendors' }))!.examples.length, 1);

  // A re-run never overwrites a human label, even when forced.
  await classifyInboundMessages(owner, { ids: [receipt._id.toString()], force: true });
  assert.equal((await InboundMessage.findById(receipt._id))!.classification?.backend, 'human');

  await assert.rejects(correctCategory(owner, userId, receipt._id.toString(), 'nope'), /unknown category/);
  assert.equal(await correctCategory(owner, userId, new mongoose.Types.ObjectId().toString(), 'vendors'), null);

  // Deleting the custom category sends its messages to the fallback.
  assert.equal(await deleteCategoryAndReassign(owner, 'vendors'), 'deleted');
  const moved = (await InboundMessage.findById(receipt._id))!;
  assert.equal(moved.classification?.categoryKey, 'personal_or_other');
  assert.equal(moved.classification?.categoryId, undefined);
  assert.equal(await deleteCategoryAndReassign(owner, 'transactional'), 'builtin');
});

test('processing on demand: idempotent promotion, failure is recorded and retryable, empty bodies still complete', async () => {
  const fake = fakeProvider([], { name: 'custom', throwOnCall: new Error('provider down') });
  __setProviderForTests(fake);
  const news = await inbound({ from: 'news@list.example', subject: 'Digest', textExcerpt: 'Top stories this week', headers: { listUnsubscribe: true } });
  await classifyInboundMessages(owner);
  assert.equal((await InboundMessage.findById(news._id))!.triage.status, 'awaiting_approval');

  const failed = await processInboundMessage(news._id.toString(), 'user');
  assert.equal(failed?.status, 'failed');
  assert.match(failed!.error!, /provider down/);
  let m = (await InboundMessage.findById(news._id))!;
  assert.equal(m.triage.status, 'failed');
  assert.match(m.triage.error!, /^user: provider down/);
  assert.ok(m.emailId); // the Email was promoted before extraction failed
  assert.equal(await Email.countDocuments({ senderId: owner, direction: 'inbound' }), 1);
  assert.equal(await Contact.countDocuments({ ownerId: owner, address: 'news@list.example' }), 1);

  __setProviderForTests(fakeProvider([extractionTurn('Top stories this week')], { name: 'custom' }));
  const ok = await processInboundMessage(news._id.toString(), 'retry');
  assert.equal(ok?.status, 'processed');
  assert.equal(ok?.emailId, m.emailId!.toString());
  assert.equal(ok?.extracted, 1);
  assert.equal(await Email.countDocuments({ senderId: owner, direction: 'inbound' }), 1);
  m = (await InboundMessage.findById(news._id))!;
  assert.equal(m.triage.status, 'processed');
  assert.equal(m.triage.error, undefined);

  assert.equal((await processInboundMessage(news._id.toString(), 'user'))?.status, 'already_processed');
  assert.equal(await processInboundMessage(new mongoose.Types.ObjectId().toString(), 'user'), null);

  // No text: promoted and marked processed with no run.
  const empty = await inbound({ textExcerpt: '' });
  const e = await processInboundMessage(empty._id.toString(), 'user');
  assert.equal(e?.status, 'processed');
  assert.equal(e?.runId, undefined);
});
