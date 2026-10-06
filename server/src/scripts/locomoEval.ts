import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'fs';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { connectDB } from '../config/db';
import { User } from '../models/User';
import { Email } from '../models/Email';
import { Contact } from '../models/Contact';
import { Memory } from '../models/Memory';
import { Proposal } from '../models/Proposal';
import { AgentRun } from '../models/AgentRun';
import { Label } from '../models/Label';
import { ensureContact } from '../services/signalService';
import { extractMemoryForEmail } from '../ai/memory/extract';
import { decideProposal } from '../ai/corrections';
import { runAgent } from '../ai/runAgent';
import { ContextBuilder } from '../ai/context/builder';

// LoCoMo (Maharana et al., 2024) run through the real MailTrack pipeline.
// Each conversation's speaker A becomes the owner, speaker B a contact; each
// dated session becomes an email thread, each turn one Email (outbound for
// the owner, inbound/untrusted for the contact). Extraction runs per email
// exactly as in production; inbound items land as proposals and a scripted
// "user" accepts them (the one divergence from production, stated in the
// report, because the benchmark has no human in the loop). QA is answered
// from stored active memory only - the model never sees the conversation.
//
//   npm run eval:locomo -- --data <locomo10.json> [--conv 0] [--qa-limit 60] [--skip-ingest]
//
// Scoring is deterministic (token F1 + containment; adversarial questions
// count as correct on an explicit "no information"), so re-scoring is free.

process.env.AI_QUEUE_DISABLED = 'true';
process.env.AI_DAILY_TOKENS_EXTRACT_MEMORY = process.env.AI_DAILY_TOKENS_EXTRACT_MEMORY || '5000000';
process.env.AI_DAILY_TOKENS_JUDGE = process.env.AI_DAILY_TOKENS_JUDGE || '5000000';

const OWNER_EMAIL = 'locomo@eval.local';

interface Turn { speaker: string; dia_id: string; text: string }
interface Qa { question: string; answer?: string | number; evidence?: string[]; category: number }
const CATEGORY: Record<number, string> = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' };

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s: string) => norm(s).split(' ').filter(Boolean);

function f1(pred: string, gold: string): number {
  const p = tokens(pred), g = tokens(gold);
  if (!p.length || !g.length) return 0;
  const gCount = new Map<string, number>();
  g.forEach((t) => gCount.set(t, (gCount.get(t) ?? 0) + 1));
  let overlap = 0;
  for (const t of p) { const c = gCount.get(t) ?? 0; if (c > 0) { overlap += 1; gCount.set(t, c - 1); } }
  if (!overlap) return 0;
  const prec = overlap / p.length, rec = overlap / g.length;
  return (2 * prec * rec) / (prec + rec);
}

const NO_INFO = /no information|not mentioned|unknown|no memory|cannot be determined|not specified/i;

