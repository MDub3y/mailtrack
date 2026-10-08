import mongoose from 'mongoose';
import { z } from 'zod';
import { runAgent } from '../runAgent';
import { ContextBuilder } from '../context/builder';
import { ExtractedItem } from './policy';

// The third verification level (after existence and verbatim containment):
// does the quoted span actually SUPPORT the claim? A quote can be present
// in the email yet not entail what the item asserts — that is the
// "cited-but-unsupported" failure every memory system that stores raw model
// output ships with. The judge sees ONLY the claim/quote pairs, never the
// full email, so support must come from the quote alone. Fail closed: a
// missing verdict is a refusal, and if the judge cannot run at all the
// caller must withhold auto-acceptance (policy's `trusted` flag).

export const ENTAILMENT_SYSTEM = [
  'You verify memory items before they are stored. For each pair, decide whether the QUOTE, read on its own, directly supports the CLAIM.',
  'entailed=true only when a careful reader would accept the claim given nothing but the quote (and the stated email date for resolving relative times).',
  'entailed=false when the claim adds, generalises, speculates, or shifts attribution beyond what the quote says - even slightly, and even if the claim is plausible.',
  'Judge support, not truth. Return one verdict per index.',
].join('\n');

const EntailmentOutput = z.object({
  verdicts: z.array(z.object({ i: z.number().int(), entailed: z.boolean() })),
});

export interface EntailmentResult {
  verdicts: boolean[]; // aligned with items; false = drop
  runId: string;
}

export async function verifyEntailment(
  ownerId: mongoose.Types.ObjectId,
  items: ExtractedItem[],
  emailDate: string
): Promise<EntailmentResult> {
  const pairs = items
    .map((it, i) => `${i}. CLAIM (${it.kind}): ${it.content}\n   QUOTE: "${it.quote}"`)
    .join('\n');
  const ctx = new ContextBuilder()
    .add({ name: 'system', budgetTokens: 500, stable: true, text: ENTAILMENT_SYSTEM })
    .add({ name: 'task', budgetTokens: 3500, stable: false, text: `Email date: ${emailDate}\n\nPairs to verify:\n${pairs}` })
    .build();
  const r = await runAgent({
    kind: 'judge',
    ownerId,
    model: 'extractor',
    context: ctx,
    outputSchema: EntailmentOutput,
    maxTokens: 4000,
  });
  const map = new Map(r.output.verdicts.map((v) => [v.i, v.entailed]));
  // A verdict the judge did not return counts as not entailed.
  return { verdicts: items.map((_, i) => map.get(i) === true), runId: r.runId };
}
