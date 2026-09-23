import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { fakeGmail, FakeGmail } from './helpers/fakeGmail';
import { fakeProvider, bagOfWords } from './helpers/fakeProvider';
import { __setGmailClientFactoryForTests } from '../services/gmailClient';
import { __setProviderForTests } from '../ai/providers';
import { READ_SCOPE } from '../services/inboxService';
import { encryptSecret } from '../utils/secrets';
import app from '../app';
import { User } from '../models/User';
import { Email } from '../models/Email';
import { Contact } from '../models/Contact';
import { Label } from '../models/Label';
import { Signal } from '../models/Signal';
import { InboundMessage } from '../models/InboundMessage';

// The Triage page's API through the real Express app: sync then classify
// inline (queue off), list and filter, correct, process, skip, categories
// CRUD, reclassify, pause, revoke. Gmail and the model are fakes.

const owner = new mongoose.Types.ObjectId();
const stranger = new mongoose.Types.ObjectId();
const TOKEN = '4a7c1b1e-9f2d-4c33-8a1e-0b6d2f9c1a55';
let server: http.Server;
let base: string;
let gmail: FakeGmail;

function tokenFor(id: mongoose.Types.ObjectId): string {
  return jwt.sign({ userId: id.toString() }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, who: mongoose.Types.ObjectId | null, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokenFor(who)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.AI_KEY_ENCRYPTION_SECRET = process.env.AI_KEY_ENCRYPTION_SECRET || 'test-secret-for-tokens';
  process.env.AI_ENABLED = 'true';
  process.env.AI_ALLOW_SERVER_KEYS = 'false';
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
  await resetTestDb();
  gmail = fakeGmail('me@gmail.com');
  __setGmailClientFactoryForTests(() => gmail);
  __setProviderForTests(fakeProvider([], { name: 'openai', embed: (i) => i.map(bagOfWords) }));
  await User.create({ _id: owner, name: 'Me', email: 'me@example.com', emailAddress: 'me@example.com', password: 'x', gmailAddress: 'me@gmail.com' });
  await User.create({ _id: stranger, name: 'S', email: 's@example.com', emailAddress: 's@example.com', password: 'x' });
});
after(async () => {
  __setGmailClientFactoryForTests(null);
  __setProviderForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectTestDb();
});

async function grant(): Promise<void> {
  await User.updateOne({ _id: owner }, { $set: { gmailRead: { address: 'me@gmail.com', refreshToken: encryptSecret('r'), accessToken: encryptSecret('a'), tokenExpiry: new Date(Date.now() + 3_600_000), scope: READ_SCOPE, grantedAt: new Date(), syncEnabled: true, historyId: '1000', initialSyncDone: false } } });
}

async function seedMailbox(): Promise<{ trackedId: mongoose.Types.ObjectId }> {
  const contact = await Contact.create({ ownerId: owner, address: 'priya@example.com', domain: 'example.com', displayName: 'Priya' });
  const tracked = await Email.create({ senderId: owner, contactId: contact._id, from: 'me@gmail.com', to: 'priya@example.com', subject: 'Proposal', trackingToken: TOKEN, gmailThreadId: 'thread-1', direction: 'outbound', status: 'delivered' });
  gmail.add({ id: 'g-reply', threadId: 'thread-1', from: 'Priya <priya@example.com>', subject: 'Re: Proposal', text: 'Thanks, I will confirm headcount by Friday.', internalDate: Date.now() - 3_000 }, { history: false });
  gmail.add({ id: 'g-news', from: 'News <news@list.example>', subject: 'Weekly digest', text: 'Top stories', headers: { 'List-Unsubscribe': '<mailto:x>' }, internalDate: Date.now() - 2_000 }, { history: false });
  gmail.add({ id: 'g-receipt', from: 'noreply@shop.example', subject: 'Your receipt', text: 'Receipt for order #12, invoice attached', internalDate: Date.now() - 1_000 }, { history: false });
  return { trackedId: tracked._id };
}

test('every inbox route requires a token', async () => {
  for (const [method, path] of [['GET', '/api/inbox/status'], ['POST', '/api/inbox/sync'], ['GET', '/api/inbox/messages'], ['GET', '/api/inbox/categories'], ['POST', '/api/inbox/reclassify'], ['DELETE', '/api/inbox/grant']] as const) {
    assert.equal((await call(method, path, null, method === 'POST' ? {} : undefined)).status, 401, `${method} ${path}`);
  }
});

