import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { fakeProvider } from './helpers/fakeProvider';
import { __setProviderForTests } from '../ai/providers';
import { ContextBuilder, wrapUntrusted } from '../ai/context/builder';
import { runAgent } from '../ai/runAgent';
import { AgentRun } from '../models/AgentRun';
import { ReplayReport } from '../models/ReplayReport';
import { Proposal } from '../models/Proposal';
import { Label } from '../models/Label';
import { User } from '../models/User';
import { ExtractionOutput } from '../ai/memory/extract';
import { EXTRACTION_SYSTEM } from '../ai/memory/extractPrompt';
import { ClassifyOutput } from '../ai/classify/llm';
import { replayRun, replaySample, jaccard, summarize, runDriftReplay, renderReportText } from '../ai/replay';
import app from '../app';

// Replay: a run keeps the exact prompt it was shown; re-executing it under
// a variant or the same prompt gives a comparison with numbers the
// correction loop already collects (kept and rejected items, human labels).

const owner = new mongoose.Types.ObjectId();
let server: http.Server;
let base: string;
const tokenFor = (id: mongoose.Types.ObjectId) => jwt.sign({ userId: id.toString() }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.AI_ENABLED = 'true';
  process.env.AI_ALLOW_SERVER_KEYS = 'false';
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
  await resetTestDb();
  __setProviderForTests(null);
  await User.create({ _id: owner, name: 'Me', email: 'me@example.com', emailAddress: 'me@example.com', password: 'x' });
});
after(async () => { __setProviderForTests(null); await new Promise<void>((r) => server.close(() => r())); await disconnectTestDb(); });

const EMAIL = 'Date: 2026-09-20\nFrom the sender to Priya <priya@example.com>\nSubject: Proposal\n\nThanks for the call. I will send the revised quote by Friday. We prefer annual billing.';

async function extractionRun(items: Array<{ kind: 'fact' | 'commitment' | 'preference'; content: string; quote: string }>) {
  const fake = fakeProvider([{ json: { items: items.map((i) => ({ ...i, confidence: 0.8 })), summary: 'A call happened.' } }], { name: 'custom' });
  __setProviderForTests(fake);
  const ctx = new ContextBuilder()
    .add({ name: 'system', budgetTokens: 600, stable: true, text: EXTRACTION_SYSTEM })
    .add({ name: 'task', budgetTokens: 3000, stable: false, text: `Email to extract from:\n\n${EMAIL}` })
    .build();
  return runAgent({ kind: 'extract_memory', ownerId: owner, model: 'extractor', context: ctx, outputSchema: ExtractionOutput, inputRefs: { emailIds: ['e1'] } });
}

test('runAgent stores the verbatim prompt (hidden by default) and skips it past the size limit', async () => {
  const r = await extractionRun([{ kind: 'commitment', content: 'Will send the revised quote by Friday', quote: 'I will send the revised quote by Friday' }]);
  const plain = (await AgentRun.findById(r.runId))!;
  assert.equal(plain.promptStored, true);
  assert.equal(plain.prompt, undefined);
  const withPrompt = (await AgentRun.findById(r.runId).select('+prompt'))!;
  assert.equal(withPrompt.prompt!.system[0].text, EXTRACTION_SYSTEM);
  assert.match(JSON.stringify(withPrompt.prompt!.messages), /revised quote by Friday/);

  process.env.AI_PROMPT_STORE_MAX_CHARS = '100';
  try {
    const small = await extractionRun([]);
    const s = (await AgentRun.findById(small.runId).select('+prompt'))!;
    assert.equal(s.promptStored, false);
    assert.equal(s.prompt, undefined);
    const row = await replayRun(small.runId);
    assert.equal(row.status, 'skipped');
    assert.match(row.error!, /no stored prompt/);
  } finally { delete process.env.AI_PROMPT_STORE_MAX_CHARS; }
});

