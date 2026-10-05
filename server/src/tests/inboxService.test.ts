import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { fakeGmail, gmailMessage, FakeGmail } from './helpers/fakeGmail';
import { __setGmailClientFactoryForTests } from '../services/gmailClient';
import { User, IUser } from '../models/User';
import { Email } from '../models/Email';
import { Contact } from '../models/Contact';
import { InboundMessage } from '../models/InboundMessage';
import { encryptSecret } from '../utils/secrets';
import {
  parseGmailMessage, stripQuotedReply, htmlToText, parseAddress, matchTrackedEmail, ingestMessage, syncInbox, inboxStatus,
  revokeGmailReadGrant, setInboxSyncEnabled, buildGoogleReadAuthUrl, READ_SCOPE, setInboxInitial, backfillInbox,
} from '../services/inboxService';
import { rfcMessageIdFor } from '../services/gmailService';

// Reading mail without a model: parsing (plain preferred, html fallback,
// quotes stripped), the three reply anchors, idempotent ingestion, the
// bounded initial sync, incremental history with a per-run cap, the 404
// fallback, the lock, and revocation. Gmail is an in-memory fake.

const owner = new mongoose.Types.ObjectId();
const TOKEN = '4a7c1b1e-9f2d-4c33-8a1e-0b6d2f9c1a55';
let gmail: FakeGmail;

before(async () => {
  process.env.AI_KEY_ENCRYPTION_SECRET = process.env.AI_KEY_ENCRYPTION_SECRET || 'test-secret-for-tokens';
  process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'client-id';
  process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/auth/google/callback';
  await connectTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  gmail = fakeGmail('me@gmail.com');
  __setGmailClientFactoryForTests(() => gmail);
  await User.create({
    _id: owner, name: 'Me', email: 'me@example.com', emailAddress: 'me@example.com', password: 'x', gmailAddress: 'me@gmail.com',
    gmailRead: { address: 'me@gmail.com', refreshToken: encryptSecret('refresh'), accessToken: encryptSecret('access'), tokenExpiry: new Date(Date.now() + 3_600_000), scope: READ_SCOPE, grantedAt: new Date(), syncEnabled: true, historyId: '1000', initialSyncDone: false },
  });
});
after(async () => { __setGmailClientFactoryForTests(null); await disconnectTestDb(); });

test('parsing: addresses, plain over html, html to text, quoted replies and signatures stripped, header facts', () => {
  assert.deepEqual(parseAddress('"Priya Sharma" <Priya@Example.com>'), { address: 'priya@example.com', name: 'Priya Sharma' });
  assert.deepEqual(parseAddress('priya@example.com'), { address: 'priya@example.com' });

  const reply = ['Thanks, Thursday works.', '', 'Best,', 'Priya', '-- ', 'Priya Sharma | Acme', '', 'On Tue, 23 Sep 2026 at 10:00, Me <me@gmail.com>', 'wrote:', '> the original', '> text'].join('\n');
  assert.equal(stripQuotedReply(reply), 'Thanks, Thursday works.\n\nBest,\nPriya');
  assert.equal(stripQuotedReply('Sure.\n\n-----Original Message-----\nFrom: x\nSent: y\n\nold'), 'Sure.');
  assert.equal(stripQuotedReply('Sure.\n\nFrom: Someone <s@x.com>\nSent: Monday\n\nold'), 'Sure.');
  assert.equal(stripQuotedReply('No quote here\n> except trailing\n>'), 'No quote here');
  assert.equal(htmlToText('<html><head><style>p{}</style></head><body><p>Hi <b>there</b></p><div>Line two<br>Line three</div></body></html>'), 'Hi there\nLine two\nLine three');

  const both = parseGmailMessage(gmailMessage({ id: 'a', from: 'A <a@x.com>', to: 'me@gmail.com, other@x.com', subject: '  Hello ', text: 'plain wins', html: '<p>html loses</p>', headers: { 'List-Unsubscribe': '<mailto:u@x.com>', 'List-Id': '<news.x.com>', Precedence: 'bulk', 'In-Reply-To': '<r@x>', References: '<a@x> <b@x>' }, attachment: 'deck.pdf', calendar: true }));
  assert.equal(both.text, 'plain wins');
  assert.equal(both.subject, 'Hello');
  assert.deepEqual(both.to, ['me@gmail.com', 'other@x.com']);
  assert.deepEqual(both.from, { address: 'a@x.com', name: 'A' });
  assert.equal(both.headers.listUnsubscribe, true);
  assert.equal(both.headers.listId, '<news.x.com>');
  assert.equal(both.headers.precedence, 'bulk');
  assert.equal(both.headers.inReplyTo, '<r@x>');
  assert.deepEqual(both.headers.references, ['<a@x>', '<b@x>']);
  assert.equal(both.headers.hasAttachments, true);
  assert.equal(both.headers.hasCalendarPart, true);
  assert.equal(both.headers.messageId, '<a@mail.example>');

  const htmlOnly = parseGmailMessage(gmailMessage({ id: 'b', from: 'b@x.com', html: '<div>Only html<br>here</div>', headers: { 'X-Autoreply': 'yes' } }));
  assert.equal(htmlOnly.text, 'Only html\nhere');
  assert.equal(htmlOnly.headers.autoSubmitted, 'auto-replied');
  assert.equal(htmlOnly.headers.hasAttachments, false);

  const long = parseGmailMessage(gmailMessage({ id: 'c', from: 'c@x.com', text: 'x'.repeat(5000) }));
  assert.equal(long.text.length, 1500);
});

