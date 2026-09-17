import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { fakeProvider } from './helpers/fakeProvider';
import { __setProviderForTests } from '../ai/providers';
import { ContextBuilder } from '../ai/context/builder';
import { runAgent, AiDisabledError, BudgetExceededError, RunFailedError, AgentTool } from '../ai/runAgent';
import { AgentRun } from '../models/AgentRun';
import { AiSettings } from '../models/AiSettings';

// These drive runAgent the way a real feature would — a drafting task with a
// contact's memory in context — against the Docker MongoDB, with the provider
// replaced by a scripted fake. Every path in the wrapper has a test: success,
// tool loop, step cap, schema failure, citation failure, refusal, truncation,
// budget, disabled flag, receipt exactness, cost sources and degraded features.

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

const base = { kind: 'draft_follow_up' as const, ownerId: owner, model: 'primary', outputSchema: Draft };

before(async () => { await connectTestDb(); });
beforeEach(async () => {
  await resetTestDb();
  process.env.AI_ENABLED = 'true';
  delete process.env.AI_DAILY_TOKENS_DRAFT_FOLLOW_UP;
  process.env.AI_DAILY_TOKENS_DEFAULT = '200000';
  process.env.AI_MODEL_PRIMARY = 'anthropic:claude-opus-5';
  process.env.AI_MODEL_EXTRACTOR = 'anthropic:claude-haiku-4-5';
});
after(async () => {
  __setProviderForTests(null);
  await disconnectTestDb();
});

test('a drafting run succeeds, stores the receipt, and accounts usage and cost from the price table', async () => {
  const fake = fakeProvider([
    {
      json: { subject: 'Revised quote', body: 'Hi Priya, the revised quote is attached. Best', usedMemoryIds: ['mem-commit-1'] },
      usage: { input: 800, output: 60, cacheRead: 500, cacheWrite: 0 },
    },
  ], { countTokens: 1300 });
  __setProviderForTests(fake);

  const result = await runAgent({ ...base, effort: 'medium', context: draftingContext(), inputRefs: { contactId: 'contact-1' }, citedIds: (o) => o.usedMemoryIds });

  assert.equal(result.output.subject, 'Revised quote');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'anthropic:claude-opus-5');
  assert.deepEqual(result.usage, { input: 800, output: 60, cacheRead: 500, cacheWrite: 0 });
  // 800 in @ $5/M + 500 cache read @ $0.5/M + 60 out @ $25/M
  assert.ok(Math.abs(result.costUsd - (800 * 5e-6 + 500 * 0.5e-6 + 60 * 25e-6)) < 1e-9);

  const run = await AgentRun.findById(result.runId).lean();
  assert.equal(run!.status, 'succeeded');
  assert.equal(run!.provider, 'anthropic');
  assert.equal(run!.modelId, 'anthropic:claude-opus-5');
  assert.equal(run!.keySource, 'owner');
  assert.equal(run!.costSource, 'table');
  assert.equal(run!.effort, 'medium');
  assert.equal(run!.receipt.exact, true);
  assert.equal(run!.receipt.totalInputTokens, 1300);
  assert.equal(run!.receipt.cacheReadTokens, 500);
  const memory = run!.receipt.sections.find((s) => s.name === 'memory')!;
  assert.deepEqual(memory.itemIds, ['mem-commit-1', 'mem-engage-1']);
  assert.deepEqual(memory.droppedItemIds, ['mem-huge']);
  assert.deepEqual(run!.output, result.output);
  assert.deepEqual(run!.degraded, []);

  // The neutral request carried the cache boundary on the voice block, the
  // output schema, the effort, and the resolved model name (not the ref).
  const req = fake.requests[0];
  assert.equal(req.model, 'claude-opus-5');
  assert.deepEqual(req.system.map((s) => s.cacheBoundary), [false, true]);
  assert.equal(req.outputSchema, Draft);
  assert.equal(req.effort, 'medium');
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, 'user');
});

