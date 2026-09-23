import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import crypto from 'crypto';
import { isAiEnabled } from '../ai/config';

// Background jobs for the AI layer, in their own queue so nothing here
// shares a worker with sending. Handlers are imported lazily so that
// enqueueing from the send path never loads ai/ modules.

export type AiJob =
  | { name: 'extract-memory'; data: { emailId: string; direction?: 'outbound' | 'inbound' } }
  | { name: 'extract-memory-batch'; data: { emailIds: string[] } }
  | { name: 'contact-brief'; data: { contactId: string } }
  | { name: 'recompute-engagement'; data: { contactId: string } }
  | { name: 'voice-profile'; data: { ownerId: string } }
  | { name: 'investigate'; data: { ownerId: string } }
  | { name: 'reclassify'; data: { ownerId?: string } }
  | { name: 'inbox-sync'; data: { ownerId: string; trigger: 'scheduled' | 'user' } }
  | { name: 'classify-messages'; data: { ownerId: string; ids?: string[] } }
  | { name: 'process-message'; data: { inboundMessageId: string; trigger: 'auto' | 'user' | 'retry' } }
  | { name: 'webhook-deliver'; data: { ownerId: string; endpointId: string; envelope: unknown } }
  | { name: 'queue-watch'; data: { ownerId: string } };

type AiJobData = AiJob['data'];

// Connection and queue are created on first use so that importing this
// module (e.g. from a route) never opens a Redis socket by itself. Under
// tests, AI_QUEUE_DISABLED=true turns every enqueue into a no-op.
let connection: IORedis | null = null;
let queueInstance: Queue<AiJobData> | null = null;

function queueDisabled(): boolean {
  return process.env.AI_QUEUE_DISABLED === 'true';
}

function redis(): IORedis {
  if (!connection) connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
  return connection;
}

export function aiQueue(): Queue<AiJobData> {
  if (!queueInstance) queueInstance = new Queue<AiJobData>('ai', { connection: redis() });
  return queueInstance;
}

// A brief is regenerated at most once per debounce window per contact:
// the job id is fixed, so a second enqueue while one is waiting is ignored
// (doc/02-ai-architecture.md §1.7).
const BRIEF_DEBOUNCE_MS = Number(process.env.AI_BRIEF_DEBOUNCE_MS || 60_000);
// Bulk sends are extracted in one batched job with a per-job cap (ADR-14).
export const EXTRACTION_BATCH_CAP = Number(process.env.AI_EXTRACTION_BATCH_CAP || 100);

export async function enqueueExtraction(emailId: string, direction: 'outbound' | 'inbound' = 'outbound'): Promise<void> {
  if (!isAiEnabled() || queueDisabled()) return;
  await aiQueue().add('extract-memory', { emailId, direction }, {
    jobId: `extract:${emailId}`,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 500,
    removeOnFail: 200,
  });
}

export async function enqueueExtractionBatch(emailIds: string[]): Promise<void> {
  if (!isAiEnabled() || queueDisabled() || !emailIds.length) return;
  await aiQueue().add('extract-memory-batch', { emailIds: emailIds.slice(0, EXTRACTION_BATCH_CAP) }, {
    attempts: 1, removeOnComplete: 100, removeOnFail: 100,
  });
}

export async function enqueueBrief(contactId: string, opts: { delayMs?: number } = {}): Promise<void> {
  if (!isAiEnabled() || queueDisabled()) return;
  await aiQueue().add('contact-brief', { contactId }, {
    jobId: `brief:${contactId}`,
    delay: opts.delayMs ?? BRIEF_DEBOUNCE_MS,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: 50,
  }).catch((err: Error) => {
    // A waiting job with this id already exists: that is the debounce working.
    if (!/already exists/i.test(err.message)) throw err;
  });
}

export async function enqueueEngagement(contactId: string): Promise<void> {
  if (queueDisabled()) return;
  await aiQueue().add('recompute-engagement', { contactId }, {
    jobId: `engagement:${contactId}:${Math.floor(Date.now() / 5_000)}`, // coalesce within 5s
    attempts: 1, removeOnComplete: true, removeOnFail: 20,
  }).catch(() => {});
}

// At most one profile regeneration in flight per owner.
export async function enqueueVoiceProfile(ownerId: string): Promise<void> {
  if (!isAiEnabled() || queueDisabled()) return;
  await aiQueue().add('voice-profile', { ownerId }, {
    jobId: `voice:${ownerId}`, attempts: 1, removeOnComplete: true, removeOnFail: 20,
  }).catch((err: Error) => { if (!/already exists/i.test(err.message)) throw err; });
}

// Accepting a fingerprint rule reclassifies history in the background.
export async function enqueueReclassify(ownerId?: string): Promise<void> {
  if (queueDisabled()) return;
  const scope = ownerId ?? 'all';
  await aiQueue().add('reclassify', { ownerId }, { jobId: `reclassify:${scope}:${Math.floor(Date.now() / 10_000)}`, attempts: 1, removeOnComplete: true, removeOnFail: 20 }).catch(() => {});
}

