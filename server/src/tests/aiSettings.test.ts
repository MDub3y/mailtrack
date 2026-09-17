import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { fakeProvider } from './helpers/fakeProvider';
import app from '../app';
import { AiSettings } from '../models/AiSettings';
import { AgentRun } from '../models/AgentRun';
import { encryptSecret, decryptSecret } from '../ai/crypto';
import { resolveProvider, NoProviderKeyError, __setProviderForTests } from '../ai/providers';

// BYOK end to end: keys go in through the API, are stored encrypted, never
// come back out, and are the ones the resolver uses. Server keys are only a
// fallback when explicitly allowed. The connection test is a real run.

const owner = new mongoose.Types.ObjectId();
let server: http.Server;
let base: string;

function token(id: mongoose.Types.ObjectId): string {
  return jwt.sign({ userId: id.toString() }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, body?: unknown, who = owner): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(who)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
  await resetTestDb();
  process.env.AI_ENABLED = 'true';
  process.env.AI_ALLOW_SERVER_KEYS = 'false';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  process.env.AI_MODEL_PRIMARY = 'anthropic:claude-opus-5';
  __setProviderForTests(null);
});
after(async () => {
  __setProviderForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
  await disconnectTestDb();
});

test('crypto: round-trips, uses a fresh IV each time, and rejects tampering', () => {
  const a = encryptSecret('sk-or-v1-abcdef');
  const b = encryptSecret('sk-or-v1-abcdef');
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), 'sk-or-v1-abcdef');
  assert.equal(decryptSecret(b), 'sk-or-v1-abcdef');
  const [v, iv, tag, data] = a.split('.');
  assert.throws(() => decryptSecret([v, iv, tag, data.slice(0, -2) + 'AA'].join('.')));
  assert.throws(() => decryptSecret('plain-text'), /format/);
});

test('settings: empty by default, with server defaults visible', async () => {
  const { status, json } = await call('GET', '/api/ai/settings');
  assert.equal(status, 200);
  assert.deepEqual(json.providers, {
    anthropic: { configured: false }, openai: { configured: false }, openrouter: { configured: false }, custom: { configured: false },
  });
  assert.deepEqual(json.models, { primary: null, extractor: null });
  assert.equal(json.defaults.primary, 'anthropic:claude-opus-5');
  assert.equal(json.serverKeysAllowed, false);
});

test('settings: a key is stored encrypted, reported by last 4 only, and never returned', async () => {
  const { status, json } = await call('PUT', '/api/ai/settings', {
    keys: { openrouter: 'sk-or-v1-secret-key-9876' },
    models: { primary: 'openrouter:meta-llama/llama-3.3-70b-instruct:free' },
    customBaseUrl: 'http://localhost:11434/v1',
  });
  assert.equal(status, 200);
  assert.equal(json.providers.openrouter.configured, true);
  assert.equal(json.providers.openrouter.last4, '9876');
  assert.equal(json.models.primary, 'openrouter:meta-llama/llama-3.3-70b-instruct:free');
  assert.equal(json.customBaseUrl, 'http://localhost:11434/v1');
  assert.equal(JSON.stringify(json).includes('secret-key'), false);

  // On disk: encrypted, not selected by default, decrypts to the original.
  const plainDoc = await AiSettings.findOne({ ownerId: owner }).lean();
  assert.equal((plainDoc as { keys?: unknown }).keys, undefined);
  const withKeys = await AiSettings.findOne({ ownerId: owner }).select('+keys').lean();
  assert.ok(withKeys!.keys!.openrouter!.startsWith('v1.'));
  assert.equal(withKeys!.keys!.openrouter!.includes('secret-key'), false);
  assert.equal(decryptSecret(withKeys!.keys!.openrouter!), 'sk-or-v1-secret-key-9876');

  // GET never includes keys either.
  const again = await call('GET', '/api/ai/settings');
  assert.equal(JSON.stringify(again.json).includes('secret'), false);
});

