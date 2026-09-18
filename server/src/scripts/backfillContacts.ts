import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { Email } from '../models/Email';
import { ensureContact, recordSignal } from '../services/signalService';

// Idempotent: derives Contacts from existing sent Emails, links each Email
// to its contact, and replays Email.events[] into Signal rows using
// deterministic dedupe keys. Safe to run repeatedly.
//
//   npm run backfill:contacts

async function main(): Promise<void> {
  await connectDB();
  const cursor = Email.find({}).sort({ createdAt: 1 }).cursor();
  let emails = 0, contacts = 0, signals = 0;
  const seenContacts = new Set<string>();

  for await (const email of cursor) {
    emails += 1;
    const contact = await ensureContact(email.senderId, email.to);
    const key = contact._id.toString();
    if (!seenContacts.has(key)) { seenContacts.add(key); contacts += 1; }

    if (!email.contactId || email.contactId.toString() !== key) {
      email.contactId = contact._id;
      await email.save();
    }

    for (let i = 0; i < email.events.length; i++) {
      const ev = email.events[i];
      const type = ev.type === 'opened' ? 'open' : ev.type;
      // Same keys the live paths use (queues/emailQueue.ts, routes/track.ts),
      // so a backfill over already-tracked email adds nothing twice: opens
      // are per event index, sent/delivered/failed once per email.
      const dedupeKey = type === 'open' ? `open:${email._id}:${i}` : `${type}:${email._id}`;
      const { isNew } = await recordSignal({
        ownerId: email.senderId,
        contactId: contact._id,
        emailId: email._id,
        type,
        at: ev.timestamp,
        payload: ev.type === 'opened' ? { userAgent: ev.userAgent, ip: ev.ip, eventIndex: i } : { eventIndex: i },
        verdict: ev.type === 'opened' ? (ev.automated ? 'automated' : 'human') : 'human',
        source: 'backfill',
        dedupeKey,
      });
      if (isNew) signals += 1;
    }
  }

  console.log(`emails scanned: ${emails}, contacts: ${contacts}, new signals: ${signals}`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