export async function enqueueInvestigate(ownerId: string): Promise<void> {
  if (!isAiEnabled() || queueDisabled()) return;
  await aiQueue().add('investigate', { ownerId }, { jobId: `investigate:${ownerId}`, attempts: 1, removeOnComplete: true, removeOnFail: 20 })
    .catch((err: Error) => { if (!/already exists/i.test(err.message)) throw err; });
}

// Inbox triage (Phase 4). Both return whether a job was queued, so callers
// can run inline when the queue is off (tests, AI_QUEUE_DISABLED).
export async function enqueueClassify(ownerId: string, ids?: string[]): Promise<boolean> {
  if (!isAiEnabled() || queueDisabled()) return false;
  const key = ids?.length ? crypto.createHash('sha1').update([...ids].sort().join(',')).digest('hex').slice(0, 16) : `all:${Math.floor(Date.now() / 30_000)}`;
  await aiQueue().add('classify-messages', { ownerId, ids }, {
    jobId: `classify:${ownerId}:${key}`, attempts: 2, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: 200, removeOnFail: 100,
  }).catch((err: Error) => { if (!/already exists/i.test(err.message)) throw err; });
  return true;
}

export async function enqueueProcessMessage(inboundMessageId: string, trigger: 'auto' | 'user' | 'retry'): Promise<boolean> {
  if (!isAiEnabled() || queueDisabled()) return false;
  await aiQueue().add('process-message', { inboundMessageId, trigger }, {
    jobId: `process:${inboundMessageId}:${Math.floor(Date.now() / 30_000)}`, attempts: 1, removeOnComplete: 500, removeOnFail: 200,
  }).catch((err: Error) => { if (!/already exists/i.test(err.message)) throw err; });
  return true;
}

// Inbox polling: one repeatable job per opted-in user. The scheduler id is
// stable, so upserting is idempotent and reconciliation at boot is safe
// after a Redis loss. Gmail's push (Pub/Sub) is deferred (doc/04, ADR-20).
export const INBOX_SYNC_EVERY_MS = () => Number(process.env.INBOX_SYNC_EVERY_MS || 180_000);

