import 'dotenv/config';
import fs from 'fs';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { Email } from '../models/Email';
import { Signal } from '../models/Signal';

// Open-precision (MPP) measurement: seeded sends against ground truth you
// record by hand. Mail clients prefetch images (Apple MPP, Gmail prescan),
// so "the pixel fired" and "a person read it" diverge - this harness
// measures BY HOW MUCH, per client, instead of asserting a number.
//
// Protocol:
//   1. Send a batch of normal tracked emails to addresses you control, via
//      the app (BASE_URL must be publicly reachable or no pixel ever fires).
//   2. For each, record the truth in a JSON file as you act it out:
//        [{ "to": "me@gmail.com", "subject": "probe 3", "client": "gmail-web",
//           "humanOpened": true, "openedAt": "2026-10-08T14:05:00Z" }, ...]
//      Include entries you deliberately did NOT open (humanOpened: false).
//   3. npm run mpp:report -- --truth path/to/truth.json [--since 7d]
//
// Reported per client: precision (recorded opens that were human), recall
// (human opens the pixel caught), and the opacity rate (truth rows where no
// pixel ever fired - clients that block images entirely).

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface TruthRow { to: string; subject: string; client: string; humanOpened: boolean; openedAt?: string }

async function main(): Promise<void> {
  const truthPath = arg('truth');
  if (!truthPath || !fs.existsSync(truthPath)) { console.error('pass --truth <file.json> (see header for the format)'); process.exit(1); }
  const truth: TruthRow[] = JSON.parse(fs.readFileSync(truthPath, 'utf8'));
  const sinceDays = Number((arg('since') ?? '7d').replace(/d$/, ''));
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  await connectDB();

  const perClient = new Map<string, { truePos: number; falsePos: number; falseNeg: number; trueNeg: number; opaque: number; n: number }>();
  const bucket = (c: string) => {
    if (!perClient.has(c)) perClient.set(c, { truePos: 0, falsePos: 0, falseNeg: 0, trueNeg: 0, opaque: 0, n: 0 });
    return perClient.get(c)!;
  };

  for (const row of truth) {
    const email = await Email.findOne({ to: row.to.toLowerCase(), subject: row.subject, createdAt: { $gte: since } }).sort({ createdAt: -1 });
    const b = bucket(row.client);
    b.n += 1;
    if (!email) { console.error(`no sent email matches to=${row.to} subject="${row.subject}"`); continue; }
    const opens = await Signal.find({ emailId: email._id, type: 'open' }).lean();
    const counted = opens.some((s) => s.integrity?.verdict !== 'automated');
    const anyPixel = opens.length > 0;

    if (row.humanOpened && counted) b.truePos += 1;
    else if (row.humanOpened && !counted) { b.falseNeg += 1; if (!anyPixel) b.opaque += 1; }
    else if (!row.humanOpened && counted) b.falsePos += 1;
    else b.trueNeg += 1;
  }

  console.log(`\n== open precision against hand-recorded ground truth (${truth.length} rows)`);
  for (const [client, b] of perClient) {
    const precision = b.truePos + b.falsePos ? b.truePos / (b.truePos + b.falsePos) : NaN;
    const recall = b.truePos + b.falseNeg ? b.truePos / (b.truePos + b.falseNeg) : NaN;
    console.log(`  ${client.padEnd(14)} n=${String(b.n).padStart(2)}  precision ${Number.isNaN(precision) ? ' n/a' : (precision * 100).toFixed(0) + '%'}  recall ${Number.isNaN(recall) ? ' n/a' : (recall * 100).toFixed(0) + '%'}  opaque(no pixel at all) ${b.opaque}/${b.n}`);
  }
  console.log('\nprecision: when Proofbox says "opened", a person had. recall: how many real reads the pixel caught.');
  console.log('opacity is the residual no pixel product can see; it is reported, not hidden.');
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
