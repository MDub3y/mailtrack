import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { fakeAnthropic } from './helpers/fakeAnthropic';
import { __setClientForTests, MODELS } from '../ai/client';
import { ContextBuilder } from '../ai/context/builder';
import { runAgent, AiDisabledError, BudgetExceededError, RunFailedError, AgentTool } from '../ai/runAgent';
import { AgentRun } from '../models/AgentRun';

// These drive runAgent the way a real feature would — a drafting task with a
// contact's memory in context — against the Docker MongoDB, with the Anthropic
// client replaced by a scripted fake. Every path in the wrapper has a test:
// success, tool loop, step cap, schema failure, citation failure, refusal,
// truncation, budget, disabled flag, and the receipt's exactness.

const owner = new mongoose.Types.ObjectId();

const Draft = z.object({
  subject: z.string(),
  body: z.string(),
  usedMemoryIds: z.array(z.string()),
});

function draftingContext() {
  return new ContextBuilder()
    .add({ name: 'system', budgetTokens: 300, stable: true, text: 'You draft follow-up emails for the sender. Cite memory ids you relied on.' })
    .add({ name: 'voice', budgetTokens: 200, stable: true, cacheBoundary: true, text: 'Voice: short sentences, no exclamation marks, signs off with "Best".' })
    .add({
      name: 'memory',
      budgetTokens: 120,
      stable: false,
      items: [
        { id: 'mem-commit-1', text: '[mem-commit-1] You promised Priya a revised quote by Friday.' },
        { id: 'mem-engage-1', text: '[mem-engage-1] Priya opened the proposal 3 times since Tuesday, no reply.' },
        { id: 'mem-huge', text: '[mem-huge] ' + 'z'.repeat(2000) },
      ],
    })
    .add({ name: 'task', budgetTokens: 100, stable: false, text: 'Draft a follow-up because the quote is overdue.' })
    .build();
}

before(async () => {
  await connectTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  process.env.AI_ENABLED = 'true';
  delete process.env.AI_DAILY_TOKENS_DRAFT_FOLLOW_UP;
  process.env.AI_DAILY_TOKENS_DEFAULT = '200000';
});
after(async () => {
  __setClientForTests(null);
  await disconnectTestDb();
});

