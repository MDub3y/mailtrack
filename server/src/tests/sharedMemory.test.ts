import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import app from '../app';
import { User } from '../models/User';
import { Organization } from '../models/Organization';
import { Contact } from '../models/Contact';
import { Memory } from '../models/Memory';
import { ensureContact, recordSignal } from '../services/signalService';
import { sharedContactView, sharingStatus, sharedCounts } from '../services/sharedMemoryService';

// Organisation-shared memory: each member keeps their own; opting in makes
// what you know about an address visible to colleagues who also opted in,
// attributed per member. Nothing proposed, rejected, private or bodily
// crosses; a member outside the organisation sees nothing.

const org = new mongoose.Types.ObjectId();
const alice = new mongoose.Types.ObjectId();
const bob = new mongoose.Types.ObjectId();
const carol = new mongoose.Types.ObjectId();   // same org, not sharing
const dave = new mongoose.Types.ObjectId();    // no org
let server: http.Server;
let base: string;
const tokenFor = (id: mongoose.Types.ObjectId) => jwt.sign({ userId: id.toString() }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, who: mongoose.Types.ObjectId, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(who)}` }, body: body === undefined ? undefined : JSON.stringify(body) });
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
  await Organization.create({ _id: org, name: 'Acme', domain: 'acme.example', sendgridApiKey: 'k', fromEmail: 'hello@acme.example', createdBy: alice });
  await User.create({ _id: alice, name: 'Alice', email: 'alice@acme.example', emailAddress: 'alice@acme.example', password: 'x', organizationId: org });
  await User.create({ _id: bob, name: 'Bob', email: 'bob@acme.example', emailAddress: 'bob@acme.example', password: 'x', organizationId: org });
  await User.create({ _id: carol, name: 'Carol', email: 'carol@acme.example', emailAddress: 'carol@acme.example', password: 'x', organizationId: org });
  await User.create({ _id: dave, name: 'Dave', email: 'dave@example.com', emailAddress: 'dave@example.com', password: 'x' });
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); await disconnectTestDb(); });

async function know(owner: mongoose.Types.ObjectId, address: string, items: Array<{ kind: 'fact' | 'commitment' | 'preference'; content: string; status?: string }>) {
  const c = await ensureContact(owner, address);
  await recordSignal({ ownerId: owner, contactId: c._id, type: 'sent', at: new Date(), verdict: 'human', source: 'system', dedupeKey: `sent:${owner}:${address}` });
  for (const i of items) await Memory.create({ ownerId: owner, scope: 'contact', subjectId: c._id, kind: i.kind, content: i.content, confidence: 0.9, source: 'agent', status: i.status ?? 'active', evidence: [{ quote: 'q'.repeat(300) }] });
  return c;
}

test('sharing is reciprocal and organisation-bound; items are attributed to the member and filtered to active', async () => {
  const vendor = 'vendor@supplier.example';
  await know(alice, vendor, [{ kind: 'fact', content: 'Alice knows: pricing is annual' }]);
  await know(bob, vendor, [{ kind: 'commitment', content: 'Bob: they promised a quote' }, { kind: 'fact', content: 'Bob proposed item', status: 'proposed' }, { kind: 'fact', content: 'Bob rejected item', status: 'rejected' }]);
  await know(carol, vendor, [{ kind: 'fact', content: 'Carol private' }]);
  await know(dave, vendor, [{ kind: 'fact', content: 'Dave elsewhere' }]);
  await Contact.updateOne({ ownerId: bob, address: vendor }, { $set: { brief: { text: 'Bob\'s brief', citedMemoryIds: [], basedOnSignalCount: 1, generatedAt: new Date(), runId: new mongoose.Types.ObjectId() } } });

  // Nobody shares yet.
  let st = await sharingStatus(alice);
  assert.deepEqual(st, { inOrganization: true, sharing: false, members: 3, membersSharing: 0 });
  assert.deepEqual((await sharedContactView(alice, vendor)).colleagues, []);

  // Alice shares, Bob does not yet: Alice sees nothing (nobody else shares).
  assert.deepEqual((await call('PUT', '/api/organizations/me/sharing', alice, { enabled: true })).json, { enabled: true, organizationId: org.toString() });
  assert.deepEqual((await sharedContactView(alice, vendor)).colleagues, []);
  // Bob shares: each sees the other's, not Carol's (not sharing) nor Dave's (other org).
  await call('PUT', '/api/organizations/me/sharing', bob, { enabled: true });
  const a = await sharedContactView(alice, vendor);
  assert.equal(a.sharing, true);
  assert.deepEqual(a.colleagues.map((c) => c.member.name), ['Bob']);
  assert.deepEqual(a.colleagues[0].memory.map((m) => m.content), ['Bob: they promised a quote']);
  assert.equal(a.colleagues[0].brief?.text, 'Bob\'s brief');
  assert.equal(a.colleagues[0].memory[0].evidence[0].quote!.length, 160);
  assert.deepEqual(a.colleagues[0].recentSignals.map((s) => s.type), ['sent']);
  const b = await sharedContactView(bob, vendor);
  assert.deepEqual(b.colleagues.map((c) => c.member.name), ['Alice']);
  // Carol shares nothing and sees nothing; Dave is outside.
  assert.deepEqual((await sharedContactView(carol, vendor)).colleagues, []);
  assert.deepEqual(await sharingStatus(dave), { inOrganization: false, sharing: false, members: 0, membersSharing: 0 });
  assert.equal((await call('PUT', '/api/organizations/me/sharing', dave, { enabled: true })).status, 400);
  assert.deepEqual(await sharedCounts(alice, [vendor, 'nobody@x.com']), { [vendor]: 1 });

  // Switching off hides both directions immediately.
  await call('PUT', '/api/organizations/me/sharing', alice, { enabled: false });
  assert.deepEqual((await sharedContactView(alice, vendor)).colleagues, []);
  assert.deepEqual((await sharedContactView(bob, vendor)).colleagues, []);
});

test('the contact page, the contact list, and the MCP brief carry what colleagues know', async () => {
  const vendor = 'vendor@supplier.example';
  const mine = await know(alice, vendor, [{ kind: 'fact', content: 'Alice knows this' }]);
  await know(bob, vendor, [{ kind: 'preference', content: 'Bob: prefers calls' }]);
  await User.updateMany({ _id: { $in: [alice, bob] } }, { $set: { shareContactMemory: true } });

  const detail = await call('GET', `/api/contacts/${mine._id}/shared`, alice);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.colleagues.map((c: { member: { name: string } }) => c.member.name), ['Bob']);
  assert.equal((await call('GET', `/api/contacts/${mine._id}/shared`, bob)).status, 404); // not Bob's contact id
  const list = await call('GET', '/api/contacts', alice);
  assert.equal(list.json.find((c: { address: string }) => c.address === vendor).sharedWith, 1);
  const status = await call('GET', '/api/organizations/me/sharing', alice);
  assert.deepEqual(status.json, { inOrganization: true, sharing: true, members: 3, membersSharing: 2 });

  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokenFor(alice)}` } } }));
  const r = await client.callTool({ name: 'contact_brief', arguments: { email: vendor } });
  const data = (r as { structuredContent: { colleagues?: Array<{ member: { name: string }; memory: Array<{ content: string }> }> } }).structuredContent;
  assert.deepEqual(data.colleagues?.map((c) => [c.member.name, c.memory[0].content]), [['Bob', 'Bob: prefers calls']]);
  await client.close();
});