test('matching: thread id, then our Message-ID in In-Reply-To/References, then the pixel URL; nothing otherwise', async () => {
  const contact = await Contact.create({ ownerId: owner, address: 'priya@example.com', domain: 'example.com' });
  const tracked = await Email.create({ senderId: owner, contactId: contact._id, from: 'me@gmail.com', to: 'priya@example.com', subject: 'Proposal', trackingToken: TOKEN, gmailThreadId: 'thread-1', rfcMessageId: rfcMessageIdFor(TOKEN, 'me@gmail.com'), direction: 'outbound' });
  const base = { headers: { references: [] as string[], listUnsubscribe: false, hasCalendarPart: false, hasAttachments: false }, text: '' };

  const byThread = await matchTrackedEmail(owner, { ...base, gmailThreadId: 'thread-1' });
  assert.equal(byThread?.matchedBy, 'thread');
  assert.equal(byThread?.emailId.toString(), tracked._id.toString());
  assert.equal(byThread?.contactId?.toString(), contact._id.toString());

  const byId = await matchTrackedEmail(owner, { ...base, gmailThreadId: 'other', headers: { ...base.headers, references: ['<x@y>', rfcMessageIdFor(TOKEN, 'me@gmail.com')] } });
  assert.equal(byId?.matchedBy, 'message_id');

  const byPixel = await matchTrackedEmail(owner, { ...base, gmailThreadId: 'other', text: `> <img src="https://t.example/api/track/${TOKEN}/pixel.png">` });
  assert.equal(byPixel?.matchedBy, 'pixel_url');

  assert.equal(await matchTrackedEmail(owner, { ...base, gmailThreadId: 'other' }), null);
  // Another owner's tracked mail never matches.
  assert.equal(await matchTrackedEmail(new mongoose.Types.ObjectId(), { ...base, gmailThreadId: 'thread-1' }), null);
});

test('ingest: idempotent, skips own mail and non-INBOX, stores the match', async () => {
  await Email.create({ senderId: owner, from: 'me@gmail.com', to: 'p@x.com', subject: 'S', trackingToken: TOKEN, gmailThreadId: 'thread-1', direction: 'outbound' });
  const reply = gmailMessage({ id: 'm1', threadId: 'thread-1', from: 'P <p@x.com>', subject: 'Re: S', text: 'Yes.' });
  const first = await ingestMessage(owner, 'me@gmail.com', reply);
  assert.equal(first.created, true);
  const second = await ingestMessage(owner, 'me@gmail.com', reply);
  assert.deepEqual(second, { id: first.id, created: false });
  const row = (await InboundMessage.findById(first.id))!;
  assert.equal(row.matchedBy, 'thread');
  assert.equal(row.textExcerpt, 'Yes.');
  assert.equal(row.triage.status, 'unclassified');

  assert.deepEqual(await ingestMessage(owner, 'me@gmail.com', gmailMessage({ id: 'm2', from: 'Me <ME@gmail.com>', text: 'note to self' })), { created: false, skipped: 'own_mail' });
  assert.deepEqual(await ingestMessage(owner, 'me@gmail.com', gmailMessage({ id: 'm3', from: 'x@x.com', text: 'sent', labelIds: ['SENT'] })), { created: false, skipped: 'not_inbox' });
  assert.deepEqual(await ingestMessage(owner, 'me@gmail.com', gmailMessage({ id: 'm4', from: 'x@x.com', text: 'spam', labelIds: ['INBOX', 'SPAM'] })), { created: false, skipped: 'not_inbox' });
  assert.equal(await InboundMessage.countDocuments({ ownerId: owner }), 1);
});

