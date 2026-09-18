import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { Email } from '../models/Email';
import { Memory } from '../models/Memory';
import { ensureContact, recordSignal } from '../services/signalService';
import { buildQueue, snoozeItem, dismissItem } from '../services/queueService';

// The follow-through queue is rules over data; each test builds the data a
// real week of sending would leave behind and checks the reason strings.

const owner = new mongoose.Types.ObjectId();
const NOW = new Date('2026-09-18T12:00:00Z');
const DAY = 86_400_000;
const daysBefore = (n: number, hours = 0) => new Date(NOW.getTime() - n * DAY - hours * 3_600_000);

before(async () => { await connectTestDb(); });
beforeEach(async () => { await resetTestDb(); });
after(async () => { await disconnectTestDb(); });

async function thread(address: string, sentAt: Date, subject = 'Proposal') {
  const contact = await ensureContact(owner, address);
  const email = await Email.create({
    senderId: owner, contactId: contact._id, from: 'me@gmail.com', to: address, subject, htmlBody: '', textBody: '',
    trackingToken: `tok-${address}-${sentAt.getTime()}`, status: 'delivered', events: [], createdAt: sentAt,
  });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'sent', at: sentAt, verdict: 'human', source: 'system', dedupeKey: `sent:${email._id}` });
  const open = (at: Date, verdict: 'human' | 'automated' = 'human') =>
    recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'open', at, verdict, source: 'pixel', dedupeKey: `open:${email._id}:${at.getTime()}` });
  const reply = (at: Date) =>
    recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'reply', at, verdict: 'human', source: 'gmail', dedupeKey: `reply:${email._id}:${at.getTime()}` });
  const dwell = (at: Date, totalSeconds: number, topPage: number) =>
    recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'page_dwell', at, verdict: 'human', source: 'viewer', dedupeKey: `dwell:${email._id}:${at.getTime()}`, payload: { documentName: 'Proposal.pdf', totalSeconds, topPage, topSeconds: totalSeconds } });
  return { contact, email, open, reply, dwell };
}

test('unopened after the threshold; not before; and never once there is a reply', async () => {
  await thread('a@x.com', daysBefore(5));
  await thread('b@x.com', daysBefore(1));
  const c = await thread('c@x.com', daysBefore(6));
  await c.reply(daysBefore(2));

  const items = await buildQueue(owner, { now: NOW });
  assert.deepEqual(items.map((i) => [i.rule, i.contact.address, i.reason]), [
    ['unopened', 'a@x.com', 'Delivered 5 days ago, not opened'],
  ]);
});

test('opened repeatedly with no reply, with automated opens ignored', async () => {
  const a = await thread('a@x.com', daysBefore(3));
  await a.open(daysBefore(2, 1));
  await a.open(daysBefore(2), 'automated');
  await a.open(daysBefore(1));
  await a.open(daysBefore(0, 2));
  const b = await thread('b@x.com', daysBefore(3));
  await b.open(daysBefore(2));

  const items = await buildQueue(owner, { now: NOW });
  const opened = items.filter((i) => i.rule === 'opened_no_reply');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].contact.address, 'a@x.com');
  assert.equal(opened[0].reason, 'Opened 3 times since 2 days ago, no reply');
  assert.equal(opened[0].email!.subject, 'Proposal');
});

test('document interest names the document and page; renewed interest names the quiet gap', async () => {
  const a = await thread('a@x.com', daysBefore(4));
  await a.open(daysBefore(3));
  await a.dwell(daysBefore(1), 245, 4);
  const b = await thread('b@x.com', daysBefore(20));
  await b.open(daysBefore(19));
  await b.open(daysBefore(1));

  const items = await buildQueue(owner, { now: NOW });
  const byRule = Object.fromEntries(items.map((i) => [i.rule, i]));
  assert.equal(byRule.document_interest.reason, 'Read "Proposal.pdf" for 4 minutes yesterday, longest on page 4, no reply');
  assert.equal(byRule.renewed_interest.contact.address, 'b@x.com');
  assert.equal(byRule.renewed_interest.reason, 'Opened again yesterday after 18 quiet days');
});

