import crypto from 'crypto';
import mongoose from 'mongoose';
import { WebhookConfig, IWebhookConfig, IOutboundEndpoint, OutboundEvent, MAX_FAILURES } from '../models/Webhook';
import { WebhookDelivery } from '../models/WebhookDelivery';
import { ISignal } from '../models/Signal';
import { Contact } from '../models/Contact';
import { ensureContact, recordSignal, onSignal } from './signalService';
import { buildQueue, QueueItem } from './queueService';
import { queueKey } from './digestService';
import { enqueueWebhookDelivery } from '../queues/aiQueue';

// Signals in from outside, decisions out to outside (doc/05, Elevation 1).
// Inbound payloads are untrusted data: stored as given, never shown to a
// model without delimiting. Outbound deliveries carry the verdict, so other
// systems get the honest version of a signal, not a raw pixel hit.

export const OUTBOUND_TIMEOUT_MS = 8_000;

function secret(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export async function ensureWebhookConfig(ownerId: string | mongoose.Types.ObjectId): Promise<IWebhookConfig> {
  const existing = await WebhookConfig.findOne({ ownerId });
  if (existing) return existing;
  try {
    return await WebhookConfig.create({ ownerId, inboundSecret: secret() });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return (await WebhookConfig.findOne({ ownerId }))!;
    throw err;
  }
}

export async function rotateInboundSecret(ownerId: string | mongoose.Types.ObjectId): Promise<string> {
  const cfg = await ensureWebhookConfig(ownerId);
  cfg.inboundSecret = secret();
  cfg.updatedAt = new Date();
  await cfg.save();
  return cfg.inboundSecret;
}

export async function addOutbound(ownerId: string | mongoose.Types.ObjectId, input: { url: string; events?: OutboundEvent[] }): Promise<{ endpoint: IOutboundEndpoint; secret: string }> {
  const u = new URL(input.url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('url must be http(s)');
  const cfg = await ensureWebhookConfig(ownerId);
  if (cfg.outbound.length >= 10) throw new Error('at most 10 outbound endpoints');
  const s = secret(32);
  cfg.outbound.push({ url: input.url, secret: s, events: input.events?.length ? input.events : ['signal', 'queue'], enabled: true, createdAt: new Date(), failures: 0 } as IOutboundEndpoint);
  cfg.updatedAt = new Date();
  await cfg.save();
  return { endpoint: cfg.outbound[cfg.outbound.length - 1], secret: s };
}

export async function removeOutbound(ownerId: string | mongoose.Types.ObjectId, endpointId: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(endpointId) || !(await WebhookConfig.exists({ ownerId, 'outbound._id': endpointId }))) return false;
  await WebhookConfig.updateOne({ ownerId }, { $pull: { outbound: { _id: endpointId } }, $set: { updatedAt: new Date() } });
  return true;
}

export async function setOutboundEnabled(ownerId: string | mongoose.Types.ObjectId, endpointId: string, enabled: boolean): Promise<boolean> {
  const r = await WebhookConfig.updateOne({ ownerId, 'outbound._id': endpointId }, { $set: { 'outbound.$.enabled': enabled, 'outbound.$.failures': 0, updatedAt: new Date() } });
  return r.matchedCount > 0;
}

// ---------------------------------------------------------------- inbound

export interface ExternalSignalInput {
  contactEmail: string;
  contactName?: string;
  id?: string;              // caller's idempotency key
  at?: string;
  payload?: Record<string, unknown>;
}

export async function ingestExternalSignal(inboundSecret: string, input: ExternalSignalInput): Promise<{ ownerId: string; signalId: string; isNew: boolean } | null> {
  const cfg = await WebhookConfig.findOne({ inboundSecret }).select('ownerId').lean();
  if (!cfg) return null;
  const contact = await ensureContact(cfg.ownerId, input.contactEmail, { displayName: input.contactName });
  const payload = { ...(input.payload ?? {}) };
  const body = JSON.stringify({ contactEmail: input.contactEmail.toLowerCase(), at: input.at ?? null, payload });
  const key = input.id ? `external:${cfg.ownerId}:${input.id}` : `external:${cfg.ownerId}:${crypto.createHash('sha1').update(body).digest('hex')}`;
  const { signal, isNew } = await recordSignal({
    ownerId: cfg.ownerId, contactId: contact._id, type: 'external', at: input.at ? new Date(input.at) : new Date(),
    payload, verdict: 'unknown', source: 'webhook', dedupeKey: key,
  });
  return { ownerId: cfg.ownerId.toString(), signalId: signal._id.toString(), isNew };
}

// ---------------------------------------------------------------- outbound

export interface OutboundEnvelope {
  id: string;
  event: 'signal.recorded' | 'queue.item_appeared' | 'queue.item_resolved' | 'ping';
  at: string;
  ownerId: string;
  data: Record<string, unknown>;
}

export function sign(secretKey: string, timestamp: string, body: string): string {
  return crypto.createHmac('sha256', secretKey).update(`${timestamp}.${body}`).digest('hex');
}

// Verifies a signature header of the form `t=<unix seconds>,v1=<hex>`.
export function verifySignature(secretKey: string, header: string, body: string, toleranceSeconds = 300, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(now / 1000 - Number(parts.t)) > toleranceSeconds) return false;
  const expected = sign(secretKey, parts.t, body);
  return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

export async function deliverToEndpoint(ownerId: string | mongoose.Types.ObjectId, endpointId: string, envelope: OutboundEnvelope): Promise<{ ok: boolean; status?: number; error?: string }> {
  const cfg = await WebhookConfig.findOne({ ownerId, 'outbound._id': endpointId }).select('+outbound.secret');
  const ep = cfg?.outbound.find((e) => e._id.toString() === endpointId);
  if (!cfg || !ep) return { ok: false, error: 'endpoint not found' };
  if (!ep.enabled) return { ok: false, error: 'endpoint disabled' };
  const body = JSON.stringify(envelope);
  const ts = String(Math.floor(Date.now() / 1000));
  let status: number | undefined;
  let error: string | undefined;
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Proofbox-Webhook/1', 'X-Proofbox-Event': envelope.event, 'X-Proofbox-Delivery': envelope.id, 'X-Proofbox-Signature': `t=${ts},v1=${sign(ep.secret, ts, body)}` },
      body,
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ok = !error;
  const failures = ok ? 0 : ep.failures + 1;
  // The delivery log: one row per envelope and endpoint, updated on retry.
  await WebhookDelivery.updateOne(
    { endpointId: ep._id, envelopeId: envelope.id },
    { $set: { ownerId: cfg.ownerId, event: envelope.event, envelope, status: ok ? 'ok' : 'failed', lastStatus: status, lastError: error, lastAttemptAt: new Date() }, $inc: { attempts: 1 }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  ).catch(() => {});
  await WebhookConfig.updateOne({ ownerId, 'outbound._id': endpointId }, {
    $set: {
      'outbound.$.lastDeliveryAt': new Date(), 'outbound.$.lastStatus': status, 'outbound.$.lastError': error, 'outbound.$.failures': failures,
      ...(failures >= MAX_FAILURES ? { 'outbound.$.enabled': false } : {}),
    },
  });
  return { ok, status, error };
}

function envelope(ownerId: string | mongoose.Types.ObjectId, event: OutboundEnvelope['event'], data: Record<string, unknown>): OutboundEnvelope {
  return { id: crypto.randomUUID(), event, at: new Date().toISOString(), ownerId: ownerId.toString(), data };
}

// Fan out one event to every enabled endpoint subscribed to it. Queued when
// the worker is on; inline otherwise (tests, AI_QUEUE_DISABLED).
export async function emit(ownerId: string | mongoose.Types.ObjectId, kind: OutboundEvent, event: OutboundEnvelope['event'], data: Record<string, unknown>): Promise<number> {
  const cfg = await WebhookConfig.findOne({ ownerId }).select('outbound').lean();
  const targets = (cfg?.outbound ?? []).filter((e) => e.enabled && e.events.includes(kind));
  if (!targets.length) return 0;
  const env = envelope(ownerId, event, data);
  for (const ep of targets) {
    const queued = await enqueueWebhookDelivery(ownerId.toString(), ep._id.toString(), env);
    if (!queued) await deliverToEndpoint(ownerId, ep._id.toString(), env);
  }
  return targets.length;
}

export function signalEnvelopeData(signal: ISignal, contact: { address: string; displayName?: string } | null): Record<string, unknown> {
  return {
    signalId: signal._id.toString(),
    type: signal.type,
    at: signal.at.toISOString(),
    contact: { address: contact?.address ?? null, displayName: contact?.displayName ?? null },
    emailId: signal.emailId?.toString() ?? null,
    documentId: signal.documentId?.toString() ?? null,
    integrity: { verdict: signal.integrity.verdict, label: signal.integrity.label ?? null },
    source: signal.source,
    // The payload is what was observed (user agent, page, seconds); external
    // payloads are passed through as the outside party sent them.
    payload: signal.payload ?? {},
  };
}

export function queueEnvelopeData(item: QueueItem): Record<string, unknown> {
  return { key: queueKey(item), rule: item.rule, reason: item.reason, contact: { _id: item.contact._id, address: item.contact.address, displayName: item.contact.displayName ?? null }, emailId: item.email?._id ?? null, memoryId: item.memoryId ?? null, at: item.at };
}

// Compares the current queue with the last snapshot and emits what
// appeared and what resolved. Run on a schedule for owners with endpoints.
export async function watchQueue(ownerId: string | mongoose.Types.ObjectId, now = new Date()): Promise<{ appeared: number; resolved: number }> {
  const cfg = await WebhookConfig.findOne({ ownerId }).select('outbound queueKeys');
  if (!cfg) return { appeared: 0, resolved: 0 };
  const queue = await buildQueue(ownerId, { now });
  const current = new Map(queue.map((i) => [queueKey(i), i]));
  const previous = new Set(cfg.queueKeys);
  const appeared = queue.filter((i) => !previous.has(queueKey(i)));
  const resolved = [...previous].filter((k) => !current.has(k));
  const subscribed = cfg.outbound.some((e) => e.enabled && e.events.includes('queue'));
  if (subscribed) {
    for (const i of appeared) await emit(ownerId, 'queue', 'queue.item_appeared', queueEnvelopeData(i));
    for (const k of resolved) await emit(ownerId, 'queue', 'queue.item_resolved', { key: k, rule: k.split(':')[0] });
  }
  cfg.queueKeys = [...current.keys()];
  await cfg.save();
  await pruneDeliveries().catch(() => {});
  return { appeared: appeared.length, resolved: resolved.length };
}

// Installed at boot: every stored signal is offered to the owner's endpoints
// after its integrity verdict is set. Never blocks or fails the write.
let installed = false;
export function installWebhookHooks(): void {
  if (installed) return;
  installed = true;
  onSignal(async (signal, isNew) => {
    if (!isNew) return;
    const cfg = await WebhookConfig.exists({ ownerId: signal.ownerId, 'outbound.enabled': true });
    if (!cfg) return;
    const contact = await Contact.findById(signal.contactId).select('address displayName').lean();
    await emit(signal.ownerId, 'signal', 'signal.recorded', signalEnvelopeData(signal, contact));
  });
}

// Redelivers what failed for one endpoint in the last N days, oldest first.
export const WEBHOOK_DELIVERY_RETENTION_DAYS = () => Number(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS || 30);

export async function redeliverFailed(ownerId: string | mongoose.Types.ObjectId, endpointId: string, opts: { days?: number; limit?: number } = {}): Promise<{ attempted: number; ok: number }> {
  const since = new Date(Date.now() - (opts.days ?? 7) * 86_400_000);
  const rows = await WebhookDelivery.find({ ownerId, endpointId, status: 'failed', createdAt: { $gte: since } }).sort({ createdAt: 1 }).limit(opts.limit ?? 100).lean();
  let ok = 0;
  for (const r of rows) {
    const res = await deliverToEndpoint(ownerId, endpointId, r.envelope as OutboundEnvelope);
    if (res.ok) ok += 1;
  }
  return { attempted: rows.length, ok };
}

export async function recentDeliveries(ownerId: string | mongoose.Types.ObjectId, endpointId: string, limit = 20) {
  return WebhookDelivery.find({ ownerId, endpointId }).sort({ createdAt: -1 }).limit(limit).select('envelopeId event status attempts lastStatus lastError createdAt lastAttemptAt').lean();
}

export async function pruneDeliveries(): Promise<number> {
  const r = await WebhookDelivery.deleteMany({ createdAt: { $lt: new Date(Date.now() - WEBHOOK_DELIVERY_RETENTION_DAYS() * 86_400_000) } });
  return r.deletedCount ?? 0;
}
