import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

// The model must never sit on the pixel path or the send path (ADR-1, ADR-2).
// This test fails the build if any of these files imports from src/ai/ or
// from the Anthropic SDK, directly or via a relative path. It is intentionally
// a plain text check so nothing about module resolution can hide an import.

const SRC = path.resolve(__dirname, '..');

const FORBIDDEN_IMPORTERS = [
  'routes/track.ts',
  'services/dispatchService.ts',
  'services/gmailService.ts',
  'services/sendgridService.ts',
  'services/emailService.ts',
];

const FORBIDDEN_PATTERNS = [
  /from\s+['"][^'"]*\/ai\//,       // ../ai/..., ./ai/...
  /from\s+['"][^'"]*\/ai['"]/,     // ../ai
  /require\(['"][^'"]*\/ai\//,
  /@anthropic-ai\//,
  /from\s+['"]openai['"]/,
];

// The ai/ module may read models and config, but must never import the code
// that sends mail. A draft is text in a compose window, nothing more.
const AI_MUST_NOT_IMPORT = [
  /services\/dispatchService/,
  /services\/gmailService/,
  /services\/sendgridService/,
  /queues\/emailQueue/,
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

test('hot paths never import the AI layer', () => {
  for (const rel of FORBIDDEN_IMPORTERS) {
    const file = path.join(SRC, rel);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.ok(!pattern.test(src), `${rel} imports the AI layer (matched ${pattern})`);
    }
  }
});

test('the AI layer never imports the send path', () => {
  const aiDir = path.join(SRC, 'ai');
  for (const file of walk(aiDir)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const pattern of AI_MUST_NOT_IMPORT) {
      assert.ok(!pattern.test(src), `${path.relative(SRC, file)} imports the send path (matched ${pattern})`);
    }
  }
});

test('provider SDKs are constructed only inside their adapters', () => {
  const allowed = new Set([
    path.join('ai', 'providers', 'anthropic.ts'),
    path.join('ai', 'providers', 'openaiCompat.ts'),
  ]);
  const offenders = walk(SRC)
    .filter((f) => !f.includes(`${path.sep}tests${path.sep}`))
    .filter((f) => !allowed.has(path.relative(SRC, f)))
    .filter((f) => /new\s+(Anthropic|OpenAI)\s*\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(SRC, f)), []);
});
