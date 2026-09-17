import crypto from 'crypto';

// Provider API keys are the user's own money. They are encrypted at rest with
// AES-256-GCM under a key derived from AI_KEY_ENCRYPTION_SECRET, and the
// model fields that hold them are `select: false` so no query returns them
// by accident (same stance as the Gmail tokens on User).

function secret(): string {
  const s = process.env.AI_KEY_ENCRYPTION_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('AI_KEY_ENCRYPTION_SECRET (or JWT_SECRET) must be set to store provider keys');
  return s;
}

let cachedKey: { secret: string; key: Buffer } | null = null;
function derivedKey(): Buffer {
  const s = secret();
  if (cachedKey && cachedKey.secret === s) return cachedKey.key;
  const key = crypto.scryptSync(s, 'mailtrack-ai-keys', 32);
  cachedKey = { secret: s, key };
  return key;
}

// Format: v1.<iv b64>.<tag b64>.<ciphertext b64>
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(stored: string): string {
  const [v, ivB64, tagB64, dataB64] = stored.split('.');
  if (v !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('unrecognised encrypted secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function last4(plain: string): string {
  return plain.slice(-4);
}
