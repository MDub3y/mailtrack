import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { connectDB } from '../../config/db';
import { Signal } from '../../models/Signal';
import { loadActiveRules, classifyWith, ClassifyInput } from '../../services/classifierService';

// Classifier eval (doc/02-ai-architecture.md §3.5): the current rule set
// against every labelled open. No model, no cost. False negatives (a real
// open suppressed) are reported separately because the product treats them
// as the more expensive error.
//
//   npm run eval:classifier            prints metrics; exits 1 if below baseline
//   npm run eval:classifier -- --seed  evaluates the committed seed labels only (no DB)
//   npm run eval:classifier -- --write-baseline

export interface LabelledEvent { id: string; userAgent: string; ip?: string; msSinceCreated: number; label: 'human' | 'automated' }

export interface ClassifierMetrics {
  n: number;
  truePositive: number;   // automated predicted automated
  falsePositive: number;  // human predicted automated  (a real open suppressed)
  falseNegative: number;  // automated predicted human  (a scan counted as an open)
  trueNegative: number;
  precision: number;      // of what we called automated, how much was
  recall: number;         // of the automated, how much we caught
  humanRecall: number;    // of real opens, how many we kept
  misses: Array<{ id: string; label: string; predicted: string; userAgent: string; msSinceCreated: number }>;
}

// Positive class = automated. "precision" answers: when we suppress an open,
// were we right? "humanRecall" answers: how many real opens did we keep?
export function computeMetrics(events: LabelledEvent[], rules: Parameters<typeof classifyWith>[0]): ClassifierMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const misses: ClassifierMetrics['misses'] = [];
  for (const e of events) {
    const input: ClassifyInput = { userAgent: e.userAgent, ip: e.ip ?? '', msSinceCreated: e.msSinceCreated, signalType: 'open' };
    const predicted = classifyWith(rules, input).automated ? 'automated' : 'human';
    if (e.label === 'automated' && predicted === 'automated') tp += 1;
    else if (e.label === 'human' && predicted === 'automated') { fp += 1; misses.push({ id: e.id, label: e.label, predicted, userAgent: e.userAgent, msSinceCreated: e.msSinceCreated }); }
    else if (e.label === 'automated' && predicted === 'human') { fn += 1; misses.push({ id: e.id, label: e.label, predicted, userAgent: e.userAgent, msSinceCreated: e.msSinceCreated }); }
    else tn += 1;
  }
  const div = (a: number, b: number) => (b === 0 ? 1 : a / b);
  return { n: events.length, truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn, precision: div(tp, tp + fp), recall: div(tp, tp + fn), humanRecall: div(tn, tn + fp), misses };
}

export function seedEvents(): LabelledEvent[] {
  const file = path.join(__dirname, 'seed', 'events.json');
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { events: LabelledEvent[] }).events;
}

// Labels users have added. Rows loaded from the seed file by seed:labels
// carry a seedId and are excluded here, since the seed set is counted once
// from the file.
export async function labelledFromDb(): Promise<LabelledEvent[]> {
  const rows = await Signal.find({ type: 'open', 'integrity.label': { $exists: true }, 'payload.seedId': { $exists: false } }).select('payload integrity').lean();
  return rows.map((s) => {
    const p = s.payload as { userAgent?: string; ip?: string; msSinceCreated?: number };
    return { id: s._id.toString(), userAgent: p.userAgent ?? '', ip: p.ip, msSinceCreated: p.msSinceCreated ?? 0, label: s.integrity.label! };
  });
}

const BASELINE_FILE = path.join(__dirname, 'seed', 'baseline.json');

async function main(): Promise<void> {
  const seedOnly = process.argv.includes('--seed');
  let events = seedEvents();
  let rules: Parameters<typeof classifyWith>[0] = [];
  if (!seedOnly) {
    await connectDB();
    rules = await loadActiveRules(true);
    events = [...events, ...(await labelledFromDb())];
  }
  const m = computeMetrics(events, rules);
  console.log(`labelled events: ${m.n} (${seedOnly ? 'seed only' : `seed + ${m.n - seedEvents().length} from the database`}), active rules: ${rules.length} (+ ${2} seed heuristics)`);
  console.log(`precision (suppressed opens that were scans): ${m.truePositive}/${m.truePositive + m.falsePositive} = ${(100 * m.precision).toFixed(0)}%`);
  console.log(`recall (scans caught):                        ${m.truePositive}/${m.truePositive + m.falseNegative} = ${(100 * m.recall).toFixed(0)}%`);
  console.log(`real opens kept:                              ${m.trueNegative}/${m.trueNegative + m.falsePositive} = ${(100 * m.humanRecall).toFixed(0)}%`);
  console.log(`false negatives (scans counted as opens):     ${m.falseNegative}`);
  console.log(`false positives (real opens suppressed):      ${m.falsePositive}`);
  for (const x of m.misses) console.log(`  miss ${x.id}: labelled ${x.label}, predicted ${x.predicted}, ${x.msSinceCreated} ms, UA ${x.userAgent.slice(0, 70)}`);

  if (process.argv.includes('--write-baseline')) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ precision: m.precision, recall: m.recall, humanRecall: m.humanRecall, at: new Date().toISOString() }, null, 2) + '\n');
    console.log('baseline written');
  } else if (fs.existsSync(BASELINE_FILE)) {
    const b = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as { precision: number; recall: number; humanRecall: number };
    const worse = m.precision < b.precision - 1e-9 || m.recall < b.recall - 1e-9 || m.humanRecall < b.humanRecall - 1e-9;
    console.log(`baseline: precision ${(100 * b.precision).toFixed(0)}% recall ${(100 * b.recall).toFixed(0)}% real-opens-kept ${(100 * b.humanRecall).toFixed(0)}% → ${worse ? 'REGRESSION' : 'ok'}`);
    if (worse) process.exitCode = 1;
  }
  if (!seedOnly) await mongoose.disconnect();
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