test('initial sync is bounded to recent INBOX mail and a cap; then history is incremental with a per-run cap', async () => {
  process.env.INBOX_INITIAL_MAX = '3';
  process.env.INBOX_SYNC_MAX_PER_RUN = '2';
  try {
    const day = 86_400_000;
    for (let i = 0; i < 5; i++) gmail.add({ id: `old${i}`, from: `s${i}@x.com`, text: `mail ${i}`, internalDate: Date.now() - i * day }, { history: false });
    gmail.add({ id: 'ancient', from: 'a@x.com', text: 'too old', internalDate: Date.now() - 60 * day }, { history: false });
    gmail.add({ id: 'sent', from: 'x@x.com', text: 'sent', labelIds: ['SENT'] }, { history: false });

    const first = await syncInbox(owner.toString(), { trigger: 'user' });
    assert.equal(first.mode, 'initial');
    assert.equal(first.error, undefined);
    assert.equal(first.created, 3);
    assert.equal(first.capped, true);
    assert.equal(first.newIds.length, 3);
    const list = gmail.calls.find((c) => c.method === 'listMessages')!.args as { q: string; labelIds: string[] };
    assert.match(list.q, /newer_than:30d/);
    assert.deepEqual(list.labelIds, ['INBOX']);
    let u: IUser = (await User.findById(owner).select('gmailRead'))!;
    assert.equal(u.gmailRead!.initialSyncDone, true);
    assert.equal(u.gmailRead!.historyId, '1000');
    assert.ok(u.gmailRead!.lastSyncAt);
    assert.equal(u.gmailRead!.syncLockUntil!.getTime(), 0);

    // Nothing new: a history call, no fetches, historyId advances to the mailbox's.
    gmail.calls = [];
    const quiet = await syncInbox(owner.toString());
    assert.equal(quiet.mode, 'history');
    assert.equal(quiet.fetched, 0);
    assert.equal(gmail.calls.filter((c) => c.method === 'getMessage').length, 0);

    // Three arrive; the cap is two per run, and the historyId only moves past what was stored.
    gmail.add({ id: 'n1', from: 'n1@x.com', text: 'new 1' });
    gmail.add({ id: 'n2', from: 'n2@x.com', text: 'new 2' });
    gmail.add({ id: 'n3', from: 'n3@x.com', text: 'new 3' });
    const capped = await syncInbox(owner.toString());
    assert.equal(capped.created, 2);
    assert.equal(capped.capped, true);
    u = (await User.findById(owner).select('gmailRead'))!;
    assert.equal(u.gmailRead!.historyId, gmail.history[1].id);
    const rest = await syncInbox(owner.toString());
    assert.equal(rest.created, 1);
    assert.equal(rest.capped, false);
    assert.equal((await User.findById(owner).select('gmailRead'))!.gmailRead!.historyId, gmail.profile.historyId);
    assert.equal(await InboundMessage.countDocuments({ ownerId: owner }), 6);

    // A message deleted between history and fetch is skipped, not fatal.
    gmail.add({ id: 'gone', from: 'g@x.com', text: 'gone' });
    gmail.messages.delete('gone');
    const skipped = await syncInbox(owner.toString());
    assert.equal(skipped.error, undefined);
    assert.equal(skipped.created, 0);
  } finally {
    delete process.env.INBOX_INITIAL_MAX;
    delete process.env.INBOX_SYNC_MAX_PER_RUN;
  }
});

test('the pull window is the owner\'s choice, clamped; the initial sync honours it and a backfill re-lists it with stored rows deduped', async () => {
  // Stored per owner, clamped to the bounds, null resets to the default.
  assert.deepEqual(await setInboxInitial(owner.toString(), { days: 7, max: 2 }), { days: 7, max: 2 });
  assert.deepEqual(await setInboxInitial(owner.toString(), { days: 9999, max: -5 }), { days: 365, max: 1 });
  assert.deepEqual(await setInboxInitial(owner.toString(), { days: null, max: 2 }), { days: 30, max: 2 });
  assert.deepEqual((await inboxStatus(owner.toString())).initial.days, 30);

  const day = 86_400_000;
  for (let i = 0; i < 4; i++) gmail.add({ id: `m${i}`, from: `s${i}@x.com`, text: `mail ${i}`, internalDate: Date.now() - i * day }, { history: false });

  // The initial sync reads the stored window, not the env default.
  const first = await syncInbox(owner.toString(), { trigger: 'user' });
  assert.equal(first.mode, 'initial');
  assert.equal(first.error, undefined);
  assert.equal(first.created, 2);
  assert.equal(first.capped, true);
  assert.match((gmail.calls.find((c) => c.method === 'listMessages')!.args as { q: string }).q, /newer_than:30d/);

  // A backfill over a wider window picks up what the cap left out; what is
  // already stored dedupes to nothing, so repeating is free of duplicates.
  const back = await backfillInbox(owner.toString(), { days: 60, max: 10 });
  assert.equal(back.mode, 'backfill');
  assert.equal(back.error, undefined);
  assert.equal(back.fetched, 4);
  assert.equal(back.created, 2);
  assert.equal(back.capped, false);
  assert.equal(await InboundMessage.countDocuments({ ownerId: owner }), 4);
  const again = await backfillInbox(owner.toString(), { days: 60, max: 10 });
  assert.equal(again.created, 0);

  // The history cursor was untouched, and a paused grant refuses to pull.
  assert.equal((await User.findById(owner).select('gmailRead'))!.gmailRead!.historyId, '1000');
  await setInboxSyncEnabled(owner.toString(), false);
  assert.equal((await backfillInbox(owner.toString(), {})).skipped, 'disabled');
});

