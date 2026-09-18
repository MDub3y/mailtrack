import 'dotenv/config';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { connectDB } from '../config/db';
import { User } from '../models/User';
import { Email } from '../models/Email';
import { Contact } from '../models/Contact';
import { Memory } from '../models/Memory';
import { Signal } from '../models/Signal';
import { ensureContact, recordSignal } from '../services/signalService';
import { addUserMemory } from '../ai/memory/policy';
import { recomputeEngagement } from '../ai/memory/engagement';

// Demo data so the queue and the contact pages are demonstrable without
// waiting on real send volume. Everything it creates is tagged
// `source: 'demo'` on signals and `demo: true` on emails, and can be removed
// with `npm run seed:demo -- --clean`. No model calls are made; memory items
// are added as user items so nothing here depends on a provider key.
//
//   npm run seed:demo            (uses the first user in the DB)
//   npm run seed:demo -- --clean

const DAY = 86_400_000;
const daysAgo = (n: number, hours = 0) => new Date(Date.now() - n * DAY - hours * 3_600_000);

interface Scenario {
  address: string;
  name: string;
  subject: string;
  body: string;
  sentDaysAgo: number;
  opens: Array<[number, number?]>;           // [daysAgo, hoursAgo?]
  automatedOpens?: number[];
  doc?: { name: string; daysAgo: number; totalSeconds: number; topPage: number };
  reply?: number;
  memory?: Array<{ kind: 'fact' | 'commitment' | 'preference'; content: string; structured?: Record<string, unknown> }>;
}

const SCENARIOS: Scenario[] = [
  {
    address: 'priya.n@northwind-demo.com', name: 'Priya Natarajan', subject: 'Revised quote for the Q4 rollout',
    body: "Hi Priya,\n\nThanks for the call. I'll send the revised quote by Friday. You mentioned you're evaluating vendors for a Q4 rollout, so I've attached the security overview too.\n\nBest,\nSam",
    sentDaysAgo: 4, opens: [[3, 2], [1, 5], [0, 3]], automatedOpens: [4],
    doc: { name: 'Security overview.pdf', daysAgo: 1, totalSeconds: 245, topPage: 4 },
    memory: [
      { kind: 'commitment', content: 'You promised Priya a revised quote by Friday.', structured: { by: 'sender', dueAt: new Date(Date.now() + 1 * DAY).toISOString().slice(0, 10) } },
      { kind: 'fact', content: 'Priya is evaluating vendors for a Q4 rollout.', structured: { topic: 'evaluation' } },
    ],
  },
  {
    address: 'marcus.l@contoso-demo.io', name: 'Marcus Lee', subject: 'Proposal: platform migration',
    body: "Marcus,\n\nProposal attached as discussed. Happy to walk through the pricing page on a call.\n\nSam",
    sentDaysAgo: 6, opens: [[5, 1]],
  },
  {
    address: 'aisha.k@fabrikam-demo.co', name: 'Aisha Khan', subject: 'Following up on the pilot',
    body: "Hi Aisha,\n\nJust checking whether the pilot numbers landed on your side. You said you'd confirm headcount by the 12th.\n\nSam",
    sentDaysAgo: 20, opens: [[19], [1, 4]],
    memory: [{ kind: 'commitment', content: 'Aisha said she would confirm headcount by the 12th.', structured: { by: 'contact', dueAt: daysAgo(6).toISOString().slice(0, 10) } }],
  },
  {
    address: 'dev.s@lumen-demo.app', name: 'Dev Sharma', subject: 'Case study draft',
    body: "Dev,\n\nDraft case study attached. I'll get you the final numbers next week.\n\nSam",
    sentDaysAgo: 2, opens: [[1, 8]], reply: 1,
    memory: [{ kind: 'preference', content: 'Dev prefers short emails and replies fast to direct questions.', structured: { about: 'style' } }],
  },
  {
    address: 'hello@quiet-demo.org', name: 'Quiet Org', subject: 'Intro from the conference',
    body: 'Hi,\n\nGood to meet you last week. Sharing the deck we discussed.\n\nSam',
    sentDaysAgo: 5, opens: [],
  },
];