test('a drafting run succeeds, stores the receipt, and accounts usage and cost', async () => {
  const fake = fakeAnthropic([
    {
      json: { subject: 'Revised quote', body: 'Hi Priya, the revised quote is attached. Best', usedMemoryIds: ['mem-commit-1'] },
      usage: { input_tokens: 800, output_tokens: 60, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
    },
  ], { countTokens: 1300 });
  __setClientForTests(fake.client);

  const result = await runAgent({
    kind: 'draft_follow_up',
    ownerId: owner,
    model: MODELS.primary,
    effort: 'medium',
    context: draftingContext(),
    outputSchema: Draft,
    inputRefs: { contactId: 'contact-1' },
    citedIds: (o) => o.usedMemoryIds,
  });

  assert.equal(result.output.subject, 'Revised quote');
  assert.deepEqual(result.usage, { input: 800, output: 60, cacheRead: 500, cacheWrite: 0 });
  // 800 in @ $5/M + 500 cache read @ 10% + 60 out @ $25/M
  assert.ok(Math.abs(result.costUsd - (800 * 5e-6 + 500 * 5e-7 + 60 * 25e-6)) < 1e-9);

  const run = await AgentRun.findById(result.runId).lean();
  assert.ok(run);
  assert.equal(run!.status, 'succeeded');
  assert.equal(run!.modelId, 'claude-opus-5');
  assert.equal(run!.effort, 'medium');
  assert.equal(run!.receipt.exact, true);
  assert.equal(run!.receipt.totalInputTokens, 1300);
  assert.equal(run!.receipt.cacheReadTokens, 500);
  const memory = run!.receipt.sections.find((s) => s.name === 'memory')!;
  assert.deepEqual(memory.itemIds, ['mem-commit-1', 'mem-engage-1']);
  assert.deepEqual(memory.droppedItemIds, ['mem-huge']);
  assert.deepEqual(run!.output, result.output);
  assert.ok(run!.finishedAt);

  // The request carried the cache breakpoint on the voice block and the
  // structured-output format, and adaptive thinking for the primary model.
  const req = fake.requests[0];
  const system = req.system as Array<{ text: string; cache_control?: unknown }>;
  assert.equal(system.length, 2);
  assert.deepEqual(system[1].cache_control, { type: 'ephemeral' });
  assert.ok(req.output_config?.format);
  assert.equal(req.output_config?.effort, 'medium');
  assert.deepEqual((req as { thinking?: unknown }).thinking, { type: 'adaptive' });
});

test('the extractor model is called without a thinking parameter', async () => {
  const fake = fakeAnthropic([{ json: { subject: 's', body: 'b', usedMemoryIds: [] } }]);
  __setClientForTests(fake.client);
  await runAgent({ kind: 'extract_memory', ownerId: owner, model: MODELS.extractor, context: draftingContext(), outputSchema: Draft });
  assert.equal((fake.requests[0] as { thinking?: unknown }).thinking, undefined);
});

test('a tool loop records each step and returns all results in one user message', async () => {
  const fake = fakeAnthropic([
    { toolUses: [
      { id: 'tu_1', name: 'get_email', input: { emailId: 'e1' } },
      { id: 'tu_2', name: 'get_email', input: { emailId: 'e2' } },
    ] },
    { json: { subject: 'Following up', body: 'Per my last two emails…', usedMemoryIds: ['mem-engage-1'] } },
  ]);
  __setClientForTests(fake.client);

  const calls: string[] = [];
  const getEmail: AgentTool = {
    definition: {
      name: 'get_email',
      description: 'Full body of one prior email',
      input_schema: { type: 'object', properties: { emailId: { type: 'string' } }, required: ['emailId'] },
    },
    execute: async (input) => {
      const { emailId } = input as { emailId: string };
      calls.push(emailId);
      if (emailId === 'e2') throw new Error('not found');
      return `Body of ${emailId}: We discussed the Q4 rollout.`;
    },
  };

  const result = await runAgent({
    kind: 'draft_follow_up',
    ownerId: owner,
    model: MODELS.primary,
    context: draftingContext(),
    outputSchema: Draft,
    tools: [getEmail],
    citedIds: (o) => o.usedMemoryIds,
  });

  assert.deepEqual(calls, ['e1', 'e2']);
  const run = await AgentRun.findById(result.runId).lean();
  assert.equal(run!.steps.length, 2);
  assert.equal(run!.steps[0].tool, 'get_email');
  assert.match(run!.steps[0].outputSummary, /Q4 rollout/);
  assert.equal(run!.steps[0].isError, false);
  assert.equal(run!.steps[1].isError, true);
  assert.match(run!.steps[1].outputSummary, /tool error: not found/);
  assert.ok(run!.steps[0].ms >= 0);

  // Second request: assistant turn with both tool_use blocks, then ONE user
  // message carrying both tool_result blocks (error flagged), then the final.
  const second = fake.requests[1].messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[2].role, 'user');
  const results = second[2].content as Array<{ type: string; tool_use_id: string; is_error?: boolean }>;
  assert.deepEqual(results.map((r) => [r.type, r.tool_use_id, r.is_error ?? false]), [
    ['tool_result', 'tu_1', false],
    ['tool_result', 'tu_2', true],
  ]);
  assert.equal(run!.usage.input, 200); // two turns × 100 default
});