test('the owner\'s model choice overrides the server default per task', async () => {
  await AiSettings.create({ ownerId: owner, models: { primary: 'openrouter:meta-llama/llama-3.3-70b-instruct:free' } });
  const fake = fakeProvider([{ json: { subject: 's', body: 'b', usedMemoryIds: [] }, costUsd: 0 }], { name: 'openrouter', countTokens: null });
  __setProviderForTests(fake);
  const result = await runAgent({ ...base, context: draftingContext() });
  assert.equal(result.model, 'openrouter:meta-llama/llama-3.3-70b-instruct:free');
  assert.equal(fake.requests[0].model, 'meta-llama/llama-3.3-70b-instruct:free');
  const run = await AgentRun.findById(result.runId).lean();
  assert.equal(run!.provider, 'openrouter');
  assert.equal(run!.receipt.exact, false);     // no pre-call counting on this shape
  assert.equal(run!.costSource, 'provider');   // OpenRouter reported the cost (zero, free model)
  assert.equal(run!.costUsd, 0);
});

test('an explicit provider:model ref bypasses task resolution', async () => {
  const fake = fakeProvider([{ json: { subject: 's', body: 'b', usedMemoryIds: [] } }], { name: 'custom' });
  __setProviderForTests(fake);
  const result = await runAgent({ ...base, model: 'custom:llama3.2', context: draftingContext() });
  assert.equal(result.provider, 'custom');
  assert.equal(fake.requests[0].model, 'llama3.2');
});

test('a bad model ref fails before anything is recorded', async () => {
  __setProviderForTests(fakeProvider([]));
  await assert.rejects(runAgent({ ...base, model: 'no-colon', context: draftingContext() }), /provider:model/);
  await assert.rejects(runAgent({ ...base, model: 'gemini:flash', context: draftingContext() }), /unknown provider/);
  assert.equal(await AgentRun.countDocuments(), 0);
});

test('cost for an unknown model is 0 and marked unknown, never invented', async () => {
  const fake = fakeProvider([{ json: { subject: 's', body: 'b', usedMemoryIds: [] } }], { name: 'openai' });
  __setProviderForTests(fake);
  const result = await runAgent({ ...base, model: 'openai:gpt-5-mini', context: draftingContext() });
  const run = await AgentRun.findById(result.runId).lean();
  assert.equal(run!.costUsd, 0);
  assert.equal(run!.costSource, 'unknown');
});

test('degraded features reported by the adapter are recorded on the run', async () => {
  const fake = fakeProvider([{ text: 'Here you go:\n```json\n{"subject":"s","body":"b","usedMemoryIds":[]}\n```', degraded: ['json_schema'] }], { name: 'custom' });
  __setProviderForTests(fake);
  const result = await runAgent({ ...base, model: 'custom:some-small-model', context: draftingContext() });
  assert.deepEqual(result.degraded, ['json_schema']);
  assert.equal(result.output.subject, 's'); // fenced JSON from a compat model still parses
  const run = await AgentRun.findById(result.runId).lean();
  assert.deepEqual(run!.degraded, ['json_schema']);
});

test('a provider\'s own parsed output is preferred over the text', async () => {
  const fake = fakeProvider([{ text: 'ignored', parsed: { subject: 'from-parsed', body: 'b', usedMemoryIds: [] } }]);
  __setProviderForTests(fake);
  const result = await runAgent({ ...base, context: draftingContext() });
  assert.equal(result.output.subject, 'from-parsed');
});