async function main(): Promise<void> {
  const dataPath = arg('data');
  if (!dataPath || !fs.existsSync(dataPath)) { console.error('pass --data <locomo10.json>'); process.exit(1); }
  const convIndex = Number(arg('conv') ?? 0);
  const qaLimit = Number(arg('qa-limit') ?? 0);
  const all = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const sample = all[convIndex];
  if (!sample) { console.error(`no conversation at index ${convIndex}`); process.exit(1); }
  const conv = sample.conversation;
  const speakerA: string = conv.speaker_a, speakerB: string = conv.speaker_b;
  const contactAddress = `${speakerB.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@locomo.eval`;

  await connectDB();

  let owner = await User.findOne({ email: OWNER_EMAIL });
  if (!owner) owner = await User.create({ name: speakerA, email: OWNER_EMAIL, emailAddress: OWNER_EMAIL, password: uuidv4() });
  const ownerId = owner._id;

  if (!has('skip-ingest')) {
    if (!has('resume')) {
      // Idempotent: clear this owner's previous eval world first.
      const contactIds = (await Contact.find({ ownerId }).select('_id')).map((c) => c._id);
      await Promise.all([
        Email.deleteMany({ senderId: ownerId }),
        Memory.deleteMany({ ownerId }),
        Proposal.deleteMany({ ownerId }),
        Label.deleteMany({ ownerId }),
        Contact.deleteMany({ _id: { $in: contactIds } }),
      ]);
    }
    // With --resume, turns already stored are skipped, so ingest can run in
    // bounded chunks and pick up where the previous chunk stopped.
    const already = has('resume') ? await Email.countDocuments({ senderId: ownerId }) : 0;
    let globalIndex = 0;
    const contact = await ensureContact(ownerId, contactAddress, { displayName: speakerB });

    // Sessions in order, each turn one Email with a real date so temporal
    // questions are answerable from what the extractor saw.
    const sessionKeys = Object.keys(conv).filter((k) => /^session_\d+$/.test(k)).sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
    let created = 0, extracted = 0, dropped = 0, failures = 0;
    for (const key of sessionKeys) {
      const turns: Turn[] = conv[key];
      // LoCoMo dates look like "1:56 pm on 8 May, 2023" — take the day part.
      const raw: string = conv[`${key}_date_time`] ?? '';
      const m = raw.match(/on\s+(\d{1,2})\s+(\w+),?\s+(\d{4})/i);
      const when = m ? new Date(`${m[1]} ${m[2]} ${m[3]} 12:00:00 UTC`) : new Date();
      if (Number.isNaN(when.getTime())) throw new Error(`unparseable session date: "${raw}"`);
      for (let t = 0; t < turns.length; t++) {
        if (globalIndex++ < already) continue;
        const turn = turns[t];
        const outbound = turn.speaker === speakerA;
        const createdAt = new Date(when.getTime() + t * 60_000);
        const email = await Email.create({
          senderId: ownerId,
          contactId: contact._id,
          from: outbound ? OWNER_EMAIL : contactAddress,
          to: outbound ? contactAddress : OWNER_EMAIL,
          subject: `${key.replace('_', ' ')} (${createdAt.toISOString().slice(0, 10)})`,
          textBody: turn.text,
          htmlBody: `<p>${turn.text}</p>`,
          trackingToken: uuidv4(),
          direction: outbound ? 'outbound' : 'inbound',
          createdAt,
        });
        created += 1;
        try {
          const r = await extractMemoryForEmail(email._id.toString(), outbound ? 'outbound' : 'inbound');
          if (r) { extracted += r.extracted; dropped += r.droppedForQuote; }
        } catch (err) {
          failures += 1;
          console.error(`  extract failed on ${key}#${t}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
        }
        process.stdout.write(`\r${key} ${t + 1}/${turns.length} | emails ${created}, items ${extracted}, quote-dropped ${dropped}, failures ${failures}   `);
      }
    }
    console.log();

    // The scripted user: accept every pending proposal (the benchmark has no
    // human; production would wait for one). Each accept is still a Label.
    const pending = await Proposal.find({ ownerId, status: 'pending' }).select('_id');
    for (const p of pending) await decideProposal(p._id.toString(), ownerId.toString(), 'accept', { reason: 'locomo eval: scripted accept' });
    console.log(`ingested ${created} emails -> ${extracted} items proposed (${dropped} dropped by the verbatim check, ${failures} failures); accepted ${pending.length} pending proposals`);
    if (has('ingest-only')) { await mongoose.disconnect(); return; }
  }

  // ---- QA from memory only -------------------------------------------------
  const contact = await Contact.findOne({ ownerId, address: contactAddress });
  if (!contact) { console.error('no contact; run without --skip-ingest first'); process.exit(1); }
  const memories = await Memory.find({ ownerId, subjectId: contact._id, status: 'active' }).sort({ createdAt: 1 }).lean();
  console.log(`active memory for ${speakerB}: ${memories.length} items`);
  const memoryLines = memories.map((m) => `- (${m.kind}, noted ${new Date(m.createdAt).toISOString().slice(0, 10)}) ${m.content}`).join('\n');

  let qas: Qa[] = sample.qa;
  if (qaLimit > 0) {
    // Stratified: keep the category mix of the full set.
    const byCat = new Map<number, Qa[]>();
    qas.forEach((q) => byCat.set(q.category, [...(byCat.get(q.category) ?? []), q]));
    const picked: Qa[] = [];
    for (const [, list] of byCat) picked.push(...list.slice(0, Math.max(1, Math.round((list.length / qas.length) * qaLimit))));
    qas = picked.slice(0, qaLimit);
  }

  const AnswerOut = z.object({ answer: z.string() });
  const scores: Array<{ category: number; f1: number; correct: boolean }> = [];
  let tokensUsed = 0, costUsd = 0;
  for (let i = 0; i < qas.length; i++) {
    const qa = qas[i];
    const gold = String(qa.answer ?? 'No information in memory');
    const ctx = new ContextBuilder()
      .add({ name: 'system', budgetTokens: 400, stable: true, text: `You answer questions about ${speakerB} using ONLY the memory notes provided. Answer in as few words as possible (a date, a name, a short phrase). If the notes do not contain the answer, reply exactly: No information in memory.` })
      .add({ name: 'memory', budgetTokens: 6000, stable: true, text: `Memory notes about ${speakerB} (from correspondence with ${speakerA}):\n${memoryLines}` })
      .add({ name: 'task', budgetTokens: 300, stable: false, text: `Question: ${qa.question}` })
      .build();
    try {
      const r = await runAgent({ kind: 'judge', ownerId, model: 'extractor', context: ctx, outputSchema: AnswerOut, maxTokens: 2000 });
      const pred = r.output.answer;
      const isAdversarial = qa.category === 5;
      const score = f1(pred, gold);
      const correct = isAdversarial ? NO_INFO.test(pred) : (score >= 0.5 || norm(pred).includes(norm(gold)) || norm(gold).includes(norm(pred)));
      scores.push({ category: qa.category, f1: isAdversarial ? (correct ? 1 : 0) : score, correct });
      tokensUsed += (r.usage?.input ?? 0) + (r.usage?.output ?? 0); costUsd += r.costUsd ?? 0;
      process.stdout.write(`\rQA ${i + 1}/${qas.length} | running acc ${(scores.filter((s) => s.correct).length / scores.length * 100).toFixed(0)}%   `);
    } catch (err) {
      scores.push({ category: qa.category, f1: 0, correct: false });
      console.error(`\n  qa failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
  }
  console.log('\n');

  // ---- report --------------------------------------------------------------
  const by = (cat: number) => scores.filter((s) => s.category === cat);
  console.log(`== LoCoMo conv ${convIndex} (${speakerA} & ${speakerB}) through the MailTrack memory pipeline`);
  console.log(`questions: ${scores.length}  overall accuracy: ${(scores.filter((s) => s.correct).length / scores.length * 100).toFixed(1)}%  mean F1: ${(scores.reduce((a, s) => a + s.f1, 0) / scores.length).toFixed(3)}`);
  for (const cat of [4, 1, 2, 3, 5]) {
    const g = by(cat);
    if (g.length) console.log(`  ${CATEGORY[cat].padEnd(11)} n=${String(g.length).padStart(3)}  acc ${(g.filter((s) => s.correct).length / g.length * 100).toFixed(0).padStart(3)}%  F1 ${(g.reduce((a, s) => a + s.f1, 0) / g.length).toFixed(3)}`);
  }
  console.log(`qa tokens: ${tokensUsed}, qa cost: $${costUsd.toFixed(5)}`);
  const runs = await AgentRun.aggregate([
    { $match: { ownerId, kind: 'extract_memory' } },
    { $group: { _id: null, n: { $sum: 1 }, tokens: { $sum: { $add: [{ $ifNull: ['$usage.input', 0] }, { $ifNull: ['$usage.output', 0] }] } }, cost: { $sum: '$costUsd' } } },
  ]);
  if (runs[0]) console.log(`extraction runs: ${runs[0].n}, tokens: ${runs[0].tokens}, cost: $${(runs[0].cost ?? 0).toFixed(5)}`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
