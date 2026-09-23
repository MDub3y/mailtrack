import 'dotenv/config';
import http from 'http';
import app from './app';
import { connectDB } from './config/db';
import { startEmailWorker } from './queues/emailQueue';
import { startAiWorker, reconcileInboxSyncSchedules } from './queues/aiQueue';
import { installMemoryHooks } from './ai/memory';

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

connectDB()
  .then(() => {
    startEmailWorker();
    startAiWorker();
    installMemoryHooks();
    reconcileInboxSyncSchedules()
      .then((n) => { if (n) console.log(`[AiQueue] inbox sync scheduled for ${n} user(s)`); })
      .catch((err) => console.error('[AiQueue] inbox sync reconciliation failed:', err));
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });
