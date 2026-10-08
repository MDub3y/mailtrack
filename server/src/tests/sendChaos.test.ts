import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { User } from '../models/User';
import { Email } from '../models/Email';
import {
  processSingleSend, processBulkSend, __setDispatcherForTests, __setKillPointForTests, JobLike, SingleEmailJob, BulkEmailJob,
} from '../queues/emailQueue';

// Exactly-once under crashes. The worker is "killed" at labelled points via
// the chaos seam, then the job is re-run the way BullMQ redelivery would.
// The invariant: across any single crash-and-retry, the provider is called
// AT MOST once per recipient, and every recipient ends in a definite state
// (delivered, failed, or failed-with-outcome-unknown) — never silently
// duplicated, never silently lost.

const owner = new mongoose.Types.ObjectId();
let dispatchCalls: Array<{ to: string; trackingToken: string }> = [];

const fakeDispatcher = async (_senderId: string, params: { to: string; trackingToken?: string }) => {
  dispatchCalls.push({ to: params.to, trackingToken: params.trackingToken ?? '' });
  return { providerMessageId: `prov-${dispatchCalls.length}`, rfcMessageId: `<rfc-${dispatchCalls.length}@proofbox.local>` };
};

before(async () => {
  await connectTestDb();
  process.env.AI_QUEUE_DISABLED = 'true';
});
beforeEach(async () => {
  await resetTestDb();
  dispatchCalls = [];
  __setKillPointForTests(null);
  __setDispatcherForTests(fakeDispatcher);
  await User.create({ _id: owner, name: 'S', email: 's@example.com', emailAddress: 's@example.com', password: 'x' });
});
after(async () => { __setDispatcherForTests(null); __setKillPointForTests(null); await disconnectTestDb(); });

const singleJob = (emailId: string): JobLike<SingleEmailJob> => ({ data: { emailId }, id: 'job-1', updateProgress: async () => {} });
const bulkJob = (recipients: string[]): JobLike<BulkEmailJob> => ({
  data: { senderId: owner.toString(), senderEmailAddress: 's@example.com', recipients, subject: 'Hi', htmlBody: '<p>Hi</p>', textBody: 'Hi' },
  id: 'bulk-1',
  updateProgress: async () => {},
});

async function freshEmail(): Promise<string> {
  const e = await Email.create({
    senderId: owner, from: 's@example.com', to: 'r@example.com', subject: 'Hi', htmlBody: '<p>Hi</p>', textBody: 'Hi',
    trackingToken: `tok-${Math.random().toString(36).slice(2)}`, status: 'sent', events: [{ type: 'sent', timestamp: new Date() }],
  });
  return e._id.toString();
}

async function crashThenRetry(run: () => Promise<unknown>, point: string): Promise<void> {
  __setKillPointForTests(point);
  await assert.rejects(run, /chaos/);
  await run(); // the redelivery
}

// ---- single sends: five kill points ----------------------------------------

test('kill 1 — after load, before any work: retry delivers, one dispatch', async () => {
  const id = await freshEmail();
  await crashThenRetry(() => processSingleSend(singleJob(id)), 'single:loaded');
  assert.equal(dispatchCalls.length, 1);
  assert.equal((await Email.findById(id))!.status, 'delivered');
});

test('kill 2 — after contact attach: retry delivers, one dispatch', async () => {
  const id = await freshEmail();
  await crashThenRetry(() => processSingleSend(singleJob(id)), 'single:contact');
  assert.equal(dispatchCalls.length, 1);
  assert.equal((await Email.findById(id))!.status, 'delivered');
});

test('kill 3 — before the claim is written: retry delivers, one dispatch', async () => {
  const id = await freshEmail();
  await crashThenRetry(() => processSingleSend(singleJob(id)), 'single:before_claim');
  assert.equal(dispatchCalls.length, 1);
  assert.equal((await Email.findById(id))!.status, 'delivered');
});

test('kill 4 — after dispatch, before the delivered record: never re-sent; surfaced as outcome-unknown', async () => {
  const id = await freshEmail();
  await crashThenRetry(() => processSingleSend(singleJob(id)), 'single:after_dispatch');
  assert.equal(dispatchCalls.length, 1); // the crucial one: no duplicate send
  const email = (await Email.findById(id))!;
  assert.equal(email.status, 'failed');
  assert.match(email.failureReason!, /outcome unknown/);
});

test('kill 5 — after delivered: retry is a no-op, one dispatch', async () => {
  const id = await freshEmail();
  await crashThenRetry(() => processSingleSend(singleJob(id)), 'single:after_delivered');
  assert.equal(dispatchCalls.length, 1);
  assert.equal((await Email.findById(id))!.status, 'delivered');
});

test('a clean provider error clears the claim, so a later retry may send (and sends once)', async () => {
  const id = await freshEmail();
  let first = true;
  __setDispatcherForTests(async (s, p) => {
    if (first) { first = false; throw new Error('provider 500'); }
    return fakeDispatcher(s, p as never);
  });
  await assert.rejects(() => processSingleSend(singleJob(id)), /provider 500/);
  await processSingleSend(singleJob(id)); // BullMQ retry
  assert.equal(dispatchCalls.length, 1);
  assert.equal((await Email.findById(id))!.status, 'delivered');
});

// ---- bulk sends: three kill points ------------------------------------------

test('kill 6 — bulk crash after creating a recipient record: retry resumes, each address dispatched once', async () => {
  const job = bulkJob(['a@example.com', 'b@example.com', 'c@example.com']);
  __setKillPointForTests('bulk:after_create'); // fires on the first recipient
  await assert.rejects(() => processBulkSend(job), /chaos/);
  const result = await processBulkSend(job);
  assert.equal(result.sent, 3);
  assert.deepEqual(dispatchCalls.map((c) => c.to).sort(), ['a@example.com', 'b@example.com', 'c@example.com']);
  assert.equal(await Email.countDocuments({ senderId: owner, to: 'a@example.com' }), 1); // no duplicate record either
});

test('kill 7 — bulk crash after a dispatch, before its delivered record: that recipient is outcome-unknown, the rest deliver, nobody twice', async () => {
  const job = bulkJob(['a@example.com', 'b@example.com', 'c@example.com']);
  __setKillPointForTests('bulk:after_dispatch'); // fires on the first dispatch
  await assert.rejects(() => processBulkSend(job), /chaos/);
  const result = await processBulkSend(job);
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 1);
  const counts = new Map<string, number>();
  for (const c of dispatchCalls) counts.set(c.to, (counts.get(c.to) ?? 0) + 1);
  for (const [, n] of counts) assert.equal(n, 1); // at most one provider call per address
  const a = (await Email.findOne({ senderId: owner, to: 'a@example.com' }))!;
  assert.equal(a.status, 'failed');
  assert.match(a.failureReason!, /outcome unknown/);
});

test('kill 8 — redelivery of a fully completed bulk job sends nothing new', async () => {
  const job = bulkJob(['a@example.com', 'b@example.com']);
  const first = await processBulkSend(job);
  assert.equal(first.sent, 2);
  const again = await processBulkSend(job); // BullMQ at-least-once redelivery
  assert.equal(again.sent, 2);
  assert.equal(dispatchCalls.length, 2); // still two, not four
});
