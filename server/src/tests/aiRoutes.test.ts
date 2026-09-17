import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import app from '../app';
import { AgentRun } from '../models/AgentRun';
import { Proposal } from '../models/Proposal';
import { Label } from '../models/Label';

// The HTTP surface the Runs page and the review inbox use, driven through the
// real Express app on an ephemeral port with real JWTs.

const owner = new mongoose.Types.ObjectId();
const stranger = new mongoose.Types.ObjectId();
let server: http.Server;
let base: string;

function tokenFor(id: mongoose.Types.ObjectId): string {
  return jwt.sign({ userId: id.toString() }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, who: mongoose.Types.ObjectId | null, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(who ? { Authorization: `Bearer ${tokenFor(who)}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
});
beforeEach(async () => {
  await resetTestDb();
  process.env.AI_ENABLED = 'true';
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectTestDb();
});

async function seedRun(ownerId: mongoose.Types.ObjectId, overrides: Record<string, unknown> = {}) {
  return AgentRun.create({
    ownerId,
    kind: 'draft_follow_up',
    modelId: 'claude-opus-5',
    status: 'succeeded',
    receipt: {
      sections: [{ name: 'system', tokens: 30, itemIds: [], droppedItemIds: [], cacheBoundary: false }],
      totalInputTokens: 30, exact: true, cacheReadTokens: 0,
    },
    steps: [{ tool: 'get_email', input: { emailId: 'e1' }, outputSummary: 'body', ms: 3 }],
    output: { subject: 'Hi', body: 'There' },
    usage: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.0004,
    ...overrides,
  });
}

test('every AI route requires a token', async () => {
  for (const [method, path] of [['GET', '/api/ai/status'], ['GET', '/api/ai/runs'], ['GET', '/api/ai/runs/x'], ['GET', '/api/ai/proposals'], ['POST', '/api/ai/proposals/x/decide']] as const) {
    const { status } = await call(method, path, null, method === 'POST' ? {} : undefined);
    assert.equal(status, 401, `${method} ${path}`);
  }
});

test('status reflects the AI_ENABLED flag', async () => {
  assert.equal((await call('GET', '/api/ai/status', owner)).json.enabled, true);
  process.env.AI_ENABLED = 'false';
  assert.equal((await call('GET', '/api/ai/status', owner)).json.enabled, false);
});

test('the run list is scoped to the owner, newest first, without steps or output', async () => {
  const older = await seedRun(owner, { startedAt: new Date(Date.now() - 60_000) });
  const newer = await seedRun(owner, { status: 'refused', error: 'budget' });
  await seedRun(stranger);

  const { status, json } = await call('GET', '/api/ai/runs', owner);
  assert.equal(status, 200);
  assert.deepEqual(json.map((r: { _id: string }) => r._id), [newer._id.toString(), older._id.toString()]);
  assert.equal(json[0].steps, undefined);
  assert.equal(json[0].output, undefined);
  assert.equal(json[0].usage.input, 30);
  assert.equal(json[0].error, 'budget');
});

test('run detail returns steps, output and receipt, and is 404 for another owner', async () => {
  const run = await seedRun(owner);
  const mine = await call('GET', `/api/ai/runs/${run._id}`, owner);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.steps[0].tool, 'get_email');
  assert.deepEqual(mine.json.output, { subject: 'Hi', body: 'There' });
  assert.equal(mine.json.receipt.sections[0].name, 'system');

  const theirs = await call('GET', `/api/ai/runs/${run._id}`, stranger);
  assert.equal(theirs.status, 404);
  const garbage = await call('GET', '/api/ai/runs/not-an-id', owner);
  assert.equal(garbage.status, 500);
});

test('the proposal inbox lists pending items and a decision writes a label', async () => {
  const run = await seedRun(owner);
  const pending = await Proposal.create({ ownerId: owner, kind: 'memory_item', payload: { content: 'fact' }, confidence: 0.8, runId: run._id });
  await Proposal.create({ ownerId: owner, kind: 'memory_item', payload: { content: 'old' }, confidence: 0.8, runId: run._id, status: 'rejected' });
  await Proposal.create({ ownerId: stranger, kind: 'memory_item', payload: { content: 'not mine' }, confidence: 0.8, runId: run._id });

  const inbox = await call('GET', '/api/ai/proposals', owner);
  assert.equal(inbox.json.length, 1);
  assert.equal(inbox.json[0]._id, pending._id.toString());
  const rejectedList = await call('GET', '/api/ai/proposals?status=rejected', owner);
  assert.equal(rejectedList.json.length, 1);

  const bad = await call('POST', `/api/ai/proposals/${pending._id}/decide`, owner, { decision: 'maybe' });
  assert.equal(bad.status, 400);

  const ok = await call('POST', `/api/ai/proposals/${pending._id}/decide`, owner, { decision: 'accept', reason: 'yes' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'accepted');
  assert.equal(ok.json.reason, 'yes');
  assert.equal(await Label.countDocuments({ ownerId: owner, verdict: 'accepted' }), 1);

  const notMine = await call('POST', `/api/ai/proposals/${pending._id}/decide`, stranger, { decision: 'reject' });
  assert.equal(notMine.status, 404);
});