test('commitments in both directions, only when due soon or overdue and unfulfilled', async () => {
  const { contact, email } = await thread('a@x.com', daysBefore(10));
  const mk = (content: string, by: 'sender' | 'contact', due: Date, extra: Record<string, unknown> = {}) =>
    Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'commitment', content, structured: { by, ...extra }, evidence: [{ emailId: email._id, quote: 'q' }], confidence: 0.9, source: 'agent', status: 'active', expiresAt: due });
  await mk('You promised a revised quote by Friday.', 'sender', daysBefore(-1));          // due tomorrow
  await mk('You promised the security overview.', 'sender', daysBefore(3));               // overdue
  await mk('They said they would confirm headcount.', 'contact', daysBefore(1));          // overdue, theirs
  await mk('You promised a case study.', 'sender', daysBefore(-30));                      // far future → not yet
  await mk('You promised the contract.', 'sender', daysBefore(2), { fulfilledByEmailId: 'x' }); // fulfilled → no

  const items = (await buildQueue(owner, { now: NOW })).filter((i) => i.rule.endsWith('commitment_due'));
  assert.deepEqual(items.map((i) => [i.rule, i.reason]).sort(), [
    ['their_commitment_due', 'They said: They said they would confirm headcount. (was due yesterday)'],
    ['your_commitment_due', 'You promised a revised quote by Friday. (due 2026-09-19)'],
    ['your_commitment_due', 'You promised the security overview. (was due 3 days ago)'],
  ]);
  assert.ok(items.every((i) => i.memoryId && i.email?.subject === 'Proposal'));
});

test('snooze hides until the date; dismiss suppresses the same rule for the cooldown only', async () => {
  const a = await thread('a@x.com', daysBefore(5));
  const b = await thread('b@x.com', daysBefore(5));
  await b.open(daysBefore(1));
  await b.open(daysBefore(0, 1));

  let items = await buildQueue(owner, { now: NOW });
  assert.deepEqual(items.map((i) => i.rule).sort(), ['opened_no_reply', 'unopened']);

  await snoozeItem(owner.toString(), 'unopened', { emailId: a.email._id.toString() }, new Date(NOW.getTime() + 2 * DAY));
  await dismissItem(owner.toString(), 'opened_no_reply', { emailId: b.email._id.toString() }, 7);

  items = await buildQueue(owner, { now: NOW });
  assert.equal(items.length, 0);
  items = await buildQueue(owner, { now: new Date(NOW.getTime() + 3 * DAY) });
  assert.deepEqual(items.map((i) => i.rule), ['unopened']);          // snooze elapsed, dismissal still holds
  items = await buildQueue(owner, { now: new Date(NOW.getTime() + 8 * DAY) });
  assert.deepEqual(items.map((i) => i.rule).sort(), ['opened_no_reply', 'unopened']); // cooldown over
});

test('only the latest email per contact is considered, and other owners are invisible', async () => {
  await thread('a@x.com', daysBefore(10), 'Old');
  await thread('a@x.com', daysBefore(1), 'New');
  const other = new mongoose.Types.ObjectId();
  const oc = await ensureContact(other, 'z@x.com');
  await Email.create({ senderId: other, contactId: oc._id, from: 'o@gmail.com', to: 'z@x.com', subject: 'Theirs', htmlBody: '', textBody: '', trackingToken: 'tok-other', status: 'delivered', events: [], createdAt: daysBefore(9) });

  const items = await buildQueue(owner, { now: NOW });
  assert.equal(items.length, 0); // "New" is only a day old; "Old" is not nagged about separately
  const later = await buildQueue(owner, { now: new Date(NOW.getTime() + 3 * DAY) });
  assert.deepEqual(later.map((i) => i.email!.subject), ['New']);
});