export async function scheduleInboxSync(ownerId: string): Promise<boolean> {
  if (!isAiEnabled() || queueDisabled()) return false;
  await aiQueue().upsertJobScheduler(`inbox-sync:${ownerId}`, { every: INBOX_SYNC_EVERY_MS() }, {
    name: 'inbox-sync', data: { ownerId, trigger: 'scheduled' }, opts: { attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
  });
  return true;
}

export async function unscheduleInboxSync(ownerId: string): Promise<void> {
  if (queueDisabled()) return;
  await aiQueue().removeJobScheduler(`inbox-sync:${ownerId}`).catch(() => {});
}

// "Sync now": coalesced to one job per owner per 30 s.
export async function enqueueInboxSyncNow(ownerId: string): Promise<boolean> {
  if (!isAiEnabled() || queueDisabled()) return false;
  await aiQueue().add('inbox-sync', { ownerId, trigger: 'user' }, {
    jobId: `inbox-sync-now:${ownerId}:${Math.floor(Date.now() / 30_000)}`, attempts: 1, removeOnComplete: 50, removeOnFail: 50,
  }).catch((err: Error) => { if (!/already exists/i.test(err.message)) throw err; });
  return true;
}

// At boot: every user with an enabled read grant gets their schedule back.
export async function reconcileInboxSyncSchedules(): Promise<number> {
  if (!isAiEnabled() || queueDisabled()) return 0;
  const { User } = await import('../models/User');
  const users = await User.find({ 'gmailRead.syncEnabled': true }).select('_id').lean();
  for (const u of users) await scheduleInboxSync(u._id.toString());
  return users.length;
}

// Outbound webhooks (Phase 5). Not gated on AI_ENABLED: signals exist
// without a model. Delivery retries three times with backoff.
export async function enqueueWebhookDelivery(ownerId: string, endpointId: string, envelope: { id: string }): Promise<boolean> {
  if (queueDisabled()) return false;
  await aiQueue().add('webhook-deliver', { ownerId, endpointId, envelope }, {
    jobId: `webhook:${endpointId}:${envelope.id}`, attempts: 3, backoff: { type: 'exponential', delay: 15_000 }, removeOnComplete: 200, removeOnFail: 200,
  }).catch((err: Error) => { if (!/already exists/i.test(err.message)) throw err; });
  return true;
}

export const QUEUE_WATCH_EVERY_MS = () => Number(process.env.QUEUE_WATCH_EVERY_MS || 300_000);

export async function scheduleQueueWatch(ownerId: string): Promise<boolean> {
  if (queueDisabled()) return false;
  await aiQueue().upsertJobScheduler(`queue-watch:${ownerId}`, { every: QUEUE_WATCH_EVERY_MS() }, {
    name: 'queue-watch', data: { ownerId }, opts: { attempts: 1, removeOnComplete: 20, removeOnFail: 20 },
  });
  return true;
}

export async function unscheduleQueueWatch(ownerId: string): Promise<void> {
  if (queueDisabled()) return;
  await aiQueue().removeJobScheduler(`queue-watch:${ownerId}`).catch(() => {});
}

export async function reconcileQueueWatchSchedules(): Promise<number> {
  if (queueDisabled()) return 0;
  const { WebhookConfig } = await import('../models/Webhook');
  const cfgs = await WebhookConfig.find({ outbound: { $elemMatch: { enabled: true, events: 'queue' } } }).select('ownerId').lean();
  for (const c of cfgs) await scheduleQueueWatch(c.ownerId.toString());
  return cfgs.length;
}

export function startAiWorker(): Worker<AiJobData> {
  const worker = new Worker<AiJobData>(
    'ai',
    async (job: Job<AiJobData>) => {
      switch (job.name as AiJob['name']) {
        case 'extract-memory': {
          const { extractMemoryForEmail } = await import('../ai/memory/extract');
          const { emailId, direction } = job.data as Extract<AiJob, { name: 'extract-memory' }>['data'];
          return extractMemoryForEmail(emailId, direction);
        }
        case 'extract-memory-batch': {
          const { extractMemoryForEmail } = await import('../ai/memory/extract');
          const { emailIds } = job.data as Extract<AiJob, { name: 'extract-memory-batch' }>['data'];
          const out: Array<{ emailId: string; ok: boolean; error?: string }> = [];
          for (let i = 0; i < emailIds.length; i++) {
            try { await extractMemoryForEmail(emailIds[i]); out.push({ emailId: emailIds[i], ok: true }); }
            catch (err) { out.push({ emailId: emailIds[i], ok: false, error: err instanceof Error ? err.message : String(err) }); }
            await job.updateProgress(Math.round(((i + 1) / emailIds.length) * 100));
          }
          return out;
        }
        case 'contact-brief': {
          const { generateBrief } = await import('../ai/memory/brief');
          return generateBrief((job.data as { contactId: string }).contactId);
        }
        case 'voice-profile': {
          const { generateVoiceProfile } = await import('../ai/voice/profile');
          return generateVoiceProfile((job.data as { ownerId: string }).ownerId);
        }
        case 'investigate': {
          const { investigate } = await import('../ai/investigate/investigator');
          return investigate((job.data as { ownerId: string }).ownerId);
        }
        case 'reclassify': {
          const { reclassifyOpens } = await import('../services/classifierService');
          return reclassifyOpens({ ownerId: (job.data as { ownerId?: string }).ownerId });
        }
        case 'inbox-sync': {
          const { syncInbox } = await import('../services/inboxService');
          const { ownerId, trigger } = job.data as Extract<AiJob, { name: 'inbox-sync' }>['data'];
          return syncInbox(ownerId, { trigger });
        }
        case 'classify-messages': {
          const { classifyInboundMessages } = await import('../ai/classify');
          const { ownerId, ids } = job.data as Extract<AiJob, { name: 'classify-messages' }>['data'];
          return classifyInboundMessages(ownerId, { ids });
        }
        case 'process-message': {
          const { processInboundMessage } = await import('../ai/classify/process');
          const { inboundMessageId, trigger } = job.data as Extract<AiJob, { name: 'process-message' }>['data'];
          return processInboundMessage(inboundMessageId, trigger);
        }
        case 'webhook-deliver': {
          const { deliverToEndpoint } = await import('../services/webhookService');
          const { ownerId, endpointId, envelope } = job.data as Extract<AiJob, { name: 'webhook-deliver' }>['data'];
          const r = await deliverToEndpoint(ownerId, endpointId, envelope as Parameters<typeof deliverToEndpoint>[2]);
          if (!r.ok && r.status !== 410 && r.error !== 'endpoint disabled' && r.error !== 'endpoint not found') throw new Error(r.error ?? 'delivery failed');
          return r;
        }
        case 'queue-watch': {
          const { watchQueue } = await import('../services/webhookService');
          return watchQueue((job.data as { ownerId: string }).ownerId);
        }
        case 'recompute-engagement': {
          const { recomputeEngagement } = await import('../ai/memory/engagement');
          const { Contact } = await import('../models/Contact');
          const { contactId } = job.data as { contactId: string };
          const contact = await Contact.findById(contactId).select('ownerId');
          if (!contact) return null;
          return recomputeEngagement(contact.ownerId, contactId);
        }
        default:
          throw new Error(`unknown ai job: ${job.name}`);
      }
    },
    { connection: redis(), concurrency: 2 }
  );
  worker.on('failed', (job, err) => console.error(`[AiQueue] ${job?.name} ${job?.id} failed:`, err.message));
  console.log('[AiQueue] Worker started');
  return worker;
}
