import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import app from '../app';
import { Email } from '../models/Email';
import { Contact } from '../models/Contact';
import { Signal } from '../models/Signal';
import { DocModel } from '../models/Document';
import { ShareToken } from '../models/ShareToken';
import { ensureContact, recordSignal, onSignal, timeline } from '../services/signalService';
import { renderAttachmentLinks, renderAttachmentText } from '../services/emailService';

// The substrate: every observation becomes one Signal row, deduped, tied to
// a contact, and attributable back to the email it came from.

const owner = new mongoose.Types.ObjectId();
let server: http.Server;
let base: string;

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => { await resetTestDb(); });
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await disconnectTestDb();
});

async function sentEmail(to = 'priya@example.com', extra: Record<string, unknown> = {}) {
  const contact = await ensureContact(owner, to);
  return Email.create({
    senderId: owner, contactId: contact._id, from: 'me@gmail.com', to, subject: 'Proposal', htmlBody: '<p>Hi</p>', textBody: 'Hi',
    trackingToken: `tok-${Math.random().toString(36).slice(2)}`, status: 'delivered',
    events: [{ type: 'sent', timestamp: new Date(Date.now() - 60_000) }, { type: 'delivered', timestamp: new Date(Date.now() - 59_000) }],
    createdAt: new Date(Date.now() - 60_000),
    ...extra,
  });
}

test('ensureContact is idempotent per owner and case-insensitive; different owners never share', async () => {
  const a = await ensureContact(owner, 'Priya@Example.com');
  const b = await ensureContact(owner, 'priya@example.com');
  assert.equal(a._id.toString(), b._id.toString());
  assert.equal(a.domain, 'example.com');
  const other = await ensureContact(new mongoose.Types.ObjectId(), 'priya@example.com');
  assert.notEqual(other._id.toString(), a._id.toString());
  assert.equal(await Contact.countDocuments(), 2);
});

test('recordSignal dedupes on the key, updates contact stats, and notifies listeners', async () => {
  const contact = await ensureContact(owner, 'priya@example.com');
  const seen: Array<[string, boolean]> = [];
  onSignal((s, isNew) => { seen.push([s.type, isNew]); });

  const first = await recordSignal({ ownerId: owner, contactId: contact._id, type: 'open', verdict: 'human', source: 'pixel', dedupeKey: 'open:x:0' });
  const dup = await recordSignal({ ownerId: owner, contactId: contact._id, type: 'open', verdict: 'human', source: 'pixel', dedupeKey: 'open:x:0' });
  await recordSignal({ ownerId: owner, contactId: contact._id, type: 'open', verdict: 'automated', source: 'pixel', dedupeKey: 'open:x:1' });
  await recordSignal({ ownerId: owner, contactId: contact._id, type: 'sent', source: 'system', dedupeKey: 'sent:x' });

  assert.equal(first.isNew, true);
  assert.equal(dup.isNew, false);
  assert.equal(dup.signal._id.toString(), first.signal._id.toString());
  assert.equal(await Signal.countDocuments(), 3);
  const c = await Contact.findById(contact._id).lean();
  assert.equal(c!.stats.opened, 1); // automated opens do not count
  assert.equal(c!.stats.sent, 1);
  assert.ok(c!.lastSignalAt);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen.map(([t, n]) => `${t}:${n}`), ['open:true', 'open:false', 'open:true', 'sent:true']);

  const tl = await timeline(owner, contact._id);
  assert.deepEqual(tl.map((s) => s.type), ['sent', 'open']); // automated excluded by default
});

test('a pixel hit records an open Signal with the classifier verdict and never delays the pixel', async () => {
  const email = await sentEmail();
  const humanRes = await fetch(`${base}/api/track/${email.trackingToken}/pixel.png`, { headers: { 'User-Agent': 'Mozilla/5.0 (real browser)' } });
  assert.equal(humanRes.status, 200);
  assert.equal(humanRes.headers.get('content-type'), 'image/png');
  const scanRes = await fetch(`${base}/api/track/${email.trackingToken}/pixel.png`, { headers: { 'User-Agent': 'Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0' } });
  assert.equal(scanRes.status, 200);
  await fetch(`${base}/api/track/unknown-token/pixel.png`);

  await new Promise((r) => setTimeout(r, 150)); // the signal write is fire-and-forget after the pixel
  const signals = await Signal.find({ emailId: email._id, type: 'open' }).sort({ at: 1 }).lean();
  assert.equal(signals.length, 2);
  assert.equal(signals[0].integrity.verdict, 'human');
  assert.equal(signals[0].dedupeKey, `open:${email._id}:2`);
  assert.equal(signals[1].integrity.verdict, 'automated');
  assert.equal((signals[0].payload as { userAgent: string }).userAgent, 'Mozilla/5.0 (real browser)');
  const updated = await Email.findById(email._id).lean();
  assert.equal(updated!.openCount, 1);
});

