import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import app from '../app';
import { Email } from '../models/Email';
import { Signal } from '../models/Signal';
import { ensureContact } from '../services/signalService';
import { rewriteLinks } from '../services/emailService';
import { invalidateRuleCache, classifyWith, SEED_RULES, compileRule, labelSignal } from '../services/classifierService';
import { IFingerprintRule } from '../models/FingerprintRule';

// Link clicks as a second signal type: links rewritten on the way out,
// the redirect records a click with a verdict from the same classifier
// (delivery-time link scanners are the false positive here), the stored
// body untouched, and human labels on clicks like on opens.

const owner = new mongoose.Types.ObjectId();
let server: http.Server;
let base: string;

before(async () => {
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => { await resetTestDb(); invalidateRuleCache(); });
after(async () => { await new Promise<void>((r) => server.close(() => r())); await disconnectTestDb(); });

test('rewriteLinks: http(s) anchors go through the redirect, deduped by url; share links, mailto and anchors stay; the stored body is untouched', () => {
  const html = '<p>See <a href="https://example.com/pricing">pricing</a> and <a href="https://example.com/pricing">again</a>, <a href="http://docs.example.com/a?b=1">docs</a>, <a href="mailto:x@y.com">mail</a>, <a href="#top">top</a>, <a href="https://mt.example/share/abc?via=tok-1">deck</a>.</p>';
  const r = rewriteLinks(html, 'tok-1', 'https://mt.example/');
  assert.deepEqual(r.links, [{ linkId: 'l1', originalUrl: 'https://example.com/pricing' }, { linkId: 'l2', originalUrl: 'http://docs.example.com/a?b=1' }]);
  assert.equal((r.html.match(/https:\/\/mt\.example\/api\/track\/tok-1\/l\/l1/g) ?? []).length, 2);
  assert.match(r.html, /api\/track\/tok-1\/l\/l2/);
  assert.match(r.html, /href="mailto:x@y\.com"/);
  assert.match(r.html, /href="#top"/);
  assert.match(r.html, /href="https:\/\/mt\.example\/share\/abc\?via=tok-1"/);
  assert.doesNotMatch(r.html, /href="https:\/\/example\.com\/pricing"/);
  assert.deepEqual(rewriteLinks('<p>no links</p>', 't', 'https://x'), { html: '<p>no links</p>', links: [] });
  assert.deepEqual(rewriteLinks('', 't', 'https://x'), { html: '', links: [] });
});

test('the redirect records a click signal with a verdict and redirects; a delivery-time fetch is automated; unknown links 404; labels apply to clicks', async () => {
  const contact = await ensureContact(owner, 'priya@example.com');
  const sentAt = new Date(Date.now() - 60_000);
  const email = await Email.create({
    senderId: owner, contactId: contact._id, from: 'me@gmail.com', to: 'priya@example.com', subject: 'S', htmlBody: '<a href="https://example.com/pricing">p</a>', textBody: 'p',
    trackingToken: 'tok-click', status: 'delivered', createdAt: sentAt, trackedLinks: [{ linkId: 'l1', originalUrl: 'https://example.com/pricing', clickCount: 0 }],
  });

  // A person clicks a minute after delivery.
  const res = await fetch(`${base}/api/track/tok-click/l/l1`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/120 Safari/537.36' } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.com/pricing');
  await new Promise((r) => setTimeout(r, 150));
  let e = (await Email.findById(email._id))!;
  assert.equal(e.clickCount, 1);
  assert.equal(e.trackedLinks[0].clickCount, 1);
  assert.equal(e.events.at(-1)!.type, 'clicked');
  assert.equal(e.events.at(-1)!.linkId, 'l1');
  assert.equal(e.events.at(-1)!.automated, false);
  const human = (await Signal.findOne({ emailId: email._id, type: 'link_click' }))!;
  assert.equal(human.integrity.verdict, 'human');
  assert.equal(human.source, 'redirect');
  assert.equal((human.payload as { url: string }).url, 'https://example.com/pricing');
  assert.equal(human.contactId.toString(), contact._id.toString());

  // A scanner fetching the link within seconds of delivery is automated: no count, but the signal is stored honestly.
  const fresh = await Email.create({ senderId: owner, contactId: contact._id, from: 'me@gmail.com', to: 'priya@example.com', subject: 'S2', trackingToken: 'tok-fast', status: 'delivered', trackedLinks: [{ linkId: 'l1', originalUrl: 'https://example.com/x', clickCount: 0 }] });
  const fast = await fetch(`${base}/api/track/tok-fast/l/l1`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
  assert.equal(fast.status, 302);
  await new Promise((r) => setTimeout(r, 150));
  e = (await Email.findById(fresh._id))!;
  assert.equal(e.clickCount, 0);
  assert.equal(e.events.at(-1)!.automated, true);
  const auto = (await Signal.findOne({ emailId: fresh._id, type: 'link_click' }))!;
  assert.equal(auto.integrity.verdict, 'automated');
  assert.match((auto.payload as { matchedBy: string }).matchedBy, /seed timing_floor_ms:3000/);

  // The seed floor applies per signal type: the open floor does not decide a click and vice versa.
  const rules = SEED_RULES.map((r) => compileRule(r as IFingerprintRule)!).filter(Boolean);
  assert.equal(classifyWith([], { userAgent: 'x', ip: '', msSinceCreated: 1000, signalType: 'link_click' }).automated, true);
  assert.equal(classifyWith(rules.filter((r) => r.signalType === 'open'), { userAgent: 'x', ip: '', msSinceCreated: 100_000, signalType: 'link_click' }).automated, false);

  // A human label overrides the click verdict, like on opens.
  const relabelled = await labelSignal(owner.toString(), auto._id.toString(), 'human');
  assert.equal(relabelled?.integrity.verdict, 'human');

  assert.equal((await fetch(`${base}/api/track/tok-click/l/nope`, { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${base}/api/track/nope/l/l1`, { redirect: 'manual' })).status, 404);
});
