import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { submitProposal, decideProposal } from '../ai/corrections';
import { decideTrust } from '../ai/trustPolicy';
import { Proposal } from '../models/Proposal';
import { Label } from '../models/Label';
import { AgentRun } from '../models/AgentRun';

// The proposal primitive and the correction loop, exercised the way Phase 1
// will use them: an extraction run proposes a memory item, a human decides,
// and the decision becomes a label. Then the earned-autonomy policy: pending
// until the sample and rate are there, auto-accept once they are, and never
// for drafts no matter what.

const owner = new mongoose.Types.ObjectId();
const user = owner.toString();
let runId: mongoose.Types.ObjectId;

before(async () => { await connectTestDb(); });
beforeEach(async () => {
  await resetTestDb();
  process.env.AI_TRUST_POLICY_ENABLED = 'false';
  process.env.AI_TRUST_MIN_SAMPLE = '5';
  process.env.AI_TRUST_MIN_ACCEPTANCE = '0.8';
  process.env.AI_TRUST_MIN_CONFIDENCE = '0.7';
  const run = await AgentRun.create({ ownerId: owner, kind: 'extract_memory', modelId: 'claude-haiku-4-5', status: 'succeeded' });
  runId = run._id;
});
after(async () => { await disconnectTestDb(); });

const memoryItem = (confidence = 0.9) => ({
  ownerId: owner,
  kind: 'memory_item' as const,
  payload: { kind: 'commitment', content: 'You promised a revised quote by Friday.', structured: { by: 'sender', dueAt: '2026-09-19' } },
  evidence: [{ emailId: 'email-1', quote: "I'll send the revised quote by Friday" }],
  confidence,
  runId,
});

test('a new proposal is pending while the trust policy is off, and carries the reason', async () => {
  const p = await submitProposal(memoryItem());
  assert.equal(p.status, 'pending');
  assert.equal(p.reason, 'trust policy disabled');
  assert.equal(await Label.countDocuments(), 0);
});

test('accepting a proposal writes an "accepted" label against the extraction run', async () => {
  const p = await submitProposal(memoryItem());
  const decided = await decideProposal(p._id.toString(), user, 'accept', { reason: 'correct' });
  assert.equal(decided!.status, 'accepted');
  assert.equal(String(decided!.decidedBy), user);
  assert.ok(decided!.decidedAt);

  const labels = await Label.find().lean();
  assert.equal(labels.length, 1);
  assert.equal(labels[0].runKind, 'extract_memory');
  assert.equal(labels[0].verdict, 'accepted');
  assert.equal(labels[0].confidence, 0.9);
  assert.equal(String(labels[0].runId), String(runId));
  assert.deepEqual(labels[0].before, memoryItem().payload);

  const run = await AgentRun.findById(runId).lean();
  assert.equal((run!.inputRefs as { lastDecision?: { verdict: string } }).lastDecision?.verdict, 'accepted');
});

test('editing a proposal stores the correction pair and the corrected payload', async () => {
  const p = await submitProposal(memoryItem());
  const edited = { ...memoryItem().payload, content: 'You promised a revised quote by next Friday.' };
  const decided = await decideProposal(p._id.toString(), user, 'edit', { edited });
  assert.equal(decided!.status, 'accepted');
  assert.deepEqual(decided!.payload, edited);
  const label = await Label.findOne().lean();
  assert.equal(label!.verdict, 'edited');
  assert.deepEqual(label!.after, edited);
});

test('rejecting writes a "rejected" label; reverting an auto-accept counts as rejection', async () => {
  const p = await submitProposal(memoryItem());
  await decideProposal(p._id.toString(), user, 'reject', { reason: 'never said that' });
  const p2 = await Proposal.findById(p._id).lean();
  assert.equal(p2!.status, 'rejected');
  assert.equal(p2!.reason, 'never said that');

  const auto = await Proposal.create({ ...memoryItem(), status: 'auto_accepted', decidedBy: 'policy', decidedAt: new Date() });
  await decideProposal(auto._id.toString(), user, 'revert');
  const reverted = await Proposal.findById(auto._id).lean();
  assert.equal(reverted!.status, 'rejected');
  const verdicts = (await Label.find().sort({ createdAt: 1 }).lean()).map((l) => l.verdict);
  assert.deepEqual(verdicts, ['rejected', 'reverted']);
});

