import 'dotenv/config';
import mongoose from 'mongoose';

// Integration tests run against the Docker MongoDB from docker-compose.yml,
// in a separate database so they never touch dev data.

function testUri(): string {
  const base = process.env.MONGODB_URI || 'mongodb://localhost:27018/emailservice';
  return base.replace(/\/[^/?]+(\?|$)/, '/emailservice_test$1');
}

export async function connectTestDb(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(testUri());
}

export async function resetTestDb(): Promise<void> {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export async function disconnectTestDb(): Promise<void> {
  await mongoose.disconnect();
}
