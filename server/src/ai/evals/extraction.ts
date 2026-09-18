import 'dotenv/config';
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectDB } from '../../config/db';
import { User } from '../../models/User';
import { ContextBuilder } from '../context/builder';
import { runAgent } from '../runAgent';
import { ExtractionOutput, quoteAppearsIn } from '../memory/extract';
import { EXTRACTION_SYSTEM } from '../memory/extractPrompt';

// Extraction eval (doc/03-implementation-phases.md, Phase 1): a golden set of
// emails with the items a careful reader would keep. Scores three things per
// case, no LLM judge:
//   kinds     — did the extractor find each expected item (kind + key words)?
//   quotes    — was every returned quote verbatim in the email?
//   noise     — did it invent items the email does not support?
//
//   npm run eval:extraction                      (task "extractor" for the first user)
//   npm run eval:extraction -- --model openrouter:meta-llama/llama-3.3-70b-instruct:free
// Uses the same prompt as production via the shared schema; the numbers are
// meant to be recorded in the PR that changes the prompt or the model.

interface GoldenCase {
  id: string;
  email: string;
  expect: Array<{ kind: 'fact' | 'commitment' | 'preference'; keywords: string[]; by?: 'sender' | 'contact' }>;
  maxItems: number; // more than this counts as noise
}

const GOLDEN: GoldenCase[] = [
  { id: 'quote-by-friday', email: "Hi Priya,\n\nThanks for the call. I'll send the revised quote by Friday.\n\nBest,\nSam", expect: [{ kind: 'commitment', keywords: ['quote', 'friday'], by: 'sender' }], maxItems: 2 },
  { id: 'vendor-eval', email: "Hi Priya,\n\nYou mentioned you're evaluating vendors for a Q4 rollout, so I've attached the security overview.\n\nSam", expect: [{ kind: 'fact', keywords: ['q4'] }], maxItems: 2 },
  { id: 'their-confirm', email: "Marcus,\n\nAs agreed, you'll confirm headcount by the 12th and I'll turn the proposal around within two days of that.\n\nSam", expect: [{ kind: 'commitment', keywords: ['headcount'], by: 'contact' }, { kind: 'commitment', keywords: ['proposal'], by: 'sender' }], maxItems: 3 },
  { id: 'prefers-calls', email: "Aisha,\n\nNoted that you'd rather do the detailed review on a call than over email — I'll set one up for next week.\n\nSam", expect: [{ kind: 'preference', keywords: ['call'] }, { kind: 'commitment', keywords: ['call', 'next week'], by: 'sender' }], maxItems: 3 },
  { id: 'pleasantries-only', email: 'Hi Dev,\n\nGreat to meet you at the conference. Hope the flight back was smooth.\n\nSam', expect: [], maxItems: 0 },
  { id: 'decision-maker', email: "Hi Jordan,\n\nSince you're the one signing off on procurement, I've included the invoicing terms up front.\n\nSam", expect: [{ kind: 'fact', keywords: ['procurement'] }], maxItems: 2 },
  { id: 'date-moved', email: 'Quick update: the revised quote will now come next Wednesday rather than Friday. Apologies for the slip.', expect: [{ kind: 'commitment', keywords: ['quote', 'wednesday'], by: 'sender' }], maxItems: 2 },
  { id: 'budget-and-timeline', email: "Hi Lena,\n\nYou said the budget for this is capped at 40k and the rollout has to land before the March board meeting. I'll shape the proposal around both.\n\nSam", expect: [{ kind: 'fact', keywords: ['40k'] }, { kind: 'fact', keywords: ['march'] }], maxItems: 4 },
  { id: 'no-date-promise', email: "Hi Omar,\n\nI'll get you the case study once legal has cleared it.\n\nSam", expect: [{ kind: 'commitment', keywords: ['case study'], by: 'sender' }], maxItems: 2 },
  { id: 'two-preferences', email: "Hi Nia,\n\nUnderstood: no attachments over 5MB, and you'd like everything cc'd to your assistant.\n\nSam", expect: [{ kind: 'preference', keywords: ['5mb'] }, { kind: 'preference', keywords: ['assistant'] }], maxItems: 3 },
  { id: 'their-intro', email: "Hi Sam,\n\nHappy to intro you to our CFO next month once the audit closes.\n\nRavi", expect: [{ kind: 'commitment', keywords: ['cfo'], by: 'contact' }], maxItems: 2 },
  { id: 'question-not-commitment', email: 'Hi Tara,\n\nWould Thursday or Friday work better for a demo?\n\nSam', expect: [], maxItems: 1 },
  { id: 'pilot-facts', email: "Hi Ben,\n\nSummary of the pilot: 120 seats, three sites, SSO required. I'll send the rollout plan by end of month.\n\nSam", expect: [{ kind: 'fact', keywords: ['120'] }, { kind: 'fact', keywords: ['sso'] }, { kind: 'commitment', keywords: ['rollout plan'], by: 'sender' }], maxItems: 5 },
  { id: 'reschedule', email: "Hi Chloe,\n\nI need to move our Tuesday call. I'll propose two new slots by tomorrow.\n\nSam", expect: [{ kind: 'commitment', keywords: ['slots', 'tomorrow'], by: 'sender' }], maxItems: 2 },
  { id: 'competitor-fact', email: "Hi Ivan,\n\nSince you're comparing us against Acme, here is the side-by-side you asked for.\n\nSam", expect: [{ kind: 'fact', keywords: ['acme'] }], maxItems: 2 },
];

