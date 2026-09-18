import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { isAiEnabled } from '../ai/config';

// Background jobs for the AI layer, in their own queue so nothing here
// shares a worker with sending. Handlers are imported lazily so that
// enqueueing from the send path never loads ai/ modules.

export type AiJob =
  | { name: 'extract-memory'; data: { emailId: string; direction?: 'outbound' | 'inbound' } }
  | { name: 'extract-memory-batch'; data: { emailIds: string[] } }
  | { name: 'contact-brief'; data: { contactId: string } }
  | { name: 'recompute-engagement'; data: { contactId: string } };

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
