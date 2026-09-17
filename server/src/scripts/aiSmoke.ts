import 'dotenv/config';
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectDB } from '../config/db';
import { User } from '../models/User';
import { AgentRun } from '../models/AgentRun';
import { MODELS } from '../ai/client';
import { ContextBuilder } from '../ai/context/builder';
import { runAgent, BudgetExceededError } from '../ai/runAgent';

// Phase 0 acceptance (doc/03-implementation-phases.md):
//   1. one trivial structured call through runAgent lands in the run log with
//      non-zero usage and a cost;
//   2. a ceiling of zero makes the same call refuse with a readable error and
//      a `refused` run record.
//
// Usage:  npm run ai:smoke              (uses the first user in the DB)
//         npm run ai:smoke -- --refuse  (forces the budget refusal path)

const Output = z.object({
  greeting: z.string(),
  usedIds: z.array(z.string()),
});

async function main(): Promise<void> {
  await connectDB();
  const user = await User.findOne().sort({ createdAt: 1 });
  if (!user) throw new Error('No users in the database — register one first.');

  const refuse = process.argv.includes('--refuse');
  if (refuse) process.env.AI_DAILY_TOKENS_SMOKE = '0';

  const ctx = new ContextBuilder()
    .add({
      name: 'system',
      budgetTokens: 400,
      stable: true,
      text: 'You are a smoke test for a run wrapper. Reply with a one-line greeting and list the ids of any facts you used.',
    })
    .add({
      name: 'voice',
      budgetTokens: 200,
      stable: true,
      cacheBoundary: true,
      text: 'Voice: plain, short, no exclamation marks.',
    })
    .add({
      name: 'memory',
      budgetTokens: 100,
      stable: false,
      items: [
        { id: 'fact-1', text: '[fact-1] The sender prefers to be addressed by first name.' },
        { id: 'fact-2', text: '[fact-2] The sender is in a UTC+5:30 timezone.' },
        { id: 'fact-3', text: '[fact-3] ' + 'x'.repeat(600) }, // deliberately over budget → dropped
      ],
    })
    .add({
      name: 'task',
      budgetTokens: 100,
      stable: false,
      text: 'Greet the sender. Cite the ids of the facts you relied on in usedIds.',
    })
    .build();

  console.log('receipt (estimate):', JSON.stringify(ctx.receipt.sections.map((s) => ({ name: s.name, tokens: s.tokens, dropped: s.droppedItemIds })), null, 0));

  try {
    const result = await runAgent({
      kind: 'smoke',
      ownerId: user._id,
      model: MODELS.primary,
      effort: 'low',
      context: ctx,
      outputSchema: Output,
      maxTokens: 2000,
      inputRefs: { note: 'ai:smoke' },
      citedIds: (o) => o.usedIds,
    });
    console.log('run id:', result.runId);
    console.log('output:', result.output);
    console.log('usage:', result.usage, 'cost USD:', result.costUsd.toFixed(6));
    console.log('receipt exact:', result.receipt.exact, 'total input tokens:', result.receipt.totalInputTokens);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      const refused = await AgentRun.findOne({ ownerId: user._id, kind: 'smoke', status: 'refused' }).sort({ startedAt: -1 });
      console.log('refused as expected:', err.message);
      console.log('refused run recorded:', Boolean(refused), refused?._id.toString());
    } else {
      throw err;
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