test('settings: null removes a key; other keys and fields are left alone; bad refs are rejected', async () => {
  await call('PUT', '/api/ai/settings', { keys: { openrouter: 'aaaa1111', openai: 'bbbb2222' } });
  const removed = await call('PUT', '/api/ai/settings', { keys: { openrouter: null } });
  assert.equal(removed.json.providers.openrouter.configured, false);
  assert.equal(removed.json.providers.openai.configured, true);
  const doc = await AiSettings.findOne({ ownerId: owner }).select('+keys').lean();
  assert.equal(doc!.keys!.openrouter, undefined);
  assert.ok(doc!.keys!.openai);

  assert.equal((await call('PUT', '/api/ai/settings', { models: { primary: 'nope' } })).status, 400);
  assert.equal((await call('PUT', '/api/ai/settings', { models: { primary: 'gemini:pro' } })).status, 400);
  assert.equal((await call('PUT', '/api/ai/settings', { customBaseUrl: 'not a url' })).status, 400);
  assert.equal((await call('PUT', '/api/ai/settings', { keys: { anthropic: '' } })).status, 400);
});

test('resolver: uses the owner\'s key for the provider of the chosen model, and their model override', async () => {
  await AiSettings.create({
    ownerId: owner,
    keys: { openrouter: encryptSecret('sk-or-owner') },
    keyMeta: { openrouter: { last4: 'wner', addedAt: new Date() } },
    models: { primary: 'openrouter:qwen/qwen-2.5-72b-instruct' },
  });
  const r = await resolveProvider(owner, 'primary');
  assert.equal(r.provider, 'openrouter');
  assert.equal(r.model, 'qwen/qwen-2.5-72b-instruct');
  assert.equal(r.keySource, 'owner');
  assert.equal(r.client.name, 'openrouter');
});

test('resolver: no key and server keys disallowed → clear error; allowed → server key; custom may have no key', async () => {
  await assert.rejects(resolveProvider(owner, 'primary'), (e: unknown) => e instanceof NoProviderKeyError && e.provider === 'anthropic');

  process.env.AI_ALLOW_SERVER_KEYS = 'true';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-server';
  const r = await resolveProvider(owner, 'primary');
  assert.equal(r.keySource, 'server');

  await assert.rejects(resolveProvider(owner, 'custom:llama3.2'), /base URL/);
  await AiSettings.create({ ownerId: owner, customBaseUrl: 'http://localhost:11434/v1' });
  const c = await resolveProvider(owner, 'custom:llama3.2');
  assert.equal(c.keySource, 'none');
  assert.equal(c.provider, 'custom');
});

test('connection test: runs a real smoke run with the chosen model and reports the outcome', async () => {
  const fake = fakeProvider([{ json: { ok: true, model: 'llama-3.3' }, costUsd: 0 }], { name: 'openrouter', countTokens: null });
  __setProviderForTests(fake);
  const ok = await call('POST', '/api/ai/settings/test', { model: 'openrouter:meta-llama/llama-3.3-70b-instruct:free' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.provider, 'openrouter');
  assert.equal(fake.requests[0].model, 'meta-llama/llama-3.3-70b-instruct:free');
  const run = await AgentRun.findById(ok.json.runId).lean();
  assert.equal(run!.kind, 'smoke');
  assert.equal(run!.status, 'succeeded');

  // A model that answers nonsense fails the schema → 502 with the run id.
  __setProviderForTests(fakeProvider([{ text: 'hello!' }]));
  const bad = await call('POST', '/api/ai/settings/test', {});
  assert.equal(bad.status, 502);
  assert.equal(bad.json.ok, false);
  assert.ok(bad.json.runId);

  // No key at all → 400 with a message that says what to do.
  __setProviderForTests(null);
  const nokey = await call('POST', '/api/ai/settings/test', { model: 'openai:gpt-5-mini' });
  assert.equal(nokey.status, 400);
  assert.match(nokey.json.message, /No API key configured for provider "openai"/);
});