test('an expired historyId (404) falls back to a bounded re-list since the last sync and restarts history from now', async () => {
  await User.updateOne({ _id: owner }, { $set: { 'gmailRead.initialSyncDone': true, 'gmailRead.lastSyncAt': new Date(Date.now() - 3_600_000) } });
  gmail.add({ id: 'recent', from: 'r@x.com', text: 'recent', internalDate: Date.now() - 600_000 });
  gmail.add({ id: 'older', from: 'o@x.com', text: 'older', internalDate: Date.now() - 7_200_000 });
  gmail.historyStatus = 404;
  const r = await syncInbox(owner.toString());
  assert.equal(r.mode, 'relist');
  assert.equal(r.error, undefined);
  assert.equal(r.created, 1);
  const list = gmail.calls.filter((c) => c.method === 'listMessages').at(-1)!.args as { q: string };
  assert.match(list.q, /after:\d+/);
  assert.equal((await User.findById(owner).select('gmailRead'))!.gmailRead!.historyId, gmail.profile.historyId);

  // Other errors are recorded on the grant and the lock is released.
  gmail.historyStatus = 500;
  const bad = await syncInbox(owner.toString());
  assert.match(bad.error!, /history unavailable/);
  const u = (await User.findById(owner).select('gmailRead'))!;
  assert.match(u.gmailRead!.lastSyncError!, /history unavailable/);
  assert.equal(u.gmailRead!.syncLockUntil!.getTime(), 0);
});

test('the lock, the switch, status, revocation, and the consent URL', async () => {
  await User.updateOne({ _id: owner }, { $set: { 'gmailRead.syncLockUntil': new Date(Date.now() + 60_000) } });
  assert.equal((await syncInbox(owner.toString())).skipped, 'locked');
  await User.updateOne({ _id: owner }, { $set: { 'gmailRead.syncLockUntil': new Date(0) } });

  assert.equal(await setInboxSyncEnabled(owner.toString(), false), true);
  assert.equal((await syncInbox(owner.toString())).skipped, 'disabled');
  await setInboxSyncEnabled(owner.toString(), true);
  assert.equal((await syncInbox(new mongoose.Types.ObjectId().toString())).skipped, 'not_connected');

  gmail.add({ id: 'p1', from: 'p@x.com', text: 'hi' }, { history: false });
  await syncInbox(owner.toString());
  const st = await inboxStatus(owner.toString());
  assert.equal(st.connected, true);
  assert.equal(st.address, 'me@gmail.com');
  assert.deepEqual(st.counts, { total: 1, unclassified: 1, awaiting: 0, processed: 0 });

  // A promoted row survives revocation; the rest are deleted with the grant.
  const promoted = await InboundMessage.create({ ownerId: owner, gmailMessageId: 'kept', gmailThreadId: 't', internalDate: new Date(), from: { address: 'k@x.com' }, subject: 'kept', emailId: new mongoose.Types.ObjectId() });
  const rev = await revokeGmailReadGrant(owner.toString());
  assert.deepEqual(rev, { revoked: true, deletedMessages: 1 });
  assert.equal((await User.findById(owner))!.gmailRead, undefined);
  assert.equal(await InboundMessage.countDocuments({ ownerId: owner }), 1);
  assert.ok(await InboundMessage.exists({ _id: promoted._id }));
  assert.equal((await inboxStatus(owner.toString())).connected, false);
  assert.deepEqual(await revokeGmailReadGrant(owner.toString()), { revoked: false, deletedMessages: 0 });

  const url = new URL(buildGoogleReadAuthUrl('state-jwt'));
  assert.equal(url.searchParams.get('scope'), READ_SCOPE);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5000/api/auth/google/read/callback');
  assert.equal(url.searchParams.get('prompt'), 'consent');
});
