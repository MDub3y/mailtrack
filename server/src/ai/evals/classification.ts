import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { connectDB } from '../../config/db';
import { User } from '../../models/User';
import { AgentRun } from '../../models/AgentRun';
import { AiSettings } from '../../models/AiSettings';
import { preClassify } from '../classify/headers';
import { loadCategories, toDef } from '../classify/categories';
import { embeddingsBackend } from '../classify/embeddings';
import { llmBackend } from '../classify/llm';
import type { ClassifiableMessage, ClassificationResult, ClassifierBackend } from '../classify/types';

// Classification eval (Phase 4): a golden inbox against the free header
// stage and, on request, each cheap backend with the first user's keys.
// Mirrors production: a message the header stage decides never reaches a
// backend. Reports coverage, accuracy, per-category precision and recall,
// the misses, the cost, and whether confidence separates right from wrong.
//
//   npm run eval:classification                       header stage only; no DB, no key
//   npm run eval:classification -- --backend llm      + the LLM backend (needs a key)
//   npm run eval:classification -- --backend all      + embeddings and llm
//   npm run eval:classification -- --owner me@x.com   whose keys and category definitions

interface GoldenMessage {
  id: string;
  from: string;
  subject: string;
  text: string;
  matchedTracked?: boolean;
  headers?: { listUnsubscribe?: boolean; listId?: string; precedence?: string; autoSubmitted?: string; hasCalendarPart?: boolean };
  expect: string;
}

export function goldenMessages(): GoldenMessage[] {
  const file = path.join(__dirname, 'seed', 'inbox.json');
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { messages: GoldenMessage[] }).messages;
}

export function toClassifiable(m: GoldenMessage): ClassifiableMessage {
  return {
    id: m.id, subject: m.subject, text: m.text, from: m.from, matchedTracked: !!m.matchedTracked,
    headers: { listUnsubscribe: !!m.headers?.listUnsubscribe, listId: m.headers?.listId, precedence: m.headers?.precedence, autoSubmitted: m.headers?.autoSubmitted, hasCalendarPart: !!m.headers?.hasCalendarPart, references: [], fromAddress: m.from },
  };
}

export interface StageMetrics {
  n: number;
  decided: number;
  correct: number;
  perCategory: Record<string, { expected: number; predicted: number; correct: number }>;
  misses: Array<{ id: string; expected: string; predicted: string; confidence: number; reason?: string }>;
  meanConfidenceCorrect: number;
  meanConfidenceWrong: number;
}

