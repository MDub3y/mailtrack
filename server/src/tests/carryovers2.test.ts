import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { fakeGmail, FakeGmail } from './helpers/fakeGmail';
import { fakeProvider } from './helpers/fakeProvider';
import { __setGmailClientFactoryForTests } from '../services/gmailClient';
import { __setProviderForTests } from '../ai/providers';
import app from '../app';
import { User } from '../models/User';
import { Memory } from '../models/Memory';
import { InboundMessage } from '../models/InboundMessage';
import { ensureContact } from '../services/signalService';
import { encryptSecret } from '../utils/secrets';
import { READ_SCOPE, ensurePushWatch, parsePushNotification, syncInbox } from '../services/inboxService';
import { ContextBuilder } from '../ai/context/builder';
import { memorySection } from '../ai/context/sections';
import { buildDraftContext, draftFollowUp } from '../ai/draft/followUp';
import { Contact } from '../models/Contact';

// Gmail push (watch registered and renewed, notifications trigger the
// ordinary sync) and receipt drop reasons with "include this and redraft".

const owner = new mongoose.Types.ObjectId();
let server: http.Server;
let base: string;
let gmail: FakeGmail;

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.AI_ENABLED = 'true';
  process.env.AI_ALLOW_SERVER_KEYS = 'false';
  process.env.AI_TRUST_POLICY_ENABLED = 'false';
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
  await resetTestDb();
  __setProviderForTests(null);
  gmail = fakeGmail('me@gmail.com');
  __setGmailClientFactoryForTests(() => gmail);
  delete process.env.GMAIL_PUSH_TOPIC; delete process.env.GMAIL_PUSH_TOKEN;
  await User.create({
    _id: owner, name: 'Me', email: 'me@example.com', emailAddress: 'me@example.com', password: 'x', gmailAddress: 'me@gmail.com',
    gmailRead: { address: 'me@gmail.com', refreshToken: encryptSecret('r'), accessToken: encryptSecret('a'), tokenExpiry: new Date(Date.now() + 3_600_000), scope: READ_SCOPE, grantedAt: new Date(), syncEnabled: true, historyId: '1000', initialSyncDone: true },
  });
});
after(async () => { __setGmailClientFactoryForTests(null); __setProviderForTests(null); await new Promise<void>((r) => server.close(() => r())); await disconnectTestDb(); });

test('push: nothing without configuration; a watch is registered once and renewed near expiry; notifications trigger a sync for the named address only', async () => {
  assert.deepEqual(await ensurePushWatch(owner.toString()), { registered: false, reason: 'push not configured' });
  assert.equal((await fetch(`${base}/api/inbox/push?token=x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);

  process.env.GMAIL_PUSH_TOPIC = 'projects/p/topics/gmail';
  process.env.GMAIL_PUSH_TOKEN = 'push-secret';
  const first = await ensurePushWatch(owner.toString());
  assert.equal(first.registered, true);
  assert.deepEqual(gmail.watches, [{ topicName: 'projects/p/topics/gmail', labelIds: ['INBOX'] }]);
  const again = await ensurePushWatch(owner.toString());
  assert.equal(again.registered, true);
  assert.equal(gmail.watches.length, 1); // still valid: not re-registered
  await User.updateOne({ _id: owner }, { $set: { 'gmailRead.watchExpiration': new Date(Date.now() + 3_600_000) } });
  await syncInbox(owner.toString()); // the sync job renews when under a day is left
  assert.equal(gmail.watches.length, 2);

  assert.deepEqual(parsePushNotification({ message: { data: Buffer.from(JSON.stringify({ emailAddress: 'Me@gmail.com', historyId: 1234 })).toString('base64') } }), { emailAddress: 'me@gmail.com', historyId: '1234' });
  assert.equal(parsePushNotification({ message: { data: 'not-json' } }), null);
  assert.equal(parsePushNotification({}), null);

  gmail.add({ id: 'n1', from: 'p@x.com', text: 'pushed mail' });
  const wrongToken = await fetch(`${base}/api/inbox/push?token=nope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress: 'me@gmail.com' })).toString('base64') } }) });
  assert.equal(wrongToken.status, 404);
  assert.equal(await InboundMessage.countDocuments({ ownerId: owner }), 0);
  const other = await fetch(`${base}/api/inbox/push?token=push-secret`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress: 'someone-else@gmail.com' })).toString('base64') } }) });
  assert.equal(other.status, 204);
  assert.equal(await InboundMessage.countDocuments({ ownerId: owner }), 0);
  const mine = await fetch(`${base}/api/inbox/push?token=push-secret`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress: 'me@gmail.com', historyId: 9 })).toString('base64') } }) });
  assert.equal(mine.status, 204);
  assert.equal(await InboundMessage.countDocuments({ ownerId: owner, gmailMessageId: 'n1' }), 1);
});