test('replaying an extraction: variant replaces the system block; kept and rejected labels and verbatim quotes are scored; a report is stored', async () => {
  const original = await extractionRun([
    { kind: 'commitment', content: 'Will send the revised quote by Friday', quote: 'I will send the revised quote by Friday' },
    { kind: 'fact', content: 'Invented detail about a merger', quote: 'not in the email' },
  ]);
  // The correction loop: the human kept the commitment and rejected the invention.
  const run = await AgentRun.findById(original.runId);
  const p1 = await Proposal.create({ ownerId: owner, kind: 'memory_item', payload: { kind: 'commitment', content: 'Will send the revised quote by Friday' }, evidence: [], confidence: 0.8, runId: run!._id, status: 'accepted' });
  const p2 = await Proposal.create({ ownerId: owner, kind: 'memory_item', payload: { kind: 'fact', content: 'Invented detail about a merger' }, evidence: [], confidence: 0.8, runId: run!._id, status: 'rejected' });
  await Label.create({ ownerId: owner, runKind: 'extract_memory', runId: run!._id, proposalId: p1._id, verdict: 'accepted', labeledBy: owner });
  await Label.create({ ownerId: owner, runKind: 'extract_memory', runId: run!._id, proposalId: p2._id, verdict: 'rejected', labeledBy: owner });

  // The replay under a stricter variant finds the commitment and a preference, and drops the invention.
  const fake = fakeProvider([{ json: { items: [
    { kind: 'commitment', content: 'Send the revised quote by Friday', quote: 'send the revised quote by Friday', confidence: 0.9 },
    { kind: 'preference', content: 'Prefers annual billing', quote: 'We prefer annual billing', confidence: 0.8 },
  ] } }], { name: 'custom' });
  __setProviderForTests(fake);
  const row = await replayRun(original.runId, { variant: 'STRICT: only explicit claims.', variantSource: 'prompts/extract.strict.md', effort: 'low' });
  assert.equal(row.status, 'ok', row.error);
  assert.equal(fake.requests[0].system[0].text, 'STRICT: only explicit claims.');
  assert.match(fake.requests[0].messages.map((m) => (m as { text?: string }).text ?? '').join('\n'), /revised quote by Friday/);
  assert.equal(fake.requests[0].effort, 'low');
  assert.equal(row.checks.quotesVerbatim.value, 1);
  assert.equal(row.checks.keptItemsFound.value, 1);
  assert.equal(row.checks.rejectedItemsAvoided.value, 1);
  assert.equal(row.checks.itemCountDelta.value, 0);
  assert.ok(row.agreement! > 0.3 && row.agreement! < 1);
  const replayed = (await AgentRun.findById(row.replayRunId))!;
  assert.equal(replayed.kind, 'replay');
  assert.equal(replayed.inputRefs.replayOf, original.runId);
  assert.equal(replayed.inputRefs.variant, 'prompts/extract.strict.md');
  assert.deepEqual(replayed.inputRefs.emailIds, ['e1']);

  // A sample over the kind writes a report with a summary.
  __setProviderForTests(fakeProvider([{ json: { items: [{ kind: 'commitment', content: 'Will send the revised quote by Friday', quote: 'I will send the revised quote by Friday', confidence: 0.9 }] } }], { name: 'custom' }));
  const report = await replaySample(owner, { kind: 'extract_memory', since: new Date(Date.now() - 86_400_000), limit: 5, trigger: 'cli', variantSource: 'v2' });
  assert.equal(report.summary.n, 1);
  assert.equal(report.summary.ok, 1);
  assert.equal(report.summary.checks.keptItemsFound.mean, 1);
  assert.equal(report.summary.checks.rejectedItemsAvoided.mean, 1);
  assert.ok(report.summary.costUsd.replay >= 0);
  assert.match(renderReportText(report), /replay extract_memory: 1\/1 ok, variant v2/);
  assert.equal(await ReplayReport.countDocuments({ ownerId: owner }), 1);

  // Failures are rows, not crashes.
  __setProviderForTests(fakeProvider([], { name: 'custom', throwOnCall: new Error('provider down') }));
  const failed = await replayRun(original.runId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /provider down/);
});

