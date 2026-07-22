import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { Email } from '../models/Email';
import { User } from '../models/User';

export interface BulkEmailJob {
  senderId: string;
  senderEmailAddress: string;
  recipients: string[];
  subject: string;
  htmlBody: string;
  textBody: string;
}

export interface BulkEmailResult {
  sent: number;
  failed: number;
  errors: string[];
}

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const emailQueue = new Queue<BulkEmailJob, BulkEmailResult>('bulk-email', { connection });

export const startEmailWorker = () => {
  const worker = new Worker<BulkEmailJob, BulkEmailResult>(
    'bulk-email',
    async (job: Job<BulkEmailJob>): Promise<BulkEmailResult> => {
      const { senderId, senderEmailAddress, recipients, subject, htmlBody, textBody } = job.data;
      const now = new Date();
      const result: BulkEmailResult = { sent: 0, failed: 0, errors: [] };

      for (let i = 0; i < recipients.length; i++) {
        const addr = recipients[i].toLowerCase().trim();
        try {
          if (!addr) { result.failed++; continue; }
          const recipient = await User.findOne({ emailAddress: addr });
          if (!recipient) {
            result.failed++;
            result.errors.push(`${addr}: not registered on this platform`);
          } else if (recipient._id.toString() === senderId) {
            result.failed++;
            result.errors.push(`${addr}: cannot send to self`);
          } else {
            await Email.create({
              senderId,
              recipientId: recipient._id,
              from: senderEmailAddress,
              to: recipient.emailAddress,
              subject,
              htmlBody,
              textBody,
              status: 'delivered',
              events: [
                { type: 'sent', timestamp: now },
                { type: 'delivered', timestamp: now },
              ],
            });
            result.sent++;
          }
        } catch (err) {
          result.failed++;
          result.errors.push(`${addr}: ${String(err)}`);
        }
        await job.updateProgress(Math.round(((i + 1) / recipients.length) * 100));
      }

      return result;
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error(`[BulkEmail] Job ${job?.id} failed:`, err.message);
  });

  console.log('[BulkEmail] Worker started');
  return worker;
};
