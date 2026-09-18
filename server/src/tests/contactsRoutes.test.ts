import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { fakeProvider } from './helpers/fakeProvider';
import { __setProviderForTests } from '../ai/providers';
import app from '../app';
import { Email } from '../models/Email';
import { Memory } from '../models/Memory';
import { Contact } from '../models/Contact';
import { ensureContact, recordSignal } from '../services/signalService';
import { extractMemoryForEmail } from '../ai/memory/extract';

// The HTTP surface the Contacts, ContactDetail and Queue pages use.

const owner = new mongoose.Types.ObjectId();
const stranger = new mongoose.Types.ObjectId();
let server: http.Server;
let base: string;

function token(id: mongoose.Types.ObjectId): string {
  return jwt.sign({ userId: id.toString() }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, body?: unknown, who = owner): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(who)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
  await resetTestDb();
  process.env.AI_ENABLED = 'true';
  process.env.AI_TRUST_POLICY_ENABLED = 'false';
  __setProviderForTests(null);
});
after(async () => {
  __setProviderForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
  await disconnectTestDb();
});

async function seed() {
  const contact = await ensureContact(owner, 'priya@example.com', { displayName: 'Priya' });
  const email = await Email.create({
    senderId: owner, contactId: contact._id, from: 'me@gmail.com', to: 'priya@example.com', subject: 'Revised quote',
    htmlBody: '', textBody: "I'll send the revised quote by Friday.", trackingToken: 'tok-1', status: 'delivered', events: [],
    createdAt: new Date(Date.now() - 4 * 86_400_000),
  });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'sent', at: email.createdAt, verdict: 'human', source: 'system', dedupeKey: `sent:${email._id}` });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'open', at: new Date(Date.now() - 2 * 86_400_000), verdict: 'human', source: 'pixel', dedupeKey: 'o1' });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'open', at: new Date(Date.now() - 1 * 86_400_000), verdict: 'human', source: 'pixel', dedupeKey: 'o2' });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'open', at: new Date(Date.now() - 3 * 3_600_000), verdict: 'automated', source: 'pixel', dedupeKey: 'o3' });
  __setProviderForTests(fakeProvider([{ json: { items: [
    { kind: 'commitment', content: 'You promised Priya a revised quote by Friday.', structured: { by: 'sender', dueAt: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) }, quote: "I'll send the revised quote by Friday", confidence: 0.9 },
    { kind: 'preference', content: 'Priya prefers short emails.', structured: { about: 'length' }, quote: 'revised quote', confidence: 0.4 },
  ] } }]));
  await extractMemoryForEmail(email._id.toString());
  return { contact, email };
}

test('contacts list is scoped to the owner with memory counts and the brief', async () => {
  const { contact } = await seed();
  await ensureContact(stranger, 'someone@else.com');
  await Contact.updateOne({ _id: contact._id }, { $set: { brief: { text: 'Owes a quote.', citedMemoryIds: [], basedOnSignalCount: 3, generatedAt: new Date(), runId: new mongoose.Types.ObjectId() } } });

  const { status, json } = await call('GET', '/api/contacts');
  assert.equal(status, 200);
  assert.equal(json.length, 1);
  assert.equal(json[0].address, 'priya@example.com');
  assert.equal(json[0].displayName, 'Priya');
  assert.deepEqual(json[0].memoryCounts, { active: 1, proposed: 1 });
  assert.equal(json[0].briefText, 'Owes a quote.');
  assert.equal(json[0].stats.opened, 2);
});