async function clean(ownerId: mongoose.Types.ObjectId): Promise<void> {
  const emails = await Email.find({ senderId: ownerId, 'events.0.type': 'sent', htmlBody: /data-demo="true"/ }).select('_id contactId');
  const contactIds = [...new Set(emails.map((e) => e.contactId?.toString()).filter(Boolean))].map((id) => new mongoose.Types.ObjectId(id));
  await Signal.deleteMany({ ownerId, contactId: { $in: contactIds } });
  await Memory.deleteMany({ ownerId, subjectId: { $in: contactIds } });
  await Email.deleteMany({ _id: { $in: emails.map((e) => e._id) } });
  await Contact.deleteMany({ _id: { $in: contactIds } });
  console.log(`removed ${emails.length} demo emails, ${contactIds.length} contacts and their signals/memory`);
}

async function seed(ownerId: mongoose.Types.ObjectId, from: string): Promise<void> {
  for (const s of SCENARIOS) {
    const contact = await ensureContact(ownerId, s.address, { displayName: s.name });
    const sentAt = daysAgo(s.sentDaysAgo);
    const email = await Email.create({
      senderId: ownerId, contactId: contact._id, from, to: s.address, subject: s.subject,
      htmlBody: `<div data-demo="true">${s.body.replace(/\n/g, '<br/>')}</div>`, textBody: s.body,
      trackingToken: uuidv4(), status: s.opens.length ? 'opened' : 'delivered',
      openCount: s.opens.length, firstOpenedAt: s.opens.length ? daysAgo(...s.opens[0]) : undefined,
      events: [{ type: 'sent', timestamp: sentAt }, { type: 'delivered', timestamp: new Date(sentAt.getTime() + 2000) }],
      createdAt: sentAt,
    });
    // Keys match the live paths so a later backfill adds nothing twice:
    // sent/delivered once per email, everything else per occurrence.
    const sig = (type: 'sent' | 'delivered' | 'open' | 'doc_view' | 'page_dwell' | 'reply', at: Date, payload: Record<string, unknown> = {}, verdict: 'human' | 'automated' = 'human') =>
      recordSignal({
        ownerId, contactId: contact._id, emailId: email._id, type, at, payload, verdict, source: 'demo',
        dedupeKey: type === 'sent' || type === 'delivered' ? `${type}:${email._id}` : `demo:${type}:${email._id}:${at.getTime()}`,
      });

    await sig('sent', sentAt, { subject: s.subject });
    await sig('delivered', new Date(sentAt.getTime() + 2000));
    for (const d of s.automatedOpens ?? []) await sig('open', new Date(daysAgo(d).getTime() + 3000), { userAgent: 'Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0' }, 'automated');
    for (const [d, h] of s.opens) await sig('open', daysAgo(d, h), { userAgent: 'Mozilla/5.0 (demo)' });
    if (s.doc) {
      await sig('doc_view', daysAgo(s.doc.daysAgo), { documentName: s.doc.name });
      await sig('page_dwell', daysAgo(s.doc.daysAgo), { documentName: s.doc.name, totalSeconds: s.doc.totalSeconds, topPage: s.doc.topPage, topSeconds: Math.round(s.doc.totalSeconds * 0.6) });
    }
    if (s.reply !== undefined) await sig('reply', daysAgo(s.reply));
    for (const m of s.memory ?? []) await addUserMemory({ ownerId, contactId: contact._id, ...m });
    await recomputeEngagement(ownerId, contact._id);
    console.log(`seeded ${s.name} <${s.address}>: ${s.opens.length} opens${s.doc ? ', a document view with dwell' : ''}${s.reply !== undefined ? ', a reply' : ''}${s.memory?.length ? `, ${s.memory.length} memory items` : ''}`);
  }
  console.log('\nOpen the Queue and Contacts pages. Briefs are generated by the AI worker when a provider key is configured; run `POST /api/contacts/:id/brief` or press "Regenerate brief" on a contact page.');
}

async function main(): Promise<void> {
  await connectDB();
  const user = await User.findOne().sort({ createdAt: 1 });
  if (!user) throw new Error('No users in the database — register one first.');
  if (process.argv.includes('--clean')) await clean(user._id);
  else await seed(user._id, user.gmailAddress || user.emailAddress);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