test('a tool loop records each step and returns all results together', async () => {
  const fake = fakeProvider([
    { toolCalls: [
      { id: 'tu_1', name: 'get_email', input: { emailId: 'e1' } },
      { id: 'tu_2', name: 'get_email', input: { emailId: 'e2' } },
    ] },
    { json: { subject: 'Following up', body: 'Per my last two emails…', usedMemoryIds: ['mem-engage-1'] } },
  ]);
  __setProviderForTests(fake);

  const calls: string[] = [];
  const getEmail: AgentTool = {
    definition: {
      name: 'get_email',
      description: 'Full body of one prior email',
      inputSchema: { type: 'object', properties: { emailId: { type: 'string' } }, required: ['emailId'] },
    },
    execute: async (input) => {
      const { emailId } = input as { emailId: string };
      calls.push(emailId);
      if (emailId === 'e2') throw new Error('not found');
      return `Body of ${emailId}: We discussed the Q4 rollout.`;
    },
  };

  const result = await runAgent({ ...base, context: draftingContext(), tools: [getEmail], citedIds: (o) => o.usedMemoryIds });

  assert.deepEqual(calls, ['e1', 'e2']);
  const run = await AgentRun.findById(result.runId).lean();
  assert.equal(run!.steps.length, 2);
  assert.match(run!.steps[0].outputSummary, /Q4 rollout/);
  assert.equal(run!.steps[0].isError, false);
  assert.equal(run!.steps[1].isError, true);
  assert.match(run!.steps[1].outputSummary, /tool error: not found/);

  // Second request: the assistant turn (with the provider's raw content for
  // echoing) then ONE tool_results message carrying both results.
  const second = fake.requests[1].messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, 'assistant');
  assert.equal((second[1] as { raw?: { provider: string } }).raw?.provider, 'anthropic');
  assert.equal(second[2].role, 'tool_results');
  const results = (second[2] as { results: Array<{ id: string; isError?: boolean }> }).results;
  assert.deepEqual(results.map((r) => [r.id, r.isError]), [['tu_1', false], ['tu_2', true]]);
  assert.equal(run!.usage.input, 200);
  assert.deepEqual(fake.requests[0].tools?.map((t) => t.name), ['get_email']);
});

test('a tool loop that exceeds the step cap fails the run', async () => {
  const loop = { toolCalls: [{ id: 'tu', name: 'noop', input: {} }] };
  const fake = fakeProvider([loop, loop, loop, loop]);
  __setProviderForTests(fake);
  const noop: AgentTool = {
    definition: { name: 'noop', description: 'does nothing', inputSchema: { type: 'object', properties: {} } },
    execute: async () => 'ok',
  };
  await assert.rejects(
    runAgent({ ...base, kind: 'investigate', context: draftingContext(), tools: [noop], maxSteps: 2 }),
    (err: unknown) => err instanceof RunFailedError && /exceeded 2 steps/.test(err.message)
  );
  const run = await AgentRun.findOne({ kind: 'investigate' }).lean();
  assert.equal(run!.status, 'failed');
  assert.equal(run!.steps.length, 2);
  assert.equal(run!.output, undefined);
  assert.equal(fake.requests.length, 3);
});

test('output that fails the schema is a failed run with nothing stored', async () => {
  __setProviderForTests(fakeProvider([{ json: { subject: 'x', usedMemoryIds: 'not-an-array' } }]));
  await assert.rejects(
    runAgent({ ...base, context: draftingContext() }),
    (err: unknown) => err instanceof RunFailedError && /schema validation/.test(err.message)
  );
  const run = await AgentRun.findOne().lean();
  assert.equal(run!.status, 'failed');
  assert.equal(run!.output, undefined);
  assert.match(run!.error!, /body/);
  assert.equal(run!.usage.input, 100); // usage is still accounted for a failed call
});

test('output with no JSON at all is a failed run', async () => {
  __setProviderForTests(fakeProvider([{ text: 'Sure! Here is your draft: ...' }]));
  await assert.rejects(runAgent({ ...base, context: draftingContext() }), /not valid JSON/);
});

test('a draft that cites a memory id not in context is rejected', async () => {
  __setProviderForTests(fakeProvider([{ json: { subject: 's', body: 'b', usedMemoryIds: ['mem-commit-1', 'mem-huge', 'mem-invented'] } }]));
  await assert.rejects(
    runAgent({ ...base, context: draftingContext(), citedIds: (o) => o.usedMemoryIds }),
    (err: unknown) => err instanceof RunFailedError && /not in context: mem-huge, mem-invented/.test(err.message)
  );
  const run = await AgentRun.findOne().lean();
  assert.equal(run!.status, 'failed');
  assert.equal(run!.output, undefined);
});

