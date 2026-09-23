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
import { Email } from '../models/Email';
import { Contact } from '../models/Contact';
import { Memory } from '../models/Memory';
import { ensureContact, recordSignal } from '../services/signalService';

// The MCP door, driven by the SDK's own client over HTTP: four read-only
// tools, owner-scoped, with provenance on every item and no email bodies.

const owner = new mongoose.Types.ObjectId();
const stranger = new mongoose.Types.ObjectId();
let server: http.Server;
let base: string;

function tokenFor(id: mongoose.Types.ObjectId, scope?: string): string {
  return jwt.sign({ userId: id.toString(), ...(scope ? { scope } : {}) }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

function structured(r: unknown): Record<string, unknown> {
  return (r as { structuredContent?: unknown }).structuredContent as Record<string, unknown>;
}
function isError(r: unknown): boolean {
  return (r as { isError?: boolean }).isError === true;
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
  await User.create({ _id: owner, name: 'Me', email: 'me@example.com', emailAddress: 'me@example.com', password: 'x' });
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); await disconnectTestDb(); });

test('lists four read-only tools and refuses without a token', async () => {
  const client = await connect(tokenFor(owner, 'mcp'));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['contact_brief', 'contact_timeline', 'queue', 'search_commitments']);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  await client.close();

  const res = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(res.status, 401);
  assert.equal((await fetch(`${base}/api/mcp`)).status, 405);
});

test('the tools answer from the owner\'s memory with provenance, and see nothing of another owner', async () => {
  const contact = await ensureContact(owner, 'priya@example.com', { displayName: 'Priya' });
  const email = await Email.create({ senderId: owner, contactId: contact._id, from: 'me@gmail.com', to: 'priya@example.com', subject: 'Proposal', htmlBody: '<p>secret body</p>', textBody: 'secret body', trackingToken: 'tok-1', createdAt: new Date(Date.now() - 6 * 86_400_000) });
  await Contact.updateOne({ _id: contact._id }, { $set: { brief: { text: 'Priya is evaluating the proposal and asked for a security overview.', citedMemoryIds: [], basedOnSignalCount: 3, generatedAt: new Date(), runId: new mongoose.Types.ObjectId() } } });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'sent', at: new Date(Date.now() - 6 * 86_400_000), verdict: 'human', source: 'system', dedupeKey: 's1' });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'open', at: new Date(Date.now() - 5 * 86_400_000), verdict: 'automated', source: 'pixel', dedupeKey: 'o-auto' });
  await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'open', at: new Date(Date.now() - 4 * 86_400_000), verdict: 'human', source: 'pixel', dedupeKey: 'o-human' });
  await recordSignal({ ownerId: owner, contactId: contact._id, type: 'external', at: new Date(Date.now() - 3 * 86_400_000), verdict: 'unknown', source: 'webhook', dedupeKey: 'x1', payload: { kind: 'demo_booked' } });
  await Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'commitment', content: 'Priya will send headcount by Friday', structured: { by: 'contact' }, expiresAt: new Date(Date.now() + 86_400_000), confidence: 0.8, source: 'agent', status: 'active', evidence: [{ emailId: email._id, quote: 'I will send headcount by Friday. ' + 'x'.repeat(300) }] });
  await Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'commitment', content: 'Send Priya the security overview', structured: { by: 'sender', dueAt: '2026-09-20' }, expiresAt: new Date('2026-09-20'), confidence: 0.9, source: 'agent', status: 'active', evidence: [] });
  await Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'preference', content: 'Prefers short emails', confidence: 0.7, source: 'user', status: 'active', evidence: [] });
  await Memory.create({ ownerId: owner, scope: 'contact', subjectId: contact._id, kind: 'fact', content: 'Proposed but not accepted', confidence: 0.5, source: 'agent', status: 'proposed', evidence: [] });

  const client = await connect(tokenFor(owner));

  const brief = structured(await client.callTool({ name: 'contact_brief', arguments: { email: 'Priya@Example.com' } }));
  assert.equal((brief.contact as { address: string }).address, 'priya@example.com');
  assert.match((brief.brief as { text: string }).text, /security overview/);
  const mem = brief.memory as Record<string, Array<{ content: string; evidence: Array<{ emailId: string; quote: string }> }>>;
  assert.deepEqual(mem.commitment.map((m) => m.content), ['Send Priya the security overview', 'Priya will send headcount by Friday']);
  assert.deepEqual(mem.preference.map((m) => m.content), ['Prefers short emails']);
  assert.equal(mem.fact.length, 0); // proposed items are not memory yet
  assert.equal(mem.commitment[1].evidence[0].emailId, email._id.toString());
  assert.ok(mem.commitment[1].evidence[0].quote.length <= 160);
  assert.doesNotMatch(JSON.stringify(brief), /secret body/);

  const tl = structured(await client.callTool({ name: 'contact_timeline', arguments: { email: 'priya@example.com' } }));
  const sig = tl.signals as Array<{ type: string; verdict: string }>;
  assert.deepEqual(sig.map((s) => [s.type, s.verdict]), [['external', 'unknown'], ['open', 'human'], ['sent', 'human']]);
  const humanOnly = structured(await client.callTool({ name: 'contact_timeline', arguments: { email: 'priya@example.com', include_unknown: false, limit: 1 } }));
  assert.deepEqual((humanOnly.signals as Array<{ type: string }>).map((s) => s.type), ['open']);

  const q = structured(await client.callTool({ name: 'queue', arguments: {} }));
  const rules = (q.items as Array<{ rule: string }>).map((i) => i.rule);
  assert.ok(rules.includes('your_commitment_due'));
  assert.ok(rules.includes('their_commitment_due'));

  const mine = structured(await client.callTool({ name: 'search_commitments', arguments: { direction: 'sender' } }));
  assert.deepEqual((mine.commitments as Array<{ content: string; by: string; contact: { address: string } }>).map((c) => [c.content, c.by, c.contact.address]), [['Send Priya the security overview', 'sender', 'priya@example.com']]);
  const soon = structured(await client.callTool({ name: 'search_commitments', arguments: { due_before: '2026-09-22' } }));
  assert.equal((soon.commitments as unknown[]).length, 1);

  const missing = await client.callTool({ name: 'contact_brief', arguments: { email: 'nobody@example.com' } });
  assert.equal(isError(missing), true);
  await client.close();

  // A different owner sees an empty world.
  const other = await connect(tokenFor(stranger));
  assert.equal(isError(await other.callTool({ name: 'contact_brief', arguments: { email: 'priya@example.com' } })), true);
  assert.equal((structured(await other.callTool({ name: 'queue', arguments: {} })).items as unknown[]).length, 0);
  assert.equal((structured(await other.callTool({ name: 'search_commitments', arguments: {} })).commitments as unknown[]).length, 0);
  await other.close();
});
