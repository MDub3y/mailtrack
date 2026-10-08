import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import app from '../app';
import { User } from '../models/User';
import { Email } from '../models/Email';
import { Contact } from '../models/Contact';
import { Memory } from '../models/Memory';
import { ensureContact, recordSignal } from '../services/signalService';
import { renderContactMarkdown, renderAllContactsMarkdown } from '../services/exportService';

// Memory that can leave: a markdown file per contact with the brief, every
// active item and its source, and the human-verdict timeline. No bodies.

const owner = new mongoose.Types.ObjectId();
const stranger = new mongoose.Types.ObjectId();
let server: http.Server;
let base: string;
const tokenFor = (id: mongoose.Types.ObjectId) => jwt.sign({ userId: id.toString() }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
  await resetTestDb();
  await User.create({ _id: owner, name: 'Me', email: 'me@example.com', emailAddress: 'me@example.com', password: 'x' });
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); await disconnectTestDb(); });

test('one contact: brief, items with sources and dates, timeline without automated opens or dwell rows, no email bodies', async () => {
  const contact = await ensureContact(owner, 'priya@example.com', { displayName: 'Priya' });
  const sent = new Date('2026-09-18T10:00:00Z');
  const email = await Email.create({ senderId: owner, contactId: contact._id, from: 'me@gmail.com', to: 'priya@example.com', subject: 'Proposal for Q4', htmlBody: '<p>the whole secret body</p>', textBody: 'the whole secret body', trackingToken: 'tok-1', createdAt: sent, direction: 'outbound' });
  const reply = await Email.create({ senderId: owner, contactId: contact._id, from: 'priya@example.com', to: 'me@gmail.com', subject: 'Re: Proposal for Q4', textBody: 'Thursday works. I will confirm headcount by Friday. Also here is a secret.', trackingToken: 'inbound:x', status: 'received', direction: 'inbound', createdAt: new Date('2026-09-20T09:00:00Z') });
  await Contact.updateOne({ _id: contact._id }, { $set: { brief: { text: 'Priya is evaluating; asked for a security overview.', citedMemoryIds: [], basedOnSignalCount: 4, generatedAt: new Date('2026-09-21T00:00:00Z'), runId: new mongoose.Types.ObjectId() } } });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'sent', at: sent, verdict: 'human', source: 'system', dedupeKey: 's1' });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'open', at: new Date('2026-09-18T10:00:02Z'), verdict: 'automated', source: 'pixel', dedupeKey: 'o-auto' });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'open', at: new Date('2026-09-19T08:00:00Z'), verdict: 'human', source: 'pixel', dedupeKey: 'o-human' });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'doc_view', at: new Date('2026-09-19T08:05:00Z'), verdict: 'human', source: 'viewer', dedupeKey: 'd1', payload: { documentName: 'Deck.pdf' } });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'page_dwell', at: new Date('2026-09-19T08:06:00Z'), verdict: 'human', source: 'viewer', dedupeKey: 'pd1', payload: { documentName: 'Deck.pdf', totalSeconds: 90 } });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'reply', at: new Date('2026-09-20T09:00:00Z'), verdict: 'human', source: 'gmail', dedupeKey: 'r1', payload: { subject: 'Re: Proposal for Q4' } });
  await recordSignal({ ownerId: owner, contactId: contact._id, type: 'external', at: new Date('2026-09-21T09:00:00Z'), verdict: 'unknown', source: 'webhook', dedupeKey: 'x1', payload: { kind: 'demo_booked' } });
  await Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'commitment', content: 'Priya will confirm headcount by Friday', structured: { by: 'contact', dueAt: '2026-09-25' }, expiresAt: new Date('2026-09-25'), confidence: 0.82, source: 'agent', status: 'active', createdAt: new Date('2026-09-20T09:10:00Z'), evidence: [{ emailId: reply._id, quote: 'I will confirm headcount by Friday' }] });
  await Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'commitment', content: 'Send Priya the security overview', structured: { by: 'sender' }, confidence: 0.9, source: 'agent', status: 'active', createdAt: new Date('2026-09-18T10:05:00Z'), evidence: [{ emailId: email._id, quote: 'I will send the security overview on Monday' }] });
  await Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'preference', content: 'Prefers short emails', confidence: 1, source: 'user', status: 'active', createdAt: new Date('2026-09-19T00:00:00Z'), evidence: [] });
  await Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'fact', content: 'Rejected item', confidence: 0.4, source: 'agent', status: 'rejected', evidence: [] });
  await Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'fact', content: 'Proposed item', confidence: 0.4, source: 'agent', status: 'proposed', evidence: [] });

  const md = (await renderContactMarkdown(owner, contact._id))!;
  assert.match(md, /^# Priya <priya@example.com>\n/);
  assert.match(md, /Sent 1, opened 1, replied 1, document views 1/);
  assert.match(md, /## Brief\n\nPriya is evaluating; asked for a security overview\.\n\n_Written 2026-09-21 from 0 memory items and 4 signals\._/);
  assert.match(md, /## Commitments\n\n- Send Priya the security overview _\(you promised, extracted 2026-09-18, confidence 0\.90\)_\n  - source: your email "Proposal for Q4" \(2026-09-18\): "I will send the security overview on Monday"\n- Priya will confirm headcount by Friday _\(they promised, due 2026-09-25, extracted 2026-09-20, confidence 0\.82\)_\n  - source: their email "Re: Proposal for Q4" \(2026-09-20\): "I will confirm headcount by Friday"/);
  assert.match(md, /## Preferences\n\n- Prefers short emails _\(added by you 2026-09-19\)_/);
  assert.doesNotMatch(md, /Rejected item|Proposed item|secret/);
  assert.match(md, /## Timeline\n\n- 2026-09-21 09:00 UTC: external event \(demo_booked\) _\(unverified\)_\n- 2026-09-20 09:00 UTC: replied \(Re: Proposal for Q4\)\n- 2026-09-19 08:05 UTC: viewed a document \(Deck\.pdf\)\n- 2026-09-19 08:00 UTC: opened\n- 2026-09-18 10:00 UTC: sent\n$/);
  assert.doesNotMatch(md, /10:00:02|read a document/);

  // Routes: download headers, owner scoping, and the all-contacts document.
  const res = await fetch(`${base}/api/contacts/${contact._id}/export.md`, { headers: { Authorization: `Bearer ${tokenFor(owner)}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/markdown/);
  assert.match(res.headers.get('content-disposition')!, /attachment; filename="priya@example.com.md"/);
  assert.equal(await res.text(), md);
  assert.equal((await fetch(`${base}/api/contacts/${contact._id}/export.md`, { headers: { Authorization: `Bearer ${tokenFor(stranger)}` } })).status, 404);
  assert.equal((await fetch(`${base}/api/contacts/${contact._id}/export.md`)).status, 401);

  await ensureContact(owner, 'sam@example.com');
  const all = await renderAllContactsMarkdown(owner);
  assert.match(all, /^# Proofbox memory export\n\n2 contacts, exported/);
  assert.match(all, /\n---\n\n## Priya <priya@example.com>\n/);
  assert.match(all, /### Commitments/);
  assert.match(all, /## sam@example.com\n[\s\S]*_No brief yet\._/);
  const allRes = await fetch(`${base}/api/contacts/export.md`, { headers: { Authorization: `Bearer ${tokenFor(owner)}` } });
  assert.equal(allRes.status, 200);
  assert.match(allRes.headers.get('content-disposition')!, /proofbox-memory-\d{4}-\d{2}-\d{2}\.md/);
});