test('classification replays score agreement and human labels; drift replays a sample per kind; the routes list and run reports', async () => {
  const fake = fakeProvider([{ json: { results: [{ id: 'm1', categoryKey: 'transactional', confidence: 0.9 }, { id: 'm2', categoryKey: 'personal_or_other', confidence: 0.6 }] } }], { name: 'custom' });
  __setProviderForTests(fake);
  const ctx = new ContextBuilder()
    .add({ name: 'system', budgetTokens: 600, stable: true, text: 'classify' })
    .add({ name: 'untrusted', budgetTokens: 3000, stable: false, text: wrapUntrusted('inbound', 'Message id: m1\nreceipt\nMessage id: m2\nlunch?') })
    .build();
  const orig = await runAgent({ kind: 'classify', ownerId: owner, model: 'extractor', context: ctx, outputSchema: ClassifyOutput, inputRefs: { inboundMessageIds: ['m1', 'm2'] } });
  const run = (await AgentRun.findById(orig.runId))!;
  // The human said m2 is needs_action.
  await Label.create({ ownerId: owner, runKind: 'classify', runId: run._id, verdict: 'edited', before: { categoryKey: 'personal_or_other', backend: 'llm', confidence: 0.6 }, after: { categoryKey: 'needs_action' }, labeledBy: owner });

  __setProviderForTests(fakeProvider([{ json: { results: [{ id: 'm1', categoryKey: 'transactional', confidence: 0.9 }, { id: 'm2', categoryKey: 'needs_action', confidence: 0.7 }] } }], { name: 'custom' }));
  const row = await replayRun(run._id);
  assert.equal(row.status, 'ok', row.error);
  assert.equal(row.agreement, 0.5);
  assert.equal(row.checks.matchesHumanLabels.value, 1);
  assert.equal(row.checks.allIdsAnswered.value, 1);

  // Drift: one report per kind with runs this week.
  __setProviderForTests(fakeProvider([{ json: { results: [{ id: 'm1', categoryKey: 'transactional', confidence: 0.9 }, { id: 'm2', categoryKey: 'personal_or_other', confidence: 0.6 }] } }], { name: 'custom' }));
  const reports = await runDriftReplay(owner, { perKind: 3 });
  assert.deepEqual(reports.map((r) => [r.kind, r.trigger, r.summary.n, r.summary.meanAgreement]), [['classify', 'drift', 1, 1]]);

  const list = await fetch(`${base}/api/ai/replays`, { headers: { Authorization: `Bearer ${tokenFor(owner)}` } });
  assert.equal(list.status, 200);
  const rows = await list.json() as Array<{ _id: string; kind: string; rows?: unknown }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rows, undefined);
  const one = await fetch(`${base}/api/ai/replays/${rows[0]._id}`, { headers: { Authorization: `Bearer ${tokenFor(owner)}` } });
  assert.equal((await one.json() as { rows: unknown[] }).rows.length, 1);
  assert.equal((await fetch(`${base}/api/ai/replays/${rows[0]._id}`, { headers: { Authorization: `Bearer ${tokenFor(new mongoose.Types.ObjectId())}` } })).status, 404);

  __setProviderForTests(fakeProvider([{ json: { results: [{ id: 'm1', categoryKey: 'transactional', confidence: 0.9 }, { id: 'm2', categoryKey: 'needs_action', confidence: 0.6 }] } }], { name: 'custom' }));
  const ran = await fetch(`${base}/api/ai/replays`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(owner)}` }, body: JSON.stringify({ kind: 'classify', limit: 2 }) });
  assert.equal(ran.status, 200);
  const rep = await ran.json() as { trigger: string; summary: { ok: number } };
  assert.equal(rep.trigger, 'user');
  assert.equal(rep.summary.ok, 1);
  assert.equal((await fetch(`${base}/api/ai/replays`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(owner)}` }, body: JSON.stringify({ kind: 'nope' }) })).status, 400);
});

test('helpers: jaccard and summarize', () => {
  assert.equal(jaccard('Send the quote by Friday', 'send the quote by friday'), 1);
  assert.equal(jaccard('', ''), 1);
  assert.ok(jaccard('Send the quote by Friday', 'Book a table for lunch') < 0.2);
  const s = summarize([
    { runId: new mongoose.Types.ObjectId(), status: 'ok', original: { model: 'a', costUsd: 0.01, tokens: 100 }, replay: { model: 'b', costUsd: 0.02, tokens: 120, ms: 5 }, checks: { quotesVerbatim: { value: 1 }, 'judge.voice': { value: true }, lengthDelta: { value: 10 }, judgeCostUsd: { value: 0.005 } }, agreement: 0.5 },
    { runId: new mongoose.Types.ObjectId(), status: 'ok', original: { model: 'a', costUsd: 0.01, tokens: 100 }, replay: { model: 'b', costUsd: 0.02, tokens: 80, ms: 5 }, checks: { quotesVerbatim: { value: 0.5 }, 'judge.voice': { value: false }, lengthDelta: { value: -10 } }, agreement: 1 },
    { runId: new mongoose.Types.ObjectId(), status: 'failed', original: { model: 'a', costUsd: 0.01, tokens: 100 }, checks: {} },
  ]);
  assert.deepEqual([s.n, s.ok, s.failed, s.meanAgreement], [3, 2, 1, 0.75]);
  assert.deepEqual(s.checks.quotesVerbatim, { pass: 1, of: 2, mean: 0.75 });
  assert.deepEqual(s.checks['judge.voice'], { pass: 1, of: 2, mean: undefined });
  assert.deepEqual(s.checks.lengthDelta, { pass: 2, of: 2, mean: 0 });
  assert.equal(s.checks.judgeCostUsd, undefined);
  assert.deepEqual(s.costUsd, { original: 0.03, replay: 0.04, judge: 0.005 });
  assert.deepEqual(s.tokens, { original: 300, replay: 200 });
});
