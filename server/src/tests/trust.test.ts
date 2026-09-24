import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import app from '../app';
import { User } from '../models/User';
import { AgentRun } from '../models/AgentRun';
import { AiSettings } from '../models/AiSettings';
import { Proposal } from '../models/Proposal';
import { Label } from '../models/Label';
import { trustConfig, decideTrust, trustOverview } from '../ai/trustPolicy';
import { submitProposal, decideProposal } from '../ai/corrections';

// Earned autonomy, on by default and visible: server switch, owner
// thresholds within limits, the per-kind overview, and calibration of
// confidence against the owner's decisions.

const owner = new mongoose.Types.ObjectId();
const user = owner.toString();
let runId: mongoose.Types.ObjectId;
let server: http.Server;
let base: string;
const tokenFor = (id: mongoose.Types.ObjectId) => jwt.sign({ userId: id.toString() }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(owner)}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
  await resetTestDb();
  delete process.env.AI_TRUST_POLICY_ENABLED;
  delete process.env.AI_TRUST_MIN_SAMPLE; delete process.env.AI_TRUST_MIN_ACCEPTANCE; delete process.env.AI_TRUST_MIN_CONFIDENCE;
  await User.create({ _id: owner, name: 'Me', email: 'me@example.com', emailAddress: 'me@example.com', password: 'x' });
  runId = (await AgentRun.create({ ownerId: owner, kind: 'extract_memory', modelId: 'x', status: 'succeeded' }))._id;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); await disconnectTestDb(); });

const item = (confidence: number) => ({ ownerId: owner, kind: 'memory_item' as const, payload: { kind: 'fact', content: `fact ${Math.random()}` }, confidence, runId });

test('on by default with the documented thresholds; the server switch wins; owner values are clamped', async () => {
  let c = await trustConfig(owner);
  assert.deepEqual([c.enabled, c.minSample, c.minAcceptanceRate, c.minConfidence, c.source], [true, 50, 0.95, 0.8, { enabled: 'default', thresholds: 'default' }]);

  await AiSettings.create({ ownerId: owner, trust: { enabled: true, minSample: 5, minAcceptanceRate: 0.5, minConfidence: 2 } });
  c = await trustConfig(owner);
  assert.deepEqual([c.minSample, c.minAcceptanceRate, c.minConfidence, c.source.thresholds], [10, 0.8, 1, 'owner']);

  process.env.AI_TRUST_POLICY_ENABLED = 'false';
  c = await trustConfig(owner);
  assert.equal(c.enabled, false);
  assert.equal(c.source.enabled, 'server');
  assert.equal((await decideTrust(owner, 'memory_item', 1)).reason, 'trust policy disabled');
  delete process.env.AI_TRUST_POLICY_ENABLED;

  await AiSettings.updateOne({ ownerId: owner }, { $set: { 'trust.enabled': false } });
  c = await trustConfig(owner);
  assert.equal(c.enabled, false);
  assert.equal(c.source.enabled, 'owner');
});

test('the overview shows what was measured per kind and calibrates confidence against decisions; the routes read and write thresholds', async () => {
  await AiSettings.create({ ownerId: owner, trust: { minSample: 10, minAcceptanceRate: 0.8, minConfidence: 0.7 } });
  // Nine decided, oldest first: low-confidence ones rejected, then high-confidence ones accepted.
  for (let i = 0; i < 3; i++) { const p = await submitProposal(item(0.55)); await decideProposal(p._id.toString(), user, 'reject'); }
  for (let i = 0; i < 6; i++) { const p = await submitProposal(item(0.9)); await decideProposal(p._id.toString(), user, 'accept'); }
  await submitProposal(item(0.9)); // one waiting

  let v = await trustOverview(owner);
  const mem = v.kinds.find((k) => k.kind === 'memory_item')!;
  assert.deepEqual([mem.reversible, mem.sample, mem.acceptanceRate, mem.earned, mem.pending, mem.autoAccepted30d], [true, 9, 0.667, false, 1, 0]);
  assert.match(mem.reason, /sample 9 < 10/);
  const draft = v.kinds.find((k) => k.kind === 'draft')!;
  assert.deepEqual([draft.reversible, draft.earned], [false, false]);
  assert.match(draft.reason, /never auto-applied/);
  const cal = v.calibration.memory_item;
  assert.equal(cal.n, 9);
  assert.deepEqual(cal.buckets.map((b) => [b.from, b.n, b.rate]), [[0.5, 3, 0], [0.9, 6, 1]]);
  assert.equal(cal.suggestedMinConfidence, 0.9);

  // Two more accepted: the last ten are 8 accepts and 2 rejects = 0.8 → earned; then an auto-accept and a revert show up.
  for (let i = 0; i < 2; i++) { const p = await submitProposal(item(0.9)); await decideProposal(p._id.toString(), user, 'accept'); }
  const auto = await submitProposal(item(0.95));
  assert.equal(auto.status, 'auto_accepted');
  await decideProposal(auto._id.toString(), user, 'revert');
  v = await trustOverview(owner);
  const mem2 = v.kinds.find((k) => k.kind === 'memory_item')!;
  assert.equal(mem2.autoAccepted30d, 0); // reverted ones are no longer auto_accepted
  assert.equal(mem2.reverted30d, 1);
  assert.equal(await Proposal.countDocuments({ ownerId: owner, status: 'rejected' }), 4);
  assert.equal(await Label.countDocuments({ ownerId: owner, verdict: 'reverted' }), 1);

  const got = await call('GET', '/api/ai/trust');
  assert.equal(got.status, 200);
  assert.equal(got.json.config.minSample, 10);
  assert.equal(got.json.kinds.length, 7);
  const put = await call('PUT', '/api/ai/trust', { minSample: 20, minConfidence: 0.9, enabled: true });
  assert.equal(put.status, 200);
  assert.deepEqual([put.json.config.minSample, put.json.config.minConfidence, put.json.config.minAcceptanceRate], [20, 0.9, 0.8]);
  assert.equal((await call('PUT', '/api/ai/trust', { minSample: 5 })).status, 400);
  assert.equal((await call('PUT', '/api/ai/trust', { minAcceptanceRate: 0.5 })).status, 400);
});
