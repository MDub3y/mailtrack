import 'dotenv/config';
import http from 'http';
import app from './app';
import { connectDB } from './config/db';
import { startEmailWorker } from './queues/emailQueue';

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

connectDB()
  .then(() => {
    startEmailWorker();
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });
