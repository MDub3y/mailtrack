import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { Email, IEmail } from '../models/Email';
import { User } from '../models/User';
import { injectTrackingPixel, renderAttachmentLinks, renderAttachmentText, rewriteLinks, TrackedLinkOut } from '../services/emailService';
import { dispatchEmail, DispatchResult } from '../services/dispatchService';
import { ensureContact, recordSignal } from '../services/signalService';

export interface BulkEmailJob {
  senderId: string;
  senderEmailAddress: string;
  recipients: string[];
  subject: string;
  htmlBody: string;
  textBody: string;
}

export interface SingleEmailJob {
  emailId: string;
}

export interface BulkEmailResult {
  sent: number;
  failed: number;
  errors: string[];
}

type EmailJobData = BulkEmailJob | SingleEmailJob;

// Connection and queue are created on first use so that importing this
// module (the send route does) never opens a Redis socket by itself.
let connection: IORedis | null = null;
let queueInstance: Queue<EmailJobData> | null = null;

function redis(): IORedis {
  if (!connection) connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
  return connection;
}

export const emailQueue = {
  add: (...args: Parameters<Queue<EmailJobData>['add']>) => queue().add(...args),
  getJob: (id: string) => queue().getJob(id),
};

function queue(): Queue<EmailJobData> {
  if (!queueInstance) queueInstance = new Queue<EmailJobData>('bulk-email', { connection: redis() });
  return queueInstance;
}

// For tests: release the socket so the process can exit.
export async function closeEmailQueue(): Promise<void> {
  if (queueInstance) { await queueInstance.close(); queueInstance = null; }
  if (connection) { connection.disconnect(); connection = null; }
}

function pixelUrlFor(trackingToken: string): string {
  const baseUrl = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
  return `${baseUrl}/api/track/${trackingToken}/pixel.png`;
}

// The outgoing copy: attachment links (attributed via the tracking token)
// then the pixel. The stored htmlBody is never changed.
function outgoingBodies(email: Pick<IEmail, 'htmlBody' | 'textBody' | 'attachments' | 'trackingToken'>): { html: string; text: string; links: TrackedLinkOut[] } {
  const attachments = (email.attachments || []).map((a) => ({ name: a.name, shareUrl: a.shareUrl }));
  const baseUrl = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
  const rewritten = rewriteLinks(email.htmlBody, email.trackingToken, baseUrl);
  const withLinks = renderAttachmentLinks(rewritten.html, attachments, email.trackingToken);
  return {
    html: injectTrackingPixel(withLinks, pixelUrlFor(email.trackingToken)),
    text: renderAttachmentText(email.textBody, attachments, email.trackingToken),
    links: rewritten.links,
  };
}

// Contact + the `sent` signal. Idempotent on the email id.
async function attachContact(email: IEmail): Promise<void> {
  const contact = await ensureContact(email.senderId, email.to);
  if (!email.contactId) {
    email.contactId = contact._id;
    await email.save();
  }
  await recordSignal({
    ownerId: email.senderId, contactId: contact._id, emailId: email._id,
    type: 'sent', at: email.createdAt, payload: { subject: email.subject },
    verdict: 'human', source: 'system', dedupeKey: `sent:${email._id}`,
  });
}

async function markDelivered(email: IEmail, dispatched: DispatchResult, opts: { extract: boolean }): Promise<void> {
  const now = new Date();
  email.status = 'delivered';
  email.providerMessageId = dispatched.providerMessageId;
  // Anchors for matching a reply back to this email (Phase 4).
  if (dispatched.providerThreadId) email.gmailThreadId = dispatched.providerThreadId;
  if (dispatched.rfcMessageId) email.rfcMessageId = dispatched.rfcMessageId;
  email.events.push({ type: 'delivered', timestamp: now });
  await email.save();
  if (email.contactId) {
    await recordSignal({
      ownerId: email.senderId, contactId: email.contactId, emailId: email._id,
      type: 'delivered', at: now, verdict: 'human', source: 'system', dedupeKey: `delivered:${email._id}`,
    });
  }
  // Memory extraction runs off the send path, in its own queue (ai/ never
  // imports this file; this file only enqueues by name). Bulk sends batch
  // their extraction into one job at the end instead (ADR-14).
  if (opts.extract) {
    const { enqueueExtraction } = await import('./aiQueue');
    await enqueueExtraction(email._id.toString()).catch((err) => console.error('[EmailQueue] enqueue extraction failed:', err));
  }
}

async function markFailed(email: IEmail, reason: string): Promise<void> {
  const now = new Date();
  email.status = 'failed';
  email.failureReason = reason;
  email.events.push({ type: 'failed', timestamp: now });
  await email.save();
  if (email.contactId) {
    await recordSignal({
      ownerId: email.senderId, contactId: email.contactId, emailId: email._id,
      type: 'failed', at: now, payload: { reason }, verdict: 'human', source: 'system', dedupeKey: `failed:${email._id}`,
    }).catch(() => {});
  }
}

async function processSingleSend(job: Job<SingleEmailJob>): Promise<void> {
  const email = await Email.findById(job.data.emailId);
  if (!email) return;

  await attachContact(email);
  const { html, text, links } = outgoingBodies(email);
  if (links.length && !email.trackedLinks?.length) {
    email.trackedLinks = links.map((l) => ({ ...l, clickCount: 0 }));
    await email.save();
  }
  const dispatched = await dispatchEmail(email.senderId.toString(), {
    to: email.to,
    subject: email.subject,
    html,
    text,
    trackingToken: email.trackingToken,
  });
  await markDelivered(email, dispatched, { extract: true });
}

async function processBulkSend(job: Job<BulkEmailJob>): Promise<BulkEmailResult> {
  const { senderId, senderEmailAddress, recipients, subject, htmlBody, textBody } = job.data;
  const now = new Date();
  const result: BulkEmailResult = { sent: 0, failed: 0, errors: [] };
  const selfAddress = senderEmailAddress.toLowerCase().trim();
  const deliveredIds: string[] = [];

  for (let i = 0; i < recipients.length; i++) {
    const addr = recipients[i].toLowerCase().trim();
    try {
      if (!addr) { result.failed++; continue; }
      if (addr === selfAddress) {
        result.failed++;
        result.errors.push(`${addr}: cannot send to self`);
        continue;
      }

      // Best-effort: if the address happens to belong to a platform User,
      // link it so the in-app inbox feature still works for them.
      const recipient = await User.findOne({ emailAddress: addr });
      const trackingToken = uuidv4();

      const email = await Email.create({
        senderId,
        recipientId: recipient?._id,
        from: senderEmailAddress,
        to: addr,
        subject,
        htmlBody,
        textBody,
        trackingToken,
        status: 'sent',
        events: [{ type: 'sent', timestamp: now }],
      });
      await attachContact(email);
      const { html, text } = outgoingBodies(email);

      try {
        const dispatched = await dispatchEmail(senderId, { to: addr, subject, html, text, trackingToken });
        await markDelivered(email, dispatched, { extract: false });
        deliveredIds.push(email._id.toString());
        result.sent++;
      } catch (sendErr) {
        await markFailed(email, String(sendErr));
        result.failed++;
        result.errors.push(`${addr}: ${String(sendErr)}`);
      }
    } catch (err) {
      result.failed++;
      result.errors.push(`${addr}: ${String(err)}`);
    }
    await job.updateProgress(Math.round(((i + 1) / recipients.length) * 100));
  }

  // One batched extraction job for the whole bulk send, capped per job.
  if (deliveredIds.length) {
    const { enqueueExtractionBatch } = await import("./aiQueue");
    await enqueueExtractionBatch(deliveredIds).catch((err) => console.error("[EmailQueue] enqueue batch extraction failed:", err));
  }

  return result;
}

export const startEmailWorker = () => {
  const worker = new Worker<EmailJobData>(
    'bulk-email',
    async (job: Job<EmailJobData>) => {
      if (job.name === 'send-single') {
        return processSingleSend(job as Job<SingleEmailJob>);
      }
      return processBulkSend(job as Job<BulkEmailJob>);
    },
    { connection: redis() }
  );

  worker.on('failed', async (job, err) => {
    console.error(`[EmailQueue] Job ${job?.id} (${job?.name}) failed:`, err.message);

    // Only mark the Email permanently failed once retries are exhausted.
    if (job?.name === 'send-single') {
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= attempts) {
        const { emailId } = job.data as SingleEmailJob;
        const email = await Email.findById(emailId).catch(() => null);
        if (email) await markFailed(email, err.message).catch(() => {});
      }
    }
  });

  console.log('[EmailQueue] Worker started');
  return worker;
};
