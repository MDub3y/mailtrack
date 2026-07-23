import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { Email } from '../models/Email';
import { User } from '../models/User';
import { injectTrackingPixel } from '../services/emailService';
import { dispatchEmail } from '../services/dispatchService';

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

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const emailQueue = new Queue<EmailJobData>('bulk-email', { connection });

function pixelUrlFor(trackingToken: string): string {
  const baseUrl = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
  return `${baseUrl}/api/track/${trackingToken}/pixel.png`;
}

async function processSingleSend(job: Job<SingleEmailJob>): Promise<void> {
  const email = await Email.findById(job.data.emailId);
  if (!email) return;

  const html = injectTrackingPixel(email.htmlBody, pixelUrlFor(email.trackingToken));
  const { providerMessageId } = await dispatchEmail(email.senderId.toString(), {
    to: email.to,
    subject: email.subject,
    html,
    text: email.textBody,
  });

  email.status = 'delivered';
  email.providerMessageId = providerMessageId;
  email.events.push({ type: 'delivered', timestamp: new Date() });
  await email.save();
}

async function processBulkSend(job: Job<BulkEmailJob>): Promise<BulkEmailResult> {
  const { senderId, senderEmailAddress, recipients, subject, htmlBody, textBody } = job.data;
  const now = new Date();
  const result: BulkEmailResult = { sent: 0, failed: 0, errors: [] };
  const selfAddress = senderEmailAddress.toLowerCase().trim();

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
      const html = injectTrackingPixel(htmlBody, pixelUrlFor(trackingToken));

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

      try {
        const { providerMessageId } = await dispatchEmail(senderId, {
          to: addr, subject, html, text: textBody,
        });
        email.status = 'delivered';
        email.providerMessageId = providerMessageId;
        email.events.push({ type: 'delivered', timestamp: new Date() });
        await email.save();
        result.sent++;
      } catch (sendErr) {
        email.status = 'failed';
        email.failureReason = String(sendErr);
        email.events.push({ type: 'failed', timestamp: new Date() });
        await email.save();
        result.failed++;
        result.errors.push(`${addr}: ${String(sendErr)}`);
      }
    } catch (err) {
      result.failed++;
      result.errors.push(`${addr}: ${String(err)}`);
    }
    await job.updateProgress(Math.round(((i + 1) / recipients.length) * 100));
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
    { connection }
  );

  worker.on('failed', async (job, err) => {
    console.error(`[EmailQueue] Job ${job?.id} (${job?.name}) failed:`, err.message);

    // Only mark the Email permanently failed once retries are exhausted.
    if (job?.name === 'send-single') {
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= attempts) {
        const { emailId } = job.data as SingleEmailJob;
        await Email.findByIdAndUpdate(emailId, {
          status: 'failed',
          failureReason: err.message,
          $push: { events: { type: 'failed', timestamp: new Date() } },
        }).catch(() => {});
      }
    }
  });

  console.log('[EmailQueue] Worker started');
  return worker;
};