test('a tool loop that exceeds the step cap fails the run', async () => {
  const loop = { toolUses: [{ id: 'tu', name: 'noop', input: {} }] };
  const fake = fakeAnthropic([loop, loop, loop, loop]);
  __setClientForTests(fake.client);
  const noop: AgentTool = {
    definition: { name: 'noop', description: 'does nothing', input_schema: { type: 'object', properties: {} } },
    execute: async () => 'ok',
  };
  await assert.rejects(
    runAgent({ kind: 'investigate', ownerId: owner, model: MODELS.primary, context: draftingContext(), outputSchema: Draft, tools: [noop], maxSteps: 2 }),
    (err: unknown) => err instanceof RunFailedError && /exceeded 2 steps/.test(err.message)
  );
  const run = await AgentRun.findOne({ kind: 'investigate' }).lean();
  assert.equal(run!.status, 'failed');
  assert.equal(run!.steps.length, 2);
  assert.equal(run!.output, undefined);
  assert.equal(fake.requests.length, 3);
});

test('output that fails the schema is a failed run with nothing stored', async () => {
  const fake = fakeAnthropic([{ json: { subject: 'x', usedMemoryIds: 'not-an-array' } }]);
  __setClientForTests(fake.client);
  await assert.rejects(
    runAgent({ kind: 'draft_follow_up', ownerId: owner, model: MODELS.primary, context: draftingContext(), outputSchema: Draft }),
    (err: unknown) => err instanceof RunFailedError && /schema validation/.test(err.message)
  );
  const run = await AgentRun.findOne().lean();
  assert.equal(run!.status, 'failed');
  assert.equal(run!.output, undefined);
  assert.match(run!.error!, /body/);
  assert.equal(run!.usage.input, 100); // usage is still accounted for a failed call
});

test('output that is not JSON at all is a failed run', async () => {
  const fake = fakeAnthropic([{ text: 'Sure! Here is your draft: ...' }]);
  __setClientForTests(fake.client);
  await assert.rejects(
    runAgent({ kind: 'draft_follow_up', ownerId: owner, model: MODELS.primary, context: draftingContext(), outputSchema: Draft }),
    /not valid JSON/
  );
});

test('a draft that cites a memory id not in context is rejected', async () => {
  const fake = fakeAnthropic([
    { json: { subject: 's', body: 'b', usedMemoryIds: ['mem-commit-1', 'mem-huge', 'mem-invented'] } },
  ]);
  __setClientForTests(fake.client);
  await assert.rejects(
    runAgent({ kind: 'draft_follow_up', ownerId: owner, model: MODELS.primary, context: draftingContext(), outputSchema: Draft, citedIds: (o) => o.usedMemoryIds }),
    (err: unknown) => err instanceof RunFailedError && /not in context: mem-huge, mem-invented/.test(err.message)
  );
  const run = await AgentRun.findOne().lean();
  assert.equal(run!.status, 'failed');
  assert.equal(run!.output, undefined);
});

test('a model refusal is recorded as refused with its category', async () => {
  const fake = fakeAnthropic([{ stopReason: 'refusal', refusalCategory: 'other', usage: { input_tokens: 50, output_tokens: 0 } }]);
  __setClientForTests(fake.client);
  await assert.rejects(
    runAgent({ kind: 'draft_follow_up', ownerId: owner, model: MODELS.primary, context: draftingContext(), outputSchema: Draft }),
    /declined/
  );
  const run = await AgentRun.findOne().lean();
  assert.equal(run!.status, 'refused');
  assert.equal(run!.refusalCategory, 'other');
  assert.equal(run!.usage.input, 50);
});

test('a truncated response is a failed run', async () => {
  const fake = fakeAnthropic([{ text: '{"subject": "cut off', stopReason: 'max_tokens' }]);
  __setClientForTests(fake.client);
  await assert.rejects(
    runAgent({ kind: 'draft_follow_up', ownerId: owner, model: MODELS.primary, context: draftingContext(), outputSchema: Draft }),
    /max_tokens/
  );
});

