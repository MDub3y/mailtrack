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
import { Proposal } from '../models/Proposal';
import { Label } from '../models/Label';
import { User } from '../models/User';
import { ensureContact, recordSignal } from '../services/signalService';
import { generateVoiceProfile, setVoiceProse, voiceTextFor } from '../ai/voice/profile';
import { voiceSection, memorySection, threadSection, describeGaps } from '../ai/context/sections';
import { buildDraftContext, draftFollowUp } from '../ai/draft/followUp';
import { addUserMemory } from '../ai/memory/policy';

// Phase 2 the way a user meets it: a voice profile from their sent mail, a
// draft for a queue item with a receipt of what was used, and the sent
// version compared with the draft so the edit becomes a label.

const owner = new mongoose.Types.ObjectId();
let server: http.Server;
let base: string;

function token(id: mongoose.Types.ObjectId): string {
  return jwt.sign({ userId: id.toString() }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, body?: unknown, who = owner): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(who)}` }, body: body === undefined ? undefined : JSON.stringify(body) });
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
  process.env.AI_MODEL_PRIMARY = 'anthropic:claude-opus-5';
  __setProviderForTests(null);
});
after(async () => {
  __setProviderForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
  // The send route enqueues through the email queue; release its socket so
  // the test process can exit.
  const { closeEmailQueue } = await import('../queues/emailQueue');
  await closeEmailQueue();
  await disconnectTestDb();
});

async function sent(to: string, subject: string, body: string, daysAgo: number, extra: Record<string, unknown> = {}) {
  const contact = await ensureContact(owner, to, { displayName: to.split('@')[0] });
  const createdAt = new Date(Date.now() - daysAgo * 86_400_000);
  const email = await Email.create({ senderId: owner, contactId: contact._id, from: 'sam@gmail.com', to, subject, htmlBody: `<p>${body}</p>`, textBody: body, trackingToken: `t-${Math.random()}`, status: 'delivered', events: [], createdAt, ...extra });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'sent', at: createdAt, verdict: 'human', source: 'system', dedupeKey: `sent:${email._id}` });
  return { contact, email };
}

const SAMPLE_BODIES = [
  "Hi Priya,\n\nThanks for the call. I'll send the revised quote by Friday.\n\nBest,\nSam",
  "Marcus,\n\nProposal attached. Happy to walk through pricing on a call.\n\nBest,\nSam",
  "Hi Aisha,\n\nChecking whether the pilot numbers landed. You said you'd confirm headcount by the 12th.\n\nBest,\nSam",
];

test('voice profile: needs samples, stores prose as a sender-scoped item, supersedes itself, defers to the user', async () => {
  __setProviderForTests(fakeProvider([]));
  assert.equal(await generateVoiceProfile(owner), null);
  for (let i = 0; i < SAMPLE_BODIES.length; i++) await sent(`p${i}@x.com`, `Subject ${i}`, SAMPLE_BODIES[i], 3 - i);

  const profile = { greeting: 'Hi <first name>,', signoff: 'Best,\nSam', avgSentenceLength: 'short', formality: 'plain', phrases: ['Happy to'], avoids: ['exclamation marks'], prose: 'You open with "Hi" and the first name, write short plain sentences, and sign off with "Best, Sam". You avoid exclamation marks.' };
  const fake = fakeProvider([{ json: profile }, { json: { ...profile, prose: 'Second version of the prose, still plain and short, signing off with Best.' } }]);
  __setProviderForTests(fake);

  const first = await generateVoiceProfile(owner);
  assert.ok(first);
  assert.equal(first!.memory.scope, 'sender');
  assert.equal(first!.memory.kind, 'voice');
  assert.equal(first!.memory.status, 'active');
  assert.equal(await voiceTextFor(owner), profile.prose);
  assert.equal(fake.requests[0].effort, 'medium');
  assert.match((fake.requests[0].messages[0] as { text: string }).text, /sample 1 \(subject: Subject 2\)/); // newest first
  assert.equal((first!.memory.structured as { sampleCount: number }).sampleCount, 3);

  const second = await generateVoiceProfile(owner);
  assert.equal((await Memory.findById(first!.memory._id).lean())!.status, 'superseded');
  assert.equal(await voiceTextFor(owner), second!.memory.content);

  // The user rewrites it: their words win and a later regeneration only proposes.
  await setVoiceProse(owner, 'You write like a person, not a brochure. Short. No exclamation marks. Sign off with Sam.');
  assert.match((await voiceTextFor(owner))!, /not a brochure/);
  __setProviderForTests(fakeProvider([{ json: profile }]));
  const third = await generateVoiceProfile(owner);
  assert.equal(third!.memory.status, 'proposed');
  assert.match((await voiceTextFor(owner))!, /not a brochure/);
});

test('sections: task-aware memory order, brief first, thread prefers stored summaries, known gaps', async () => {
  const { contact, email } = await sent('priya@x.com', 'Revised quote', 'Body one', 2, { summary: 'Promised the revised quote by Friday.' });
  await sent('priya@x.com', 'Older note', 'Older body text that is long enough to be truncated if there is no summary at all for it', 9);
  await addUserMemory({ ownerId: owner, contactId: contact._id, kind: 'fact', content: 'Priya runs procurement.' });
  await addUserMemory({ ownerId: owner, contactId: contact._id, kind: 'commitment', content: 'You promised a revised quote.', structured: { by: 'sender' } });
  await addUserMemory({ ownerId: owner, contactId: contact._id, kind: 'preference', content: 'Prefers short emails.' });
  await Contact.updateOne({ _id: contact._id }, { $set: { brief: { text: 'Owes a quote; engaged.', citedMemoryIds: [], basedOnSignalCount: 1, generatedAt: new Date(), runId: new mongoose.Types.ObjectId() } } });
  const fresh = (await Contact.findById(contact._id))!;

  const forCommitment = await memorySection(fresh, 'your_commitment_due');
  assert.match(forCommitment.items[0].text, /^Brief: Owes a quote/);
  assert.deepEqual(forCommitment.memory.map((m) => m.kind), ['commitment', 'fact', 'preference']);
  const forUnopened = await memorySection(fresh, 'unopened');
  assert.deepEqual(forUnopened.memory.map((m) => m.kind), ['preference', 'commitment', 'fact']);

  const thread = await threadSection(fresh);
  assert.equal(thread.emails.length, 2);
  assert.equal(thread.emails[0].id, email._id.toString());
  assert.equal(thread.emails[0].summary, 'Promised the revised quote by Friday.');
  assert.match(thread.emails[1].summary, /^Older body text/);
  assert.match(thread.items![0].text, /you wrote "Revised quote": Promised the revised quote/);

  const voice = await voiceSection(owner);
  assert.equal(voice.hasProfile, false);
  assert.equal(voice.cacheBoundary, true);
  assert.equal(voice.stable, true);
  assert.match(voice.text!, /No voice profile yet/);

  const gaps = describeGaps({ noVoiceProfile: true, noReplyData: true, noMemoryBeyondEngagement: false, lastEmailDaysAgo: 90 });
  assert.equal(gaps.length, 3);
  assert.match(gaps[2], /90 days ago/);
});

test('the draft context is byte-identical above the cache boundary across two builds for the same sender', async () => {
  const { contact } = await sent('priya@x.com', 'Revised quote', 'Body', 2);
  await setVoiceProse(owner, 'You write short plain sentences and sign off with Sam. No exclamation marks.');
  const a = await buildDraftContext({ ownerId: owner, contactId: contact._id, rule: 'opened_no_reply' });
  const b = await buildDraftContext({ ownerId: owner, contactId: contact._id, rule: 'unopened' });
  assert.equal(JSON.stringify(a.ctx.system), JSON.stringify(b.ctx.system));
  assert.deepEqual(a.ctx.system.map((s) => s.cacheBoundary), [false, true]);
  assert.notEqual((a.ctx.messages[0] as { text: string }).text, (b.ctx.messages[0] as { text: string }).text);
});

test('a draft cites memory and emails that were in context, may read one email in full, and becomes a pending proposal', async () => {
  const { contact, email } = await sent('priya@x.com', 'Revised quote', "Thanks for the call. I'll send the revised quote by Friday.", 3, { summary: 'Promised the revised quote by Friday.' });
  const commitment = await addUserMemory({ ownerId: owner, contactId: contact._id, kind: 'commitment', content: 'You promised Priya a revised quote by Friday.', structured: { by: 'sender', dueAt: '2026-09-19' } });

  const fake = fakeProvider([
    { toolCalls: [{ id: 'c1', name: 'get_email', input: { emailId: email._id.toString() } }] },
    { json: { subject: 'Revised quote', body: 'Hi Priya,\n\nHere is the revised quote I promised on our call. It is attached.\n\nBest,\nSam', usedMemoryIds: [commitment._id.toString()], usedEmailIds: [email._id.toString()], gaps: ['Attach the actual quote before sending.'] } },
  ]);
  __setProviderForTests(fake);

  const result = await draftFollowUp({ ownerId: owner, contactId: contact._id, emailId: email._id.toString(), rule: 'your_commitment_due', reason: 'You promised Priya a revised quote by Friday. (was due 3 days ago)' });
  assert.equal(result.draft.subject, 'Revised quote');
  assert.deepEqual(result.usedMemory.map((m) => m.id), [commitment._id.toString()]);
  assert.deepEqual(result.usedEmails.map((e) => e.subject), ['Revised quote']);
  assert.deepEqual(result.gaps.slice(-1), ['Attach the actual quote before sending.']);
  assert.ok(result.gaps.some((g) => /no voice profile/i.test(g)));
  const memorySection = result.receipt.sections.find((s) => s.name === 'memory')!;
  assert.ok(memorySection.itemIds.includes(commitment._id.toString()));
  assert.ok(result.receipt.sections.find((s) => s.name === 'thread')!.itemIds.includes(email._id.toString()));

  // The tool returned the full body, and only for an email in the thread list.
  assert.equal(fake.requests.length, 2);
  const toolResults = (fake.requests[1].messages[2] as { results: Array<{ content: string }> }).results;
  assert.match(toolResults[0].content, /you wrote "Revised quote":\nThanks for the call/);
  assert.match((fake.requests[0].messages[0] as { text: string }).text, /Reason: You promised Priya a revised quote/);
  assert.equal(fake.requests[0].effort, 'medium');

  const proposal = await Proposal.findById(result.proposalId).lean();
  assert.equal(proposal!.kind, 'draft');
  assert.equal(proposal!.status, 'pending'); // never auto-accepted, whatever the trust policy says
  assert.equal((proposal!.payload as { body: string }).body, result.draft.body);
});

test('a draft citing an id outside the context is rejected outright', async () => {
  const { contact } = await sent('priya@x.com', 'Revised quote', 'Body', 3);
  __setProviderForTests(fakeProvider([{ json: { subject: 's', body: 'A body that is long enough to pass the schema minimum.', usedMemoryIds: [new mongoose.Types.ObjectId().toString()], usedEmailIds: [] } }]));
  await assert.rejects(draftFollowUp({ ownerId: owner, contactId: contact._id, rule: 'unopened' }), /not in context/);
  assert.equal(await Proposal.countDocuments({ kind: 'draft' }), 0);
});

test('the tool refuses emails outside the thread list and other owners', async () => {
  const { contact } = await sent('priya@x.com', 'Revised quote', 'Body', 3);
  const foreign = await Email.create({ senderId: new mongoose.Types.ObjectId(), from: 'x', to: 'y@z.com', subject: 'Secret', htmlBody: '', textBody: 'secret body', trackingToken: 'tf', status: 'delivered', events: [] });
  const fake = fakeProvider([
    { toolCalls: [{ id: 'c1', name: 'get_email', input: { emailId: foreign._id.toString() } }] },
    { json: { subject: 's', body: 'A body that is long enough to pass the schema minimum.', usedMemoryIds: [], usedEmailIds: [] } },
  ]);
  __setProviderForTests(fake);
  await draftFollowUp({ ownerId: owner, contactId: contact._id, rule: 'unopened' });
  const toolResults = (fake.requests[1].messages[2] as { results: Array<{ content: string }> }).results;
  assert.equal(toolResults[0].content, 'That email is not in the thread list.');
});

test('HTTP: draft endpoint validates, returns the receipt, and sending with the proposal id writes the label', async () => {
  const { contact, email } = await sent('priya@x.com', 'Revised quote', 'Body', 3);
  await User.create({ _id: owner, name: 'Sam', email: 'sam@test.com', password: 'pw-not-used-12', emailAddress: 'sam@test.com', gmailAddress: 'sam@gmail.com' });

  assert.equal((await call('POST', '/api/ai/draft', { contactId: 'nope' })).status, 400);
  assert.equal((await call('POST', '/api/ai/draft', { contactId: new mongoose.Types.ObjectId().toString() })).status, 404);

  __setProviderForTests(fakeProvider([{ json: { subject: 'Quick one', body: 'Hi Priya, just making sure the quote landed on your side.', usedMemoryIds: [], usedEmailIds: [email._id.toString()] } }]));
  const drafted = await call('POST', '/api/ai/draft', { contactId: contact._id.toString(), emailId: email._id.toString(), rule: 'opened_no_reply' });
  assert.equal(drafted.status, 200);
  assert.equal(drafted.json.draft.subject, 'Quick one');
  assert.ok(drafted.json.proposalId);
  assert.ok(Array.isArray(drafted.json.receipt.sections));

  // The user edits one word and sends. The send path is the ordinary one;
  // the edit is recorded against the draft proposal.
  const sentRes = await call('POST', '/api/emails/send', { to: 'priya@x.com', subject: 'Quick one', htmlBody: '<p>x</p>', textBody: 'Hi Priya, just making sure the quote landed safely on your side.', draftProposalId: drafted.json.proposalId });
  assert.equal(sentRes.status, 201);
  const proposal = await Proposal.findById(drafted.json.proposalId).lean();
  assert.equal(proposal!.status, 'accepted');
  const label = await Label.findOne({ proposalId: proposal!._id }).lean();
  assert.equal(label!.verdict, 'edited');
  assert.equal(label!.runKind, 'draft_follow_up');
  assert.match((label!.after as { body: string }).body, /landed safely/);

  // Sent verbatim → accepted, not edited.
  __setProviderForTests(fakeProvider([{ json: { subject: 'Same', body: 'Hi Priya, sending this exactly as drafted, nothing changed.', usedMemoryIds: [], usedEmailIds: [] } }]));
  const d2 = await call('POST', '/api/ai/draft', { contactId: contact._id.toString(), rule: 'unopened' });
  await call('POST', '/api/emails/send', { to: 'priya@x.com', subject: 'Same', htmlBody: '<p>x</p>', textBody: 'Hi Priya, sending this exactly as drafted, nothing changed.', draftProposalId: d2.json.proposalId });
  assert.equal((await Label.findOne({ proposalId: d2.json.proposalId }).lean())!.verdict, 'accepted');
});

test('HTTP: voice endpoints', async () => {
  const empty = await call('GET', '/api/ai/voice');
  assert.equal(empty.json.profile, null);
  assert.equal(empty.json.samples, 0);
  assert.equal((await call('POST', '/api/ai/voice', {})).status, 400);
  for (let i = 0; i < 3; i++) await sent(`p${i}@x.com`, `S${i}`, SAMPLE_BODIES[i], i);
  __setProviderForTests(fakeProvider([{ json: { greeting: 'Hi', signoff: 'Best, Sam', avgSentenceLength: 'short', formality: 'plain', phrases: [], avoids: [], prose: 'You write short plain sentences and sign off with Best, Sam. No exclamation marks at all.' } }]));
  const gen = await call('POST', '/api/ai/voice', {});
  assert.equal(gen.status, 200);
  assert.match(gen.json.prose, /short plain sentences/);
  assert.equal((await call('PUT', '/api/ai/voice', { prose: 'too short' })).status, 400);
  const put = await call('PUT', '/api/ai/voice', { prose: 'You write like a person and never like a brochure. Keep it short.' });
  assert.equal(put.json.source, 'user');
  const got = await call('GET', '/api/ai/voice');
  assert.match(got.json.profile.prose, /never like a brochure/);
  assert.equal(got.json.samples, 3);
});