test('a model refusal is recorded as refused with its category', async () => {
  __setProviderForTests(fakeProvider([{ stopReason: 'refusal', refusalCategory: 'other', usage: { input: 50, output: 0 } }]));
  await assert.rejects(runAgent({ ...base, context: draftingContext() }), /declined/);
  const run = await AgentRun.findOne().lean();
  assert.equal(run!.status, 'refused');
  assert.equal(run!.refusalCategory, 'other');
  assert.equal(run!.usage.input, 50);
});

test('a truncated response is a failed run', async () => {
  __setProviderForTests(fakeProvider([{ text: '{"subject": "cut off', stopReason: 'max_tokens' }]));
  await assert.rejects(runAgent({ ...base, context: draftingContext() }), /max_tokens/);
});

test('the daily ceiling counts today\'s spend for the same owner and kind only', async () => {
  process.env.AI_DAILY_TOKENS_DRAFT_FOLLOW_UP = '1000';
  const ok = { json: { subject: 's', body: 'b', usedMemoryIds: [] }, usage: { input: 600, output: 100 } };
  const fake = fakeProvider([ok, ok, ok, ok]); // four successful calls; the refused one never reaches the provider
  __setProviderForTests(fake);

  await runAgent({ ...base, context: draftingContext() });                 // 700 used
  await runAgent({ ...base, context: draftingContext() });                 // 1400 used (700 < 1000 passed the check)
  await assert.rejects(
    runAgent({ ...base, context: draftingContext() }),
    (err: unknown) => err instanceof BudgetExceededError && err.spent === 1400 && err.ceiling === 1000
  );
  await runAgent({ ...base, kind: 'contact_brief', context: draftingContext() });
  await runAgent({ ...base, ownerId: new mongoose.Types.ObjectId(), context: draftingContext() });

  const refused = await AgentRun.find({ status: 'refused' }).lean();
  assert.equal(refused.length, 1);
  assert.match(refused[0].error!, /1400 of 1000/);
  assert.equal(fake.requests.length, 4);
});

test('a running run counts against the budget before it finalises', async () => {
  process.env.AI_DAILY_TOKENS_DRAFT_FOLLOW_UP = '100';
  await AgentRun.create({ ownerId: owner, kind: 'draft_follow_up', modelId: 'anthropic:claude-opus-5', status: 'running', usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } });
  __setProviderForTests(fakeProvider([{ json: { subject: 's', body: 'b', usedMemoryIds: [] } }]));
  await assert.rejects(runAgent({ ...base, context: draftingContext() }), BudgetExceededError);
});

test('with AI disabled nothing is called and nothing is recorded', async () => {
  process.env.AI_ENABLED = 'false';
  const fake = fakeProvider([{ json: {} }]);
  __setProviderForTests(fake);
  await assert.rejects(runAgent({ ...base, context: draftingContext() }), AiDisabledError);
  assert.equal(await AgentRun.countDocuments(), 0);
  assert.equal(fake.requests.length, 0);
});

test('when the provider cannot count tokens the receipt keeps the estimate and says so', async () => {
  const fake = fakeProvider([{ json: { subject: 's', body: 'b', usedMemoryIds: [] } }], { countTokens: null });
  __setProviderForTests(fake);
  const ctx = draftingContext();
  const estimate = ctx.receipt.totalInputTokens;
  const result = await runAgent({ ...base, context: ctx });
  assert.equal(result.receipt.exact, false);
  assert.equal(result.receipt.totalInputTokens, estimate);
});

test('a provider error is recorded on the run and rethrown', async () => {
  const err = Object.assign(new Error('socket hang up'), { status: 502 });
  __setProviderForTests(fakeProvider([], { throwOnCall: err }));
  await assert.rejects(runAgent({ ...base, context: draftingContext() }), /socket hang up/);
  const run = await AgentRun.findOne().lean();
  assert.equal(run!.status, 'failed');
  assert.match(run!.error!, /provider error 502: socket hang up/);
});