test('the daily ceiling counts today\'s spend for the same owner and kind only', async () => {
  process.env.AI_DAILY_TOKENS_DRAFT_FOLLOW_UP = '1000';
  const ok = { json: { subject: 's', body: 'b', usedMemoryIds: [] }, usage: { input_tokens: 600, output_tokens: 100 } };
  const fake = fakeAnthropic([ok, ok, ok, ok]); // four successful calls below; the refused one never reaches the model
  __setClientForTests(fake.client);
  const spec = { kind: 'draft_follow_up' as const, ownerId: owner, model: MODELS.primary, outputSchema: Draft };

  await runAgent({ ...spec, context: draftingContext() });                 // 700 used
  await runAgent({ ...spec, context: draftingContext() });                 // 1400 used (700 < 1000 passed the check)
  await assert.rejects(
    runAgent({ ...spec, context: draftingContext() }),
    (err: unknown) => err instanceof BudgetExceededError && err.spent === 1400 && err.ceiling === 1000
  );
  // A different kind for the same owner is unaffected; so is another owner.
  await runAgent({ ...spec, kind: 'contact_brief', context: draftingContext() });
  await runAgent({ ...spec, ownerId: new mongoose.Types.ObjectId(), context: draftingContext() });

  const refused = await AgentRun.find({ status: 'refused' }).lean();
  assert.equal(refused.length, 1);
  assert.match(refused[0].error!, /1400 of 1000/);
  assert.equal(fake.requests.length, 4);
});

test('a running run counts against the budget before it finalises', async () => {
  // Two runs racing: the second must see the first as spend even though the
  // first has not finished. Simulate by inserting a running run directly.
  process.env.AI_DAILY_TOKENS_DRAFT_FOLLOW_UP = '100';
  await AgentRun.create({ ownerId: owner, kind: 'draft_follow_up', modelId: 'claude-opus-5', status: 'running', usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } });
  __setClientForTests(fakeAnthropic([{ json: { subject: 's', body: 'b', usedMemoryIds: [] } }]).client);
  await assert.rejects(
    runAgent({ kind: 'draft_follow_up', ownerId: owner, model: MODELS.primary, context: draftingContext(), outputSchema: Draft }),
    BudgetExceededError
  );
});

test('with AI disabled nothing is called and nothing is recorded', async () => {
  process.env.AI_ENABLED = 'false';
  const fake = fakeAnthropic([{ json: {} }]);
  __setClientForTests(fake.client);
  await assert.rejects(
    runAgent({ kind: 'draft_follow_up', ownerId: owner, model: MODELS.primary, context: draftingContext(), outputSchema: Draft }),
    AiDisabledError
  );
  assert.equal(await AgentRun.countDocuments(), 0);
  assert.equal(fake.requests.length, 0);
});

test('when count_tokens is unavailable the receipt keeps the estimate and says so', async () => {
  const fake = fakeAnthropic([{ json: { subject: 's', body: 'b', usedMemoryIds: [] } }], { countTokens: 'fail' });
  __setClientForTests(fake.client);
  const ctx = draftingContext();
  const estimate = ctx.receipt.totalInputTokens;
  const result = await runAgent({ kind: 'draft_follow_up', ownerId: owner, model: MODELS.primary, context: ctx, outputSchema: Draft });
  assert.equal(result.receipt.exact, false);
  assert.equal(result.receipt.totalInputTokens, estimate);
});

test('an API error is recorded on the run and rethrown', async () => {
  const client = {
    messages: {
      stream: () => ({ finalMessage: async () => { throw new Error('socket hang up'); } }),
      countTokens: async () => ({ input_tokens: 1 }),
    },
  } as unknown as import('@anthropic-ai/sdk').default;
  __setClientForTests(client);
  await assert.rejects(
    runAgent({ kind: 'draft_follow_up', ownerId: owner, model: MODELS.primary, context: draftingContext(), outputSchema: Draft }),
    /socket hang up/
  );
  const run = await AgentRun.findOne().lean();
  assert.equal(run!.status, 'failed');
  assert.match(run!.error!, /socket hang up/);
});
