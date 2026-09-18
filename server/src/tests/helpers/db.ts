import 'dotenv/config';
import path from 'path';
import mongoose from 'mongoose';

// Tests never touch Redis: every AI job enqueue is a no-op.
process.env.AI_QUEUE_DISABLED = 'true';

// Integration tests run against the Docker MongoDB from docker-compose.yml.
// `node --test` runs each file in its own process, in parallel, so each file
// gets its own database (named after the file) — otherwise one file's reset
// wipes another's data mid-test.

function testDbName(): string {
  const file = path.basename(process.argv[1] || 'tests').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '_');
  return `emailservice_test_${file}`;
}

function testUri(): string {
  const base = process.env.MONGODB_URI || 'mongodb://localhost:27018/emailservice';
  return base.replace(/\/[^/?]+(\?|$)/, `/${testDbName()}$1`);
}

export async function connectTestDb(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(testUri(), { serverSelectionTimeoutMS: 5_000 });
}

export async function resetTestDb(): Promise<void> {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export async function disconnectTestDb(): Promise<void> {
  await mongoose.disconnect();
}
