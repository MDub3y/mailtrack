import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { reclassifyOpens } from '../services/classifierService';

// Re-runs the classifier over historical open signals under the current
// active rule set, updating verdicts, Email.events[].automated, openCount,
// firstOpenedAt and status. Labelled signals are never touched. This is
// what the two earlier fixes in the README did by hand.
//
//   npm run reclassify

async function main(): Promise<void> {
  await connectDB();
  const r = await reclassifyOpens();
  console.log(`scanned ${r.scanned} open signals, changed ${r.changed}, emails updated ${r.emailsTouched}`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
