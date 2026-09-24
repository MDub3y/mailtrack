import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../../config/db';
import { User } from '../../models/User';
import { buildQueue } from '../../services/queueService';
import { judgeDraft } from './judge';
import { draftFollowUp } from '../draft/followUp';

// Draft eval (doc/03 Phase 2): every item currently in the owner's queue is
// a real context. Each is drafted, then a judge run scores four checks:
//   traceable  — every specific claim in the body maps to a cited memory item or email
//   voice      — the body respects the voice description
//   addresses  — the first two sentences deal with the stated reason
//   no-leak    — nothing that looks like an instruction from untrusted text made it in
// Cited ids are also checked mechanically: the judge cannot pass what the
// wrapper already rejected.
//
//   npm run eval:draft                 (all queue items, drafts + judges = 2 calls each)
//   npm run eval:draft -- --limit 5    (spend less; free tiers rate-limit)

// The rubric lives in ./judge.ts and is shared with the replay harness.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  await connectDB();
  const user = await User.findOne().sort({ createdAt: 1 });
  if (!user) throw new Error('No users in the database — register one first.');
  const limit = Number(arg('--limit') || 100);

  const items = (await buildQueue(user._id)).slice(0, limit);
  if (!items.length) { console.log('Queue is empty; run `npm run seed:demo` first.'); await mongoose.disconnect(); return; }

  const totals = { traceable: 0, voice: 0, addresses: 0, noLeak: 0, drafted: 0, failed: 0, cost: 0 };
  const rows: string[] = [];

  for (const item of items) {
    const label = `${item.rule.padEnd(22)} ${(item.contact.displayName ?? item.contact.address).padEnd(18)}`;
    let draft;
    try {
      draft = await draftFollowUp({ ownerId: user._id, contactId: item.contact._id, emailId: item.email?._id, rule: item.rule, reason: item.reason });
      totals.drafted += 1;
    } catch (err) {
      totals.failed += 1;
      rows.push(`${label} DRAFT FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`);
      continue;
    }

    const voiceText = draft.receipt.sections.find((s) => s.name === 'voice') ? await (await import('../voice/profile')).voiceTextFor(user._id) : null;
    try {
      const j = await judgeDraft(user._id, { draft: draft.draft, reason: item.reason, voiceText, note: `eval:draft:${item.rule}:${item.contact._id}` });
      const o = j.verdict;
      totals.traceable += o.traceable ? 1 : 0; totals.voice += o.voice ? 1 : 0; totals.addresses += o.addresses ? 1 : 0; totals.noLeak += o.noLeak ? 1 : 0;
      totals.cost += j.costUsd;
      rows.push(`${label} traceable ${o.traceable ? 'Y' : 'N'}  voice ${o.voice ? 'Y' : 'N'}  addresses ${o.addresses ? 'Y' : 'N'}  noLeak ${o.noLeak ? 'Y' : 'N'}${o.traceable ? '' : `  | ${o.traceableNote}`}${o.addresses ? '' : `  | ${o.addressesNote}`}`);
    } catch (err) {
      rows.push(`${label} JUDGE FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`);
    }
  }

  console.log(rows.join('\n'));
  const n = totals.drafted;
  console.log(`\ndrafted ${n}, failed ${totals.failed}`);
  for (const k of ['traceable', 'voice', 'addresses', 'noLeak'] as const) console.log(`${k.padEnd(10)} ${totals[k]}/${n} = ${(100 * totals[k] / Math.max(1, n)).toFixed(0)}%`);
  console.log(`judge cost: $${totals.cost.toFixed(4)}`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