test('receipts say why an item was left out (budget, proposed, over the cap), and "include this and redraft" forces it into context first', async () => {
  const contact = await ensureContact(owner, 'priya@example.com', { displayName: 'Priya' });
  await Contact.updateOne({ _id: contact._id }, { $set: { brief: { text: 'Priya is evaluating.', citedMemoryIds: [], basedOnSignalCount: 1, generatedAt: new Date(), runId: new mongoose.Types.ObjectId() } } });
  const proposed = await Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'fact', content: 'Proposed: their budget is approved for Q4', confidence: 0.6, source: 'agent', status: 'proposed', evidence: [] });
  const facts: mongoose.Types.ObjectId[] = [];
  for (let i = 0; i < 14; i++) facts.push((await Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'fact', content: `Fact number ${i} about Priya's team`, confidence: 0.9 - i * 0.01, source: 'agent', status: 'active', evidence: [] }))._id);

  // Facts are capped at 12 per kind: two fall over the cap; the proposed one is never offered.
  const sec = await memorySection(await Contact.findById(contact._id).then((c) => c!), undefined);
  const reasons = Object.fromEntries((sec.excluded ?? []).map((e) => [e.id, e.reason]));
  assert.equal(reasons[proposed._id.toString()], 'proposed_not_accepted');
  assert.equal(Object.values(reasons).filter((r) => r === 'kind_cap').length, 2);
  assert.equal((sec.excluded ?? []).find((e) => e.id === proposed._id.toString())!.label, 'Proposed: their budget is approved for Q4');

  // The builder carries the reasons and adds budget drops with a label.
  const ctx = new ContextBuilder()
    .add({ name: 'system', budgetTokens: 100, stable: true, text: 'x' })
    .add({ name: 'memory', budgetTokens: 60, stable: false, items: sec.items, excluded: sec.excluded })
    .build();
  const mem = ctx.receipt.sections.find((s) => s.name === 'memory')!;
  assert.ok(mem.dropped!.some((d) => d.reason === 'budget' && d.label && !/^\[/.test(d.label)));
  assert.ok(mem.dropped!.some((d) => d.reason === 'proposed_not_accepted'));
  assert.ok(mem.dropped!.some((d) => d.reason === 'kind_cap'));
  assert.deepEqual(mem.droppedItemIds.length, mem.dropped!.length);

  // Include and redraft: the proposed item and an over-cap fact come first in the memory section.
  const overCap = Object.entries(reasons).find(([, r]) => r === 'kind_cap')![0];
  const { ctx: forced } = await buildDraftContext({ ownerId: owner, contactId: contact._id, reason: 'check in', includeMemoryIds: [proposed._id.toString(), overCap] });
  const memText = (forced.messages[0] as { text: string }).text;
  assert.ok(memText.indexOf(proposed._id.toString()) < memText.indexOf('Brief: Priya is evaluating.'));
  assert.ok(memText.includes(overCap));
  const forcedSec = forced.receipt.sections.find((s) => s.name === 'memory')!;
  assert.ok(!forcedSec.droppedItemIds.includes(proposed._id.toString()));

  // The draft result echoes the request so the client can redraft with more.
  __setProviderForTests(fakeProvider([{ json: { subject: 'Checking in', body: 'Hi Priya, following up on the budget. Best', usedMemoryIds: [proposed._id.toString()], usedEmailIds: [] } }], { name: 'custom' }));
  const d = await draftFollowUp({ ownerId: owner, contactId: contact._id, reason: 'check in', includeMemoryIds: [proposed._id.toString()] });
  assert.deepEqual(d.request, { contactId: contact._id.toString(), emailId: undefined, rule: undefined, reason: 'check in', includeMemoryIds: [proposed._id.toString()] });
  assert.equal(d.usedMemory[0].id, proposed._id.toString());
});
