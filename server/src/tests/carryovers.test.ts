import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import app from '../app';
import { User } from '../models/User';
import { FingerprintRule } from '../models/FingerprintRule';
import { WebhookDelivery } from '../models/WebhookDelivery';
import { ApiToken } from '../models/ApiToken';
import { DEFAULT_CATEGORIES } from '../ai/classify/categories';
import { classifyLocally, localBackend } from '../ai/classify/local';
import { pickBackend } from '../ai/classify/chooser';
import { compileRule, measureRule, measureActiveRules, invalidateRuleCache } from '../services/classifierService';
import { IFingerprintRule } from '../models/FingerprintRule';
import { createApiToken, verifyApiToken, revokeApiToken } from '../services/apiTokenService';
import { addOutbound, deliverToEndpoint, redeliverFailed } from '../services/webhookService';

// The smaller carry-overs: a free local classifier that runs when no key
// can, measured precision per fingerprint rule, stored revocable MCP
// tokens, and a delivery log with redelivery of failed webhooks.

const owner = new mongoose.Types.ObjectId();
let server: http.Server;
let base: string;
let sink: http.Server;
let sinkUrl: string;
let sinkStatus = 200;
let received = 0;
const tokenFor = (id: mongoose.Types.ObjectId) => jwt.sign({ userId: id.toString() }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.AI_ALLOW_SERVER_KEYS = 'false';
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  sink = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { received += 1; res.statusCode = sinkStatus; res.end('ok'); }); });
  await new Promise<void>((resolve) => sink.listen(0, resolve));
  sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}/hook`;
});
beforeEach(async () => {
  await resetTestDb(); invalidateRuleCache(); sinkStatus = 200; received = 0;
  delete process.env.AI_CLASSIFY_LOCAL_FIRST;
  await User.create({ _id: owner, name: 'Me', email: 'me@example.com', emailAddress: 'me@example.com', password: 'x' });
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); await new Promise<void>((r) => sink.close(() => r())); await disconnectTestDb(); });

test('local classifier: free, term-frequency cosine over the category texts, last in the chooser unless asked first', async () => {
  const defs = DEFAULT_CATEGORIES.map((d) => ({ key: d.key, name: d.name, description: d.description, examples: d.examples, policy: d.policy }));
  const out = classifyLocally(defs, [
    { id: 'a', subject: 'Your receipt for order #12', text: 'Total $40.00, invoice attached', from: 'noreply@shop.example', matchedTracked: false, headers: { listUnsubscribe: false, references: [], hasCalendarPart: false, fromAddress: 'noreply@shop.example' } },
    { id: 'b', subject: 'Invitation: Pricing review', text: 'Can we move our call to 3pm', from: 'x@y.com', matchedTracked: false, headers: { listUnsubscribe: false, references: [], hasCalendarPart: false, fromAddress: 'x@y.com' } },
    { id: 'c', subject: 'zzz', text: 'qqq www', from: 'x@y.com', matchedTracked: false, headers: { listUnsubscribe: false, references: [], hasCalendarPart: false, fromAddress: 'x@y.com' } },
  ]);
  assert.equal(out[0].categoryKey, 'transactional');
  assert.equal(out[1].categoryKey, 'calendar_or_meeting');
  assert.equal(out[2].categoryKey, 'personal_or_other');
  assert.match(out[2].reason!, /low_similarity/);
  assert.ok(out.every((r) => r.backend === 'local' && r.modelRef === 'local:tf-cosine' && r.scores));
  assert.deepEqual(await localBackend.available(owner.toString()), { ok: true, modelRef: 'local:tf-cosine' });

  // No keys at all: the chooser lands on local instead of nothing.
  const pick = await pickBackend(owner.toString());
  assert.equal(pick.backend?.name, 'local');
  assert.equal(pick.reasons.length, 2);
  process.env.AI_CLASSIFY_LOCAL_FIRST = 'true';
  assert.equal((await pickBackend(owner.toString())).backend?.name, 'local');
  assert.equal((await pickBackend(owner.toString())).reasons.length, 0);
});

test('measured precision and recall per rule over labelled events, stored on the rule', async () => {
  const rule = compileRule({ patternType: 'ua_regex', pattern: 'ScannerBot', verdict: 'automated', signalType: 'open' } as IFingerprintRule)!;
  const events = [
    { userAgent: 'ScannerBot/1', msSinceCreated: 10_000, label: 'automated' as const },
    { userAgent: 'ScannerBot/2', msSinceCreated: 10_000, label: 'automated' as const },
    { userAgent: 'ScannerBot/3', msSinceCreated: 10_000, label: 'human' as const },      // a false positive
    { userAgent: 'Mozilla/5.0 Chrome', msSinceCreated: 10_000, label: 'human' as const },
    { userAgent: 'OtherScanner', msSinceCreated: 10_000, label: 'automated' as const },  // missed
  ];
  const m = measureRule(rule, events);
  assert.deepEqual(m, { precision: 2 / 3, recall: 2 / 3, n: 3 });
  assert.deepEqual(measureRule(rule, []), { precision: 1, recall: 1, n: 0 });

  await FingerprintRule.create({ patternType: 'ua_regex', pattern: 'ScannerBot', verdict: 'automated', status: 'active', origin: 'investigator' });
  assert.equal(await measureActiveRules(events), 1);
  const stored = (await FingerprintRule.findOne({ pattern: 'ScannerBot' }))!;
  assert.ok(Math.abs(stored.measured!.precision - 2 / 3) < 1e-9);
  assert.equal(stored.measured!.n, 3);

  // The overview measures on request and returns it with the rule.
  const res = await fetch(`${base}/api/integrity`, { headers: { Authorization: `Bearer ${tokenFor(owner)}` } });
  const json = await res.json() as { rules: { active: Array<{ pattern: string; measured?: { n: number } }> } };
  assert.ok(json.rules.active.find((r) => r.pattern === 'ScannerBot')!.measured);
});

test('stored MCP tokens: created once, hashed, usable, listed without the secret, revocable one at a time', async () => {
  const { token, record } = await createApiToken(owner, 'Laptop');
  assert.match(token, /^mt_[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(record.hash, token);
  assert.equal(record.prefix, token.slice(0, 10));
  assert.deepEqual(await verifyApiToken(token), { ownerId: owner.toString(), scope: 'mcp' });
  assert.equal(await verifyApiToken('mt_nope'), null);
  assert.equal(await verifyApiToken('not-a-token'), null);

  const mcp = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(mcp.status, 200);

  const auth = { Authorization: `Bearer ${tokenFor(owner)}`, 'Content-Type': 'application/json' };
  const created = await fetch(`${base}/api/integrations/tokens`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Desktop' }) });
  assert.equal(created.status, 201);
  const c = await created.json() as { _id: string; token: string; name: string };
  assert.match(c.token, /^mt_/);
  const list = await (await fetch(`${base}/api/integrations/tokens`, { headers: auth })).json() as Array<{ name: string; token?: string; hash?: string; revokedAt?: string }>;
  assert.deepEqual(list.map((t) => t.name), ['Desktop', 'Laptop']);
  assert.ok(list.every((t) => t.token === undefined && t.hash === undefined));

  assert.equal((await fetch(`${base}/api/integrations/tokens/${c._id}`, { method: 'DELETE', headers: auth })).status, 200);
  assert.equal((await fetch(`${base}/api/integrations/tokens/${c._id}`, { method: 'DELETE', headers: auth })).status, 404);
  assert.equal(await verifyApiToken(c.token), null);
  assert.deepEqual(await verifyApiToken(token), { ownerId: owner.toString(), scope: 'mcp' }); // the other still works
  assert.equal((await fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${c.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).status, 401);
  assert.equal(await revokeApiToken(owner, 'nope'), false);
  assert.equal(await ApiToken.countDocuments({ ownerId: owner, revokedAt: { $exists: true } }), 1);
});

test('delivery log: every attempt recorded; failed deliveries redeliver on request and flip to ok', async () => {
  const { endpoint } = await addOutbound(owner, { url: sinkUrl, events: ['signal'] });
  const epId = endpoint._id.toString();
  const env = (id: string) => ({ id, event: 'ping' as const, at: new Date().toISOString(), ownerId: owner.toString(), data: { n: id } });
  sinkStatus = 503;
  await deliverToEndpoint(owner, epId, env('e1'));
  await deliverToEndpoint(owner, epId, env('e2'));
  sinkStatus = 200;
  await deliverToEndpoint(owner, epId, env('e3'));
  let rows = await WebhookDelivery.find({ endpointId: epId }).sort({ envelopeId: 1 }).lean();
  assert.deepEqual(rows.map((r) => [r.envelopeId, r.status, r.attempts, r.lastStatus]), [['e1', 'failed', 1, 503], ['e2', 'failed', 1, 503], ['e3', 'ok', 1, 200]]);

  const r = await redeliverFailed(owner, epId);
  assert.deepEqual(r, { attempted: 2, ok: 2 });
  rows = await WebhookDelivery.find({ endpointId: epId }).sort({ envelopeId: 1 }).lean();
  assert.deepEqual(rows.map((x) => [x.envelopeId, x.status, x.attempts]), [['e1', 'ok', 2], ['e2', 'ok', 2], ['e3', 'ok', 1]]);
  assert.equal(received, 5);

  const auth = { Authorization: `Bearer ${tokenFor(owner)}`, 'Content-Type': 'application/json' };
  const log = await (await fetch(`${base}/api/integrations/outbound/${epId}/deliveries`, { headers: auth })).json() as Array<{ envelopeId: string; envelope?: unknown }>;
  assert.equal(log.length, 3);
  assert.equal(log[0].envelope, undefined);
  assert.deepEqual(await (await fetch(`${base}/api/integrations/outbound/${epId}/redeliver`, { method: 'POST', headers: auth, body: JSON.stringify({ days: 7 }) })).json(), { attempted: 0, ok: 0 });
});