export function score(golden: GoldenMessage[], results: Map<string, ClassificationResult>): StageMetrics {
  const per: StageMetrics['perCategory'] = {};
  const bump = (k: string, f: 'expected' | 'predicted' | 'correct') => { per[k] = per[k] ?? { expected: 0, predicted: 0, correct: 0 }; per[k][f] += 1; };
  const misses: StageMetrics['misses'] = [];
  let decided = 0, correct = 0;
  const confRight: number[] = [], confWrong: number[] = [];
  for (const g of golden) {
    bump(g.expect, 'expected');
    const r = results.get(g.id);
    if (!r) continue;
    decided += 1;
    bump(r.categoryKey, 'predicted');
    if (r.categoryKey === g.expect) { correct += 1; bump(g.expect, 'correct'); confRight.push(r.confidence); }
    else { misses.push({ id: g.id, expected: g.expect, predicted: r.categoryKey, confidence: r.confidence, reason: r.reason }); confWrong.push(r.confidence); }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return { n: golden.length, decided, correct, perCategory: per, misses, meanConfidenceCorrect: mean(confRight), meanConfidenceWrong: mean(confWrong) };
}

function pct(a: number, b: number): string { return b === 0 ? 'n/a' : `${a}/${b} = ${(100 * a / b).toFixed(0)}%`; }

function print(title: string, m: StageMetrics, extra: string[] = []): void {
  console.log(`\n== ${title}`);
  console.log(`decided: ${pct(m.decided, m.n)}   accuracy on decided: ${pct(m.correct, m.decided)}`);
  for (const line of extra) console.log(line);
  for (const [k, v] of Object.entries(m.perCategory).sort()) {
    console.log(`  ${k.padEnd(20)} precision ${pct(v.correct, v.predicted).padEnd(14)} recall ${pct(v.correct, v.expected)}`);
  }
  if (m.misses.length) {
    console.log('  misses:');
    for (const x of m.misses) console.log(`    ${x.id.padEnd(16)} expected ${x.expected.padEnd(20)} got ${x.predicted.padEnd(20)} conf ${x.confidence.toFixed(2)}${x.reason ? `  (${x.reason})` : ''}`);
  }
  if (m.decided) console.log(`  mean confidence when right ${m.meanConfidenceCorrect.toFixed(2)}, when wrong ${m.meanConfidenceWrong.toFixed(2)}`);
}

async function runBackend(backend: ClassifierBackend, ownerId: string, golden: GoldenMessage[], remaining: ClassifiableMessage[]): Promise<void> {
  const avail = await backend.available(ownerId);
  if (!avail.ok) { console.log(`\n== ${backend.name}: not available (${avail.reason})`); return; }
  const defs = (await loadCategories(ownerId)).map(toDef);
  const since = new Date();
  const t0 = Date.now();
  const results = new Map<string, ClassificationResult>();
  try {
    for (const r of await backend.classify(ownerId, defs, remaining)) results.set(r.id, r);
  } catch (err) {
    console.log(`\n== ${backend.name}: failed (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  const runs = await AgentRun.find({ ownerId, kind: { $in: ['classify', 'embed'] }, startedAt: { $gte: since } }).select('kind usage costUsd status').lean();
  const cost = runs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const tokens = runs.reduce((n, r) => n + (r.usage?.input ?? 0) + (r.usage?.output ?? 0), 0);
  const only = golden.filter((g) => remaining.some((m) => m.id === g.id));
  print(`${backend.name} (${avail.modelRef}) on the ${remaining.length} messages the header stage left`, score(only, results), [
    `runs: ${runs.length} (${runs.filter((r) => r.status === 'succeeded').length} succeeded), tokens: ${tokens}, cost: $${cost.toFixed(5)}, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    `categories used: the owner's own definitions (${defs.length}), which may differ from the defaults`,
  ]);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const backendArg = args.includes('--backend') ? args[args.indexOf('--backend') + 1] : 'headers';
  const ownerArg = args.includes('--owner') ? args[args.indexOf('--owner') + 1] : undefined;
  const golden = goldenMessages();
  const all = golden.map(toClassifiable);

  const headerResults = new Map<string, ClassificationResult>();
  for (const m of all) { const r = preClassify(m); if (r) headerResults.set(m.id, r); }
  const remaining = all.filter((m) => !headerResults.has(m.id));
  print('header stage (free)', score(golden, headerResults), [`coverage: ${headerResults.size} of ${golden.length} decided without a model; ${remaining.length} go to the cheap backend`]);

  if (backendArg === 'headers') return;
  await connectDB();
  const owner = ownerArg ? await User.findOne({ email: ownerArg.toLowerCase() }) : await User.findOne().sort({ createdAt: 1 });
  if (!owner) throw new Error('no user found');
  const settings = await AiSettings.findOne({ ownerId: owner._id }).select('models').lean();
  console.log(`\nowner: ${owner.email}; extractor ${settings?.models?.extractor ?? '(default)'}, embedder ${settings?.models?.embedder ?? '(default)'}`);
  const ownerId = owner._id.toString();
  if (backendArg === 'embeddings' || backendArg === 'all') await runBackend(embeddingsBackend, ownerId, golden, remaining);
  if (backendArg === 'llm' || backendArg === 'all') await runBackend(llmBackend, ownerId, golden, remaining);
  await mongoose.disconnect();
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