test('contact detail returns memory with evidence, emails, and a human-only timeline; 404 for others', async () => {
  const { contact, email } = await seed();
  const { status, json } = await call('GET', `/api/contacts/${contact._id}`);
  assert.equal(status, 200);
  assert.equal(json.contact.address, 'priya@example.com');
  assert.deepEqual(json.memory.map((m: { kind: string; status: string }) => [m.kind, m.status]).sort(), [['commitment', 'active'], ['preference', 'proposed']]);
  const commitment = json.memory.find((m: { kind: string }) => m.kind === 'commitment');
  assert.equal(commitment.evidence[0].emailId, email._id.toString());
  assert.equal(commitment.evidence[0].quote, "I'll send the revised quote by Friday");
  assert.equal(json.emails.length, 1);
  assert.equal(json.emails[0].subject, 'Revised quote');
  assert.deepEqual(json.signals.map((s: { type: string }) => s.type), ['open', 'open', 'sent']);
  assert.equal((await call('GET', `/api/contacts/${contact._id}`, undefined, stranger)).status, 404);
});

test('memory decisions and user-added items via the API', async () => {
  const { contact } = await seed();
  const proposed = await Memory.findOne({ subjectId: contact._id, status: 'proposed' });

  const bad = await call('PATCH', `/api/memory/${proposed!._id}`, { decision: 'maybe' });
  assert.equal(bad.status, 400);
  const accepted = await call('PATCH', `/api/memory/${proposed!._id}`, { decision: 'accept' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.status, 'active');
  assert.equal((await call('PATCH', `/api/memory/${proposed!._id}`, { decision: 'reject' }, stranger)).status, 404);

  const added = await call('POST', `/api/contacts/${contact._id}/memory`, { kind: 'fact', content: 'Priya is the decision maker.' });
  assert.equal(added.status, 201);
  assert.equal(added.json.source, 'user');
  assert.equal(added.json.status, 'active');
  assert.equal((await call('POST', `/api/contacts/${contact._id}/memory`, { kind: 'rumour', content: 'x' })).status, 400);
  assert.equal((await call('POST', `/api/contacts/${contact._id}/memory`, { kind: 'fact', content: 'x' }, stranger)).status, 404);
});

test('the queue endpoint returns reasons and honours snooze and dismiss', async () => {
  const { email } = await seed();
  const q1 = await call('GET', '/api/queue');
  assert.equal(q1.status, 200);
  const rules = q1.json.items.map((i: { rule: string }) => i.rule).sort();
  assert.deepEqual(rules, ['opened_no_reply', 'your_commitment_due']);
  const opened = q1.json.items.find((i: { rule: string }) => i.rule === 'opened_no_reply');
  assert.equal(opened.reason, 'Opened 2 times since 2 days ago, no reply');
  assert.equal(opened.contact.address, 'priya@example.com');

  assert.equal((await call('POST', '/api/queue/opened_no_reply/snooze', {})).status, 400);
  assert.equal((await call('POST', '/api/queue/not_a_rule/snooze', { emailId: email._id.toString() })).status, 400);
  assert.equal((await call('POST', '/api/queue/opened_no_reply/snooze', { emailId: email._id.toString(), days: 2 })).status, 200);
  const q2 = await call('GET', '/api/queue');
  assert.deepEqual(q2.json.items.map((i: { rule: string }) => i.rule), ['your_commitment_due']);

  const memoryId = q2.json.items[0].memoryId;
  const dismissed = await call('POST', '/api/queue/your_commitment_due/dismiss', { memoryId });
  assert.equal(dismissed.json.cooldownDays, 7);
  const q3 = await call('GET', '/api/queue');
  assert.equal(q3.json.items.length, 0);
});

test('regenerating a brief on demand', async () => {
  const { contact } = await seed();
  const commitment = await Memory.findOne({ subjectId: contact._id, kind: 'commitment' });
  __setProviderForTests(fakeProvider([{ json: { text: 'You owe Priya a revised quote. She has opened the last email twice.', citedMemoryIds: [commitment!._id.toString()] } }]));
  const { status, json } = await call('POST', `/api/contacts/${contact._id}/brief`, {});
  assert.equal(status, 200);
  assert.equal(json.generated, true);
  assert.match(json.text, /revised quote/);
  const c = await Contact.findById(contact._id).lean();
  assert.equal(c!.brief!.text, json.text);
});