test('a user cannot decide another owner\'s proposal', async () => {
  const p = await submitProposal(memoryItem());
  const other = new mongoose.Types.ObjectId().toString();
  assert.equal(await decideProposal(p._id.toString(), other, 'accept'), null);
  assert.equal((await Proposal.findById(p._id).lean())!.status, 'pending');
});

test('trust is earned: pending until the sample and rate are there, then auto-accept', async () => {
  process.env.AI_TRUST_POLICY_ENABLED = 'true';

  // Fewer than minSample decided → pending.
  for (let i = 0; i < 4; i++) {
    const p = await submitProposal(memoryItem());
    await decideProposal(p._id.toString(), user, 'accept');
  }
  let d = await decideTrust(owner, 'memory_item', 0.95);
  assert.equal(d.outcome, 'pending');
  assert.match(d.reason, /sample 4 < 5/);

  // Fifth accepted → sample met, rate 100% → earned.
  const fifth = await submitProposal(memoryItem());
  await decideProposal(fifth._id.toString(), user, 'accept');
  d = await decideTrust(owner, 'memory_item', 0.95);
  assert.equal(d.outcome, 'auto_accept');
  assert.equal(d.sample, 5);
  assert.equal(d.acceptanceRate, 1);

  // Low confidence still waits for a human even when trust is earned.
  d = await decideTrust(owner, 'memory_item', 0.5);
  assert.equal(d.outcome, 'pending');
  assert.match(d.reason, /confidence/);

  // Now a submission is applied by policy and labelled as such.
  const auto = await submitProposal(memoryItem(0.95));
  assert.equal(auto.status, 'auto_accepted');
  assert.equal(auto.decidedBy, 'policy');
  const policyLabel = await Label.findOne({ labeledBy: 'policy' }).lean();
  assert.ok(policyLabel);
  assert.equal(policyLabel!.verdict, 'accepted');

  // The rate is measured over the last minSample (5) decided proposals, so
  // two reverts pull it under the threshold and trust is lost again.
  await decideProposal(auto._id.toString(), user, 'revert');
  const auto2 = await submitProposal(memoryItem(0.95));
  // window: [revert, accept, accept, accept, accept] = 4/5 = 0.80 → still auto (≥ 0.8)
  assert.equal(auto2.status, 'auto_accepted');
  await decideProposal(auto2._id.toString(), user, 'revert');
  // window: [revert, revert, accept, accept, accept] = 3/5 = 0.60 → pending
  const next = await submitProposal(memoryItem(0.95));
  assert.equal(next.status, 'pending');
  assert.match(next.reason!, /acceptance 0\.60 < 0\.8/);
});

test('a draft is never auto-accepted, even with a perfect record', async () => {
  process.env.AI_TRUST_POLICY_ENABLED = 'true';
  for (let i = 0; i < 10; i++) {
    const p = await submitProposal({ ...memoryItem(), kind: 'draft', payload: { subject: 's', body: 'b' } });
    await decideProposal(p._id.toString(), user, 'accept');
  }
  const d = await decideTrust(owner, 'draft', 1);
  assert.equal(d.outcome, 'pending');
  assert.equal(d.reason, 'draft is never auto-applied');
  const p = await submitProposal({ ...memoryItem(), kind: 'draft', payload: { subject: 's', body: 'b' }, confidence: 1 });
  assert.equal(p.status, 'pending');
});

test('acceptance is measured per owner and per kind', async () => {
  process.env.AI_TRUST_POLICY_ENABLED = 'true';
  for (let i = 0; i < 5; i++) {
    const p = await submitProposal(memoryItem());
    await decideProposal(p._id.toString(), user, 'accept');
  }
  assert.equal((await decideTrust(owner, 'memory_item', 0.95)).outcome, 'auto_accept');
  assert.equal((await decideTrust(owner, 'brief', 0.95)).outcome, 'pending');
  assert.equal((await decideTrust(new mongoose.Types.ObjectId(), 'memory_item', 0.95)).outcome, 'pending');
});
