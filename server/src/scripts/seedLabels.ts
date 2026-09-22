import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { User } from '../models/User';
import { Email } from '../models/Email';
import { Signal } from '../models/Signal';
import { ensureContact, recordSignal } from '../services/signalService';
import { seedEvents } from '../ai/evals/classifier';
import { classifyWith, loadActiveRules } from '../services/classifierService';

// Loads the committed seed labels (ai/evals/seed/events.json) into the
// database as labelled open signals on one synthetic email, so the
// investigator's labelled_events tool and the integrity page have ground
// truth from day one. Idempotent.
//
//   npm run seed:labels

async function main(): Promise<void> {
  await connectDB();
  const user = await User.findOne().sort({ createdAt: 1 });
  if (!user) throw new Error('No users in the database — register one first.');

  const contact = await ensureContact(user._id, 'labels@seed.invalid', { displayName: 'Seed labels' });
  let email = await Email.findOne({ senderId: user._id, to: 'labels@seed.invalid' });
  if (!email) {
    email = await Email.create({ senderId: user._id, contactId: contact._id, from: user.emailAddress, to: 'labels@seed.invalid', subject: 'Seed labels for the classifier eval', htmlBody: '', textBody: '', trackingToken: 'seed-labels', status: 'delivered', events: [] });
  }

  let added = 0;
  const rules = await loadActiveRules(true);
  for (const e of seedEvents()) {
    // What the classifier would say today, kept alongside the label so the
    // investigator can see where the two disagree.
    const classifierVerdict = classifyWith(rules, { userAgent: e.userAgent, ip: e.ip ?? '', msSinceCreated: e.msSinceCreated }).automated ? 'automated' : 'human';
    const { signal, isNew } = await recordSignal({
      ownerId: user._id, contactId: contact._id, emailId: email._id, type: 'open',
      at: new Date(email.createdAt.getTime() + e.msSinceCreated),
      payload: { userAgent: e.userAgent, ip: e.ip ?? '', msSinceCreated: e.msSinceCreated, seedId: e.id, classifierVerdict },
      verdict: e.label, source: 'backfill', dedupeKey: `seed-label:${e.id}`,
    });
    if (isNew) { await Signal.updateOne({ _id: signal._id }, { $set: { 'integrity.label': e.label } }); added += 1; }
  }
  console.log(`seed labels: ${added} added, ${seedEvents().length - added} already present`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