test('outgoing bodies carry attachment links attributed with ?via=<trackingToken>', () => {
  const attachments = [{ name: 'Proposal <v2>.pdf', shareUrl: 'https://app.example.com/share/abc123' }];
  const html = renderAttachmentLinks('<div>Hi Priya</div>', attachments, 'tok-1');
  assert.match(html, /href="https:\/\/app\.example\.com\/share\/abc123\?via=tok-1"/);
  assert.match(html, /Proposal &lt;v2&gt;\.pdf/);
  assert.match(html, /Hi Priya/);
  const text = renderAttachmentText('Hi Priya', attachments, 'tok-1');
  assert.match(text, /Proposal <v2>\.pdf: https:\/\/app\.example\.com\/share\/abc123\?via=tok-1/);
  assert.equal(renderAttachmentLinks('<p>x</p>', [], 'tok'), '<p>x</p>');
});

test('a share view with ?via is attributed to the email and contact; dwell accumulates on one signal', async () => {
  const email = await sentEmail();
  const doc = await DocModel.create({ ownerId: owner, originalName: 'Proposal.pdf', storedName: 'x.pdf', mimeType: 'application/pdf', size: 10 });
  const share = await ShareToken.create({ token: 'share-1', documentId: doc._id });

  // Anonymous open: a view, but no attribution and no signal.
  const anon = await fetch(`${base}/api/share/${share.token}/access`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(anon.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await Signal.countDocuments({ type: 'doc_view' }), 0);

  // Attributed open.
  const res = await fetch(`${base}/api/share/${share.token}/access`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ via: email.trackingToken }) });
  assert.equal(res.status, 200);
  const { viewToken } = await res.json() as { viewToken: string };
  await new Promise((r) => setTimeout(r, 50));
  const view = await Signal.findOne({ type: 'doc_view' }).lean();
  assert.ok(view);
  assert.equal(view!.emailId!.toString(), email._id.toString());
  assert.equal(view!.contactId.toString(), email.contactId!.toString());
  const stored = await DocModel.findById(doc._id).lean();
  assert.equal(stored!.views.length, 2);
  assert.equal(stored!.views[1].viaEmailId!.toString(), email._id.toString());
  assert.equal(stored!.views[0].viaEmailId, undefined);

  // Dwell: two reports merge (max per page), capped, bad rows dropped.
  const d1 = await fetch(`${base}/api/share/${share.token}/dwell`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vt: viewToken, pages: [{ page: 1, seconds: 12 }, { page: 4, seconds: 90 }, { page: 0, seconds: 5 }, { page: 2, seconds: -1 }] }) });
  assert.equal(d1.status, 204);
  const d2 = await fetch(`${base}/api/share/${share.token}/dwell`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vt: viewToken, pages: [{ page: 1, seconds: 20 }, { page: 4, seconds: 30 }, { page: 5, seconds: 9999 }] }) });
  assert.equal(d2.status, 204);

  const after = await DocModel.findById(doc._id).lean();
  assert.deepEqual(after!.views[1].pageDwell, [{ page: 1, seconds: 20 }, { page: 4, seconds: 90 }, { page: 5, seconds: 300 }]);
  const dwell = await Signal.find({ type: 'page_dwell' }).lean();
  assert.equal(dwell.length, 1);
  const p = dwell[0].payload as { totalSeconds: number; topPage: number; topSeconds: number; documentName: string };
  assert.equal(p.totalSeconds, 410);
  assert.equal(p.topPage, 5);
  assert.equal(p.documentName, 'Proposal.pdf');

  // A bad view token, or a token for another share, is rejected.
  const badVt = jwt.sign({ documentId: doc._id.toString(), shareToken: 'other', viewId: 'v' }, process.env.JWT_SECRET!);
  assert.equal((await fetch(`${base}/api/share/${share.token}/dwell`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vt: badVt, pages: [{ page: 1, seconds: 1 }] }) })).status, 403);
  assert.equal((await fetch(`${base}/api/share/${share.token}/dwell`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vt: 'garbage', pages: [] }) })).status, 401);
});