const ItemsOnly = ExtractionOutput;

function matches(expectKeywords: string[], content: string): boolean {
  const c = content.toLowerCase();
  return expectKeywords.every((k) => c.includes(k.toLowerCase()));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  await connectDB();
  const user = await User.findOne().sort({ createdAt: 1 });
  if (!user) throw new Error('No users in the database — register one first.');
  const model = arg('--model') || 'extractor';

  let expectedTotal = 0, found = 0, quotesTotal = 0, quotesValid = 0, noise = 0, totalCost = 0;
  const rows: string[] = [];

  for (const c of GOLDEN) {
    // Same system prompt as production, by construction (memory/extractPrompt.ts).
    const ctx = new ContextBuilder()
      .add({ name: 'system', budgetTokens: 600, stable: true, text: EXTRACTION_SYSTEM })
      .add({ name: 'task', budgetTokens: 2000, stable: false, text: `Email to extract from:\n\nDate: 2026-09-15\nFrom the sender\nSubject: (eval)\n\n${c.email}` })
      .build();
    let items: z.infer<typeof ItemsOnly>['items'] = [];
    let err = '';
    try {
      const r = await runAgent({ kind: 'judge', ownerId: user._id, model, context: ctx, outputSchema: ItemsOnly, maxTokens: 1500, inputRefs: { note: `eval:extraction:${c.id}` } });
      items = r.output.items;
      totalCost += r.costUsd;
    } catch (e) { err = e instanceof Error ? e.message : String(e); }

    const valid = items.filter((i) => quoteAppearsIn(i.quote, c.email));
    quotesTotal += items.length; quotesValid += valid.length;
    let hit = 0;
    for (const e of c.expect) {
      expectedTotal += 1;
      const ok = valid.some((i) => i.kind === e.kind && matches(e.keywords, i.content) && (!e.by || (i.structured as { by?: string } | undefined)?.by === e.by));
      if (ok) { hit += 1; found += 1; }
    }
    const extra = Math.max(0, valid.length - c.maxItems);
    noise += extra;
    rows.push(`${c.id.padEnd(24)} expected ${c.expect.length} found ${hit}  quotes ${valid.length}/${items.length}  noise ${extra}${err ? `  ERROR ${err.slice(0, 60)}` : ''}`);
  }

  console.log(rows.join('\n'));
  console.log('\nmodel:', model);
  console.log(`recall (expected items found): ${found}/${expectedTotal} = ${(100 * found / Math.max(1, expectedTotal)).toFixed(0)}%`);
  console.log(`quote validity: ${quotesValid}/${quotesTotal} = ${(100 * quotesValid / Math.max(1, quotesTotal)).toFixed(0)}%`);
  console.log(`noise items (beyond per-case cap): ${noise}`);
  console.log(`cost: $${totalCost.toFixed(4)}`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
