import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../../config/db';
import { User } from '../../models/User';
import { RUN_KINDS, RunKind } from '../../models/AgentRun';
import { replaySample, loadVariant, renderReportText, REPLAYABLE_KINDS, runDriftReplay } from '../replay';
import type { Effort } from '../providers/types';

// Replay harness (doc/05, Elevation 4): re-run stored runs under a variant
// and compare. Every run keeps its exact prompt, so nothing is rebuilt.
//
//   npm run replay -- --kind draft_follow_up --since 30d --limit 5 --variant draft.v2 --judge
//   npm run replay -- --kind extract_memory --model openrouter:openai/gpt-oss-20b
//   npm run replay -- --drift            (this week's runs under the current prompt, same model)
//   npm run replay -- --owner me@x.com   (whose runs; default the first user)
//
// Variants are markdown files in server/prompts/. A change to a production
// prompt should ship with the report this prints.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function parseSince(s: string | undefined): Date {
  const m = /^(\d+)([dh])$/.exec(s ?? '30d');
  if (!m) return new Date(s!);
  return new Date(Date.now() - Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000));
}

async function main(): Promise<void> {
  await connectDB();
  const ownerArg = arg('--owner');
  const owner = ownerArg ? await User.findOne({ email: ownerArg.toLowerCase() }) : await User.findOne().sort({ createdAt: 1 });
  if (!owner) throw new Error('no user found');

  if (process.argv.includes('--drift')) {
    const reports = await runDriftReplay(owner._id, { perKind: Number(arg('--limit') || 5), days: Number((arg('--since') || '7d').replace(/d$/, '')) });
    if (!reports.length) console.log('nothing to replay this week');
    for (const r of reports) console.log(renderReportText(r), '\n');
    await mongoose.disconnect();
    return;
  }

  const kind = (arg('--kind') || 'draft_follow_up') as RunKind;
  if (!RUN_KINDS.includes(kind) || !REPLAYABLE_KINDS.includes(kind)) throw new Error(`--kind must be one of ${REPLAYABLE_KINDS.join(', ')}`);
  const variant = arg('--variant') ? loadVariant(arg('--variant')!) : undefined;
  const report = await replaySample(owner._id, {
    kind, since: parseSince(arg('--since')), limit: Number(arg('--limit') || 5), trigger: 'cli',
    variant: variant?.text, variantSource: variant?.source, model: arg('--model'), effort: arg('--effort') as Effort | undefined, judge: process.argv.includes('--judge'),
  });
  console.log(renderReportText(report));
  console.log(`\nreport ${report._id} saved; it is listed on the Runs page.`);
  await mongoose.disconnect();
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