test('status, sync now (inline: fetch then classify), list with filters, detail scoped to the owner', async () => {
  let st = await call('GET', '/api/inbox/status', owner);
  assert.equal(st.status, 200);
  assert.equal(st.json.connected, false);
  assert.equal(st.json.aiEnabled, true);
  assert.equal((await call('POST', '/api/inbox/sync', owner)).json.sync.skipped, 'not_connected');

  await grant();
  const { trackedId } = await seedMailbox();
  // The reply auto-processes: one extraction turn for it.
  __setProviderForTests(fakeProvider([{ json: { items: [{ kind: 'commitment', content: 'Will confirm headcount by Friday', quote: 'confirm headcount by Friday', confidence: 0.8 }], summary: 'Will confirm headcount by Friday.' } }], { name: 'openai', embed: (i) => i.map(bagOfWords) }));

  const sync = await call('POST', '/api/inbox/sync', owner);
  assert.equal(sync.status, 200, JSON.stringify(sync.json));
  assert.equal(sync.json.queued, false);
  assert.equal(sync.json.sync.mode, 'initial');
  assert.equal(sync.json.sync.created, 3);
  assert.equal(sync.json.classify.classified, 3);
  assert.deepEqual([sync.json.classify.auto, sync.json.classify.awaiting], [1, 2]);

  st = await call('GET', '/api/inbox/status', owner);
  assert.equal(st.json.connected, true);
  assert.equal(st.json.address, 'me@gmail.com');
  assert.equal(st.json.initialSyncDone, true);
  assert.deepEqual(st.json.counts, { total: 3, unclassified: 0, awaiting: 2, processed: 1 });

  const list = await call('GET', '/api/inbox/messages', owner);
  assert.equal(list.status, 200);
  assert.equal(list.json.messages.length, 3);
  assert.equal(list.json.nextBefore, null);
  assert.deepEqual(list.json.messages.map((m: { gmailMessageId: string }) => m.gmailMessageId), ['g-receipt', 'g-news', 'g-reply']); // newest first
  const reply = list.json.messages[2];
  assert.equal(reply.classification.categoryKey, 'reply_to_tracked');
  assert.equal(reply.triage.status, 'processed');
  assert.equal(reply.matchedEmailId, trackedId.toString());
  assert.equal(reply.classification.scores, undefined); // list is slim
  assert.equal(reply.textExcerpt, undefined);

  const byCat = await call('GET', '/api/inbox/messages?category=transactional', owner);
  assert.equal(byCat.json.messages.length, 1);
  assert.equal(byCat.json.messages[0].classification.backend, 'embeddings');
  const byStatus = await call('GET', '/api/inbox/messages?status=awaiting_approval&limit=1', owner);
  assert.equal(byStatus.json.messages.length, 1);
  assert.ok(byStatus.json.nextBefore);
  const page2 = await call('GET', `/api/inbox/messages?status=awaiting_approval&limit=1&before=${encodeURIComponent(byStatus.json.nextBefore)}`, owner);
  assert.equal(page2.json.messages.length, 1);
  assert.notEqual(page2.json.messages[0]._id, byStatus.json.messages[0]._id);
  assert.equal((await call('GET', '/api/inbox/messages?category=Bad Key', owner)).status, 400);

  const detail = await call('GET', `/api/inbox/messages/${reply._id}`, owner);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.textExcerpt, 'Thanks, I will confirm headcount by Friday.');
  assert.equal((await call('GET', `/api/inbox/messages/${reply._id}`, stranger)).status, 404);
  assert.equal((await call('GET', '/api/inbox/messages/nope', owner)).status, 404);
  assert.equal(await Signal.countDocuments({ ownerId: owner, type: 'reply' }), 1);
  assert.equal((await call('GET', '/api/inbox/messages', stranger)).json.messages.length, 0);
});

test('correct, skip, process (inline) and the labels they leave', async () => {
  await grant();
  await seedMailbox();
  gmail.messages.delete('g-reply');
  await call('POST', '/api/inbox/sync', owner);
  const receipt = (await InboundMessage.findOne({ ownerId: owner, gmailMessageId: 'g-receipt' }))!;
  const news = (await InboundMessage.findOne({ ownerId: owner, gmailMessageId: 'g-news' }))!;

  const corrected = await call('POST', `/api/inbox/messages/${receipt._id}/category`, owner, { categoryKey: 'needs_action' });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.json));
  assert.equal(corrected.json.classification.backend, 'human');
  assert.equal(corrected.json.classification.correctedFrom, 'transactional');
  assert.equal(await Label.countDocuments({ ownerId: owner, runKind: 'classify', verdict: 'edited' }), 1);
  assert.equal((await call('POST', `/api/inbox/messages/${receipt._id}/category`, owner, { categoryKey: 'nope' })).status, 400);
  assert.equal((await call('POST', `/api/inbox/messages/${receipt._id}/category`, owner, { categoryKey: 'Bad' })).status, 400);
  assert.equal((await call('POST', `/api/inbox/messages/${receipt._id}/category`, stranger, { categoryKey: 'needs_action' })).status, 404);

  const skipped = await call('POST', `/api/inbox/messages/${news._id}/skip`, owner);
  assert.deepEqual(skipped.json, { status: 'skipped' });

  __setProviderForTests(fakeProvider([{ json: { items: [], summary: 'A receipt.' } }], { name: 'openai', embed: (i) => i.map(bagOfWords) }));
  const processed = await call('POST', `/api/inbox/messages/${receipt._id}/process`, owner);
  assert.equal(processed.status, 200, JSON.stringify(processed.json));
  assert.equal(processed.json.queued, false);
  assert.equal(processed.json.status, 'processed');
  assert.ok(processed.json.emailId);
  assert.equal((await Email.findById(processed.json.emailId))!.direction, 'inbound');
  assert.equal((await call('POST', `/api/inbox/messages/${receipt._id}/skip`, owner)).status, 409);
  assert.equal((await call('POST', `/api/inbox/messages/${receipt._id}/process`, owner)).json.status, 'already_processed');
  assert.equal((await call('POST', `/api/inbox/messages/${news._id}/process`, stranger)).status, 404);
});

