import crypto from 'crypto';
import mongoose from 'mongoose';
import { ApiToken, IApiToken } from '../models/ApiToken';

// Stored read tokens for MCP clients: shown once, hashed at rest, revocable
// one at a time. Format: mt_<43 url-safe characters>.

export const TOKEN_PREFIX = 'mt_';

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createApiToken(ownerId: string | mongoose.Types.ObjectId, name: string, opts: { expiresInDays?: number } = {}): Promise<{ token: string; record: IApiToken }> {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const record = await ApiToken.create({
    ownerId, name: name.trim().slice(0, 60) || 'MCP client', hash: hash(token), prefix: token.slice(0, 10), scope: 'mcp',
    expiresAt: opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86_400_000) : undefined,
  });
  return { token, record };
}

export async function listApiTokens(ownerId: string | mongoose.Types.ObjectId): Promise<Array<Pick<IApiToken, '_id' | 'name' | 'prefix' | 'scope' | 'createdAt' | 'lastUsedAt' | 'expiresAt' | 'revokedAt'>>> {
  return ApiToken.find({ ownerId }).sort({ createdAt: -1 }).select('name prefix scope createdAt lastUsedAt expiresAt revokedAt').lean();
}

export async function revokeApiToken(ownerId: string | mongoose.Types.ObjectId, id: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(id)) return false;
  const r = await ApiToken.updateOne({ _id: id, ownerId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
  return r.modifiedCount > 0;
}

// Resolves a presented token to its owner, or null when unknown, revoked or expired.
export async function verifyApiToken(token: string): Promise<{ ownerId: string; scope: 'mcp' } | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const rec = await ApiToken.findOne({ hash: hash(token) }).select('ownerId scope revokedAt expiresAt').lean();
  if (!rec || rec.revokedAt || (rec.expiresAt && rec.expiresAt < new Date())) return null;
  ApiToken.updateOne({ _id: rec._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
  return { ownerId: rec.ownerId.toString(), scope: rec.scope };
}