test('categories: list with counts, create, update, examples, delete rules; reclassify is bounded and forced', async () => {
  await grant();
  await seedMailbox();
  gmail.messages.delete('g-reply');
  await call('POST', '/api/inbox/sync', owner);

  let cats = await call('GET', '/api/inbox/categories', owner);
  assert.equal(cats.status, 200);
  assert.equal(cats.json.length, 6);
  assert.equal(cats.json.find((c: { key: string }) => c.key === 'transactional').counts.total, 1);
  assert.equal(cats.json.find((c: { key: string }) => c.key === 'newsletter_or_bulk').counts.awaiting, 1);

  const created = await call('POST', '/api/inbox/categories', owner, { name: 'Vendors', description: 'Mail from suppliers about orders and receipts.', examples: ['Your order has shipped'], policy: 'never' });
  assert.equal(created.status, 201);
  assert.equal(created.json.key, 'vendors');
  assert.equal((await call('POST', '/api/inbox/categories', owner, { name: 'Vendors', description: 'dup' })).status, 400);
  assert.equal((await call('POST', '/api/inbox/categories', owner, { name: '', description: 'x' })).status, 400);

  const updated = await call('PUT', '/api/inbox/categories/vendors', owner, { policy: 'ask', description: 'Suppliers.' });
  assert.equal(updated.json.policy, 'ask');
  assert.equal(updated.json.description, 'Suppliers.');
  assert.equal((await call('PUT', '/api/inbox/categories/nope', owner, { policy: 'ask' })).status, 404);

  const ex = await call('POST', '/api/inbox/categories/vendors/examples', owner, { text: 'Invoice from supplier attached' });
  assert.equal(ex.json.examples.length, 2);
  const del = await call('DELETE', '/api/inbox/categories/vendors/examples/0', owner);
  assert.deepEqual(del.json.examples.map((e: { text: string }) => e.text), ['Invoice from supplier attached']);
  assert.equal((await call('DELETE', '/api/inbox/categories/vendors/examples/5', owner)).status, 404);

  // Forced reclassification with the new category: the receipt now has a
  // closer centroid ("receipts", "order", "invoice").
  const re = await call('POST', '/api/inbox/reclassify', owner, { categoryKey: 'transactional' });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.equal(re.json.selected, 1);
  assert.equal(re.json.classified, 1);
  const receipt = (await InboundMessage.findOne({ ownerId: owner, gmailMessageId: 'g-receipt' }))!;
  assert.ok(['vendors', 'transactional'].includes(receipt.classification!.categoryKey));

  assert.equal((await call('DELETE', '/api/inbox/categories/transactional', owner)).status, 400);
  assert.equal((await call('DELETE', '/api/inbox/categories/nope', owner)).status, 404);
  assert.deepEqual((await call('DELETE', '/api/inbox/categories/vendors', owner)).json, { deleted: true });
  cats = await call('GET', '/api/inbox/categories', owner);
  assert.equal(cats.json.length, 6);
  assert.equal(await InboundMessage.countDocuments({ ownerId: owner, 'classification.categoryKey': 'vendors' }), 0);
});

test('pause and resume polling; revoking the grant deletes unpromoted rows', async () => {
  await grant();
  await seedMailbox();
  gmail.messages.delete('g-reply');
  await call('POST', '/api/inbox/sync', owner);
  assert.equal((await call('PUT', '/api/inbox/sync', owner, { enabled: false })).json.enabled, false);
  assert.equal((await call('GET', '/api/inbox/status', owner)).json.syncEnabled, false);
  assert.equal((await call('POST', '/api/inbox/sync', owner)).json.sync.skipped, 'disabled');
  assert.equal((await call('PUT', '/api/inbox/sync', owner, { enabled: 'yes' })).status, 400);
  assert.equal((await call('PUT', '/api/inbox/sync', stranger, { enabled: true })).status, 404);
  assert.equal((await call('PUT', '/api/inbox/sync', owner, { enabled: true })).json.enabled, true);

  const rev = await call('DELETE', '/api/inbox/grant', owner);
  assert.deepEqual(rev.json, { revoked: true, deletedMessages: 2 });
  const st = await call('GET', '/api/inbox/status', owner);
  assert.equal(st.json.connected, false);
  assert.equal(st.json.counts.total, 0);
});
