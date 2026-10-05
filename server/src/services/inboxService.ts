import mongoose from 'mongoose';
import * as cheerio from 'cheerio';
import { User, IUser } from '../models/User';
import { Email } from '../models/Email';
import { InboundMessage, IInboundHeaders, INBOX_EXCERPT_CHARS, MatchedBy } from '../models/InboundMessage';
import { encryptSecret, decryptSecret } from '../utils/secrets';
import { tokensInMessageIds, tokensInText } from '../utils/trackingAnchors';
import { exchangeGoogleCode, refreshGoogleToken, revokeGoogleToken } from './gmailService';
import { makeGmailClient, GmailClient, GmailMessage, GmailPart, GmailApiError } from './gmailClient';
import { enqueueClassify } from '../queues/aiQueue';

// Reading the user's inbox (Phase 4). This file never imports from ai/: it
// fetches, parses, matches replies to tracked mail deterministically, and
// stores minimal rows. Classification is a job that runs afterwards.
//
// Scope is deliberately narrow: INBOX-labelled mail only, bounded initial
// window, bounded per run, excerpts not bodies, and a separate consent the
// user can revoke from the same page that shows what was read.

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export const INBOX_INITIAL_DAYS = () => Number(process.env.INBOX_INITIAL_DAYS || 30);
export const INBOX_INITIAL_MAX = () => Number(process.env.INBOX_INITIAL_MAX || 500);

// The initial pull is the owner's choice (ADR: fine-grained control over
// what is read), clamped to bounds that keep one pull affordable in both
// Gmail quota and classification cost. Env values are the defaults.
export const INITIAL_DAYS_BOUNDS = { min: 1, max: 365 } as const;
export const INITIAL_MAX_BOUNDS = { min: 1, max: 1000 } as const;
const clampInt = (v: number, b: { min: number; max: number }) => Math.min(b.max, Math.max(b.min, Math.floor(v)));

export function effectiveInitial(user: Pick<IUser, 'inboxInitial'> | null | undefined): { days: number; max: number } {
  const days = user?.inboxInitial?.days ?? INBOX_INITIAL_DAYS();
  const max = user?.inboxInitial?.max ?? INBOX_INITIAL_MAX();
  return { days: clampInt(days, INITIAL_DAYS_BOUNDS), max: clampInt(max, INITIAL_MAX_BOUNDS) };
}

// Store the owner's pull window. null resets a field to the server default;
// an absent field is left unchanged. Returns what will actually be used.
export async function setInboxInitial(userId: string, input: { days?: number | null; max?: number | null }): Promise<{ days: number; max: number }> {
  const set: Record<string, number> = {};
  const unset: Record<string, 1> = {};
  if (input.days === null) unset['inboxInitial.days'] = 1;
  else if (typeof input.days === 'number' && Number.isFinite(input.days)) set['inboxInitial.days'] = clampInt(input.days, INITIAL_DAYS_BOUNDS);
  if (input.max === null) unset['inboxInitial.max'] = 1;
  else if (typeof input.max === 'number' && Number.isFinite(input.max)) set['inboxInitial.max'] = clampInt(input.max, INITIAL_MAX_BOUNDS);
  const update: Record<string, unknown> = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  const user = Object.keys(update).length
    ? await User.findByIdAndUpdate(userId, update, { new: true }).select('inboxInitial')
    : await User.findById(userId).select('inboxInitial');
  return effectiveInitial(user);
}
export const INBOX_SYNC_MAX_PER_RUN = () => Number(process.env.INBOX_SYNC_MAX_PER_RUN || 200);
export const INBOX_RETENTION_DAYS = () => Number(process.env.INBOX_RETENTION_DAYS || 0);
const SYNC_LOCK_MS = 5 * 60_000;
const FETCH_CONCURRENCY = 4;
const PAGE_SIZE = 100;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function readRedirectUri(): string {
  return process.env.GOOGLE_READ_REDIRECT_URI || requireEnv('GOOGLE_REDIRECT_URI').replace(/\/callback$/, '/read/callback');
}

// ---------------------------------------------------------------- consent

export function buildGoogleReadAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv('GOOGLE_CLIENT_ID'),
    redirect_uri: readRedirectUri(),
    response_type: 'code',
    scope: READ_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export class GmailReadMismatchError extends Error {
  constructor(public granted: string, public expected: string) {
    super(`The Google account that granted read access (${granted}) is not the connected Gmail address (${expected}).`);
  }
}

// Exchanges the code, checks the granting account is the one that sends,
// stores the encrypted tokens, and records the mailbox's current historyId
// so incremental sync can start from the moment of consent.
export async function connectGmailReadGrant(userId: string, code: string): Promise<{ address: string }> {
  const user = await User.findById(userId);
  if (!user) throw new Error('user not found');
  const tokens = await exchangeGoogleCode(code, readRedirectUri());
  if (!tokens.scope.split(' ').includes(READ_SCOPE)) throw new Error('Google did not grant the gmail.readonly scope');
  const profile = await makeGmailClient(tokens.access_token).getProfile();
  const address = profile.emailAddress.toLowerCase();
  if (user.gmailAddress && user.gmailAddress.toLowerCase() !== address) throw new GmailReadMismatchError(address, user.gmailAddress);

  await User.updateOne({ _id: userId }, {
    $set: {
      gmailRead: {
        address,
        refreshToken: encryptSecret(tokens.refresh_token!),
        accessToken: encryptSecret(tokens.access_token),
        tokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
        scope: tokens.scope,
        grantedAt: new Date(),
        syncEnabled: true,
        historyId: profile.historyId,
        initialSyncDone: false,
      },
      ...(user.gmailAddress ? {} : { gmailAddress: address }),
    },
  });
  return { address };
}

// Removes the grant and every row that was never promoted into a thread.
// Promoted rows stay: they are part of a contact's history the user chose
// to keep, and can be deleted from the contact page.
export async function revokeGmailReadGrant(userId: string): Promise<{ revoked: boolean; deletedMessages: number }> {
  const user = await User.findById(userId).select('+gmailRead.refreshToken');
  if (!user?.gmailRead) return { revoked: false, deletedMessages: 0 };
  if (user.gmailRead.refreshToken) await revokeGoogleToken(decryptSecret(user.gmailRead.refreshToken));
  await User.updateOne({ _id: userId }, { $unset: { gmailRead: 1 } });
  const del = await InboundMessage.deleteMany({ ownerId: userId, emailId: { $exists: false } });
  return { revoked: true, deletedMessages: del.deletedCount ?? 0 };
}

export async function setInboxSyncEnabled(userId: string, enabled: boolean): Promise<boolean> {
  const r = await User.updateOne({ _id: userId, gmailRead: { $exists: true } }, { $set: { 'gmailRead.syncEnabled': enabled } });
  return r.matchedCount > 0;
}

export async function getValidReadAccessToken(userId: string | mongoose.Types.ObjectId): Promise<string> {
  const user = await User.findById(userId).select('+gmailRead.refreshToken +gmailRead.accessToken');
  const g = user?.gmailRead;
  if (!user || !g?.refreshToken) throw new Error('Inbox reading is not connected for this account.');
  const fresh = g.accessToken && g.tokenExpiry && g.tokenExpiry.getTime() > Date.now() + 60_000;
  if (fresh) return decryptSecret(g.accessToken!);
  const tokens = await refreshGoogleToken(decryptSecret(g.refreshToken));
  await User.updateOne({ _id: userId }, { $set: { 'gmailRead.accessToken': encryptSecret(tokens.access_token), 'gmailRead.tokenExpiry': new Date(Date.now() + tokens.expires_in * 1000) } });
  return tokens.access_token;
}

// ---------------------------------------------------------------- parsing

export interface ParsedMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  historyId?: string;
  internalDate: Date;
  from: { address: string; name?: string };
  to: string[];
  subject: string;
  snippet: string;
  text: string;         // quoted reply stripped, capped
  labelIds: string[];
  headers: IInboundHeaders;
}

export function parseAddress(raw: string): { address: string; name?: string } {
  const m = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { address: m[2].trim().toLowerCase(), name: m[1]?.trim() || undefined };
  return { address: raw.trim().toLowerCase().replace(/^<|>$/g, '') };
}

export function parseAddressList(raw: string): string[] {
  return raw.split(',').map((s) => parseAddress(s).address).filter(Boolean);
}

function decodeBody(data?: string): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $('style, script, head').remove();
  $('br').replaceWith('\n');
  $('p, div, li, tr, h1, h2, h3, h4, blockquote').each((_, el) => { $(el).append('\n'); });
  return $.root().text().replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function walkParts(part: GmailPart | undefined, visit: (p: GmailPart) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walkParts(child, visit);
}

// Cuts the quoted previous message and a trailing signature so the excerpt
// holds only what this sender wrote. Conservative: unknown formats are kept.
const QUOTE_STARTS = [
  /^On .{0,200}?wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/mi,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/mi,
  /^From:\s.+\n(?:Sent|Date):\s/m,
  /^_{5,}\s*$/m,
  /^Le .{0,200}? a écrit\s*:\s*$/m,
];

export function stripQuotedReply(text: string): string {
  let out = text.replace(/\r\n/g, '\n');
  let cut = out.length;
  for (const re of QUOTE_STARTS) {
    const m = re.exec(out);
    if (m && m.index < cut) cut = m.index;
  }
  // "On ... wrote:" wrapped over two lines by a mail client.
  const wrapped = /^On [^\n]{0,120}\n[^\n]{0,120}wrote:\s*$/m.exec(out);
  if (wrapped && wrapped.index < cut) cut = wrapped.index;
  out = out.slice(0, cut);
  // Trailing quoted lines and a signature delimiter.
  const lines = out.split('\n');
  while (lines.length && /^\s*(>|$)/.test(lines[lines.length - 1])) lines.pop();
  const sig = lines.findIndex((l) => /^--\s?$/.test(l));
  if (sig > 0) lines.splice(sig);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseGmailMessage(msg: GmailMessage): ParsedMessage {
  const headerMap = new Map<string, string>();
  for (const h of msg.payload?.headers ?? []) if (!headerMap.has(h.name.toLowerCase())) headerMap.set(h.name.toLowerCase(), h.value);
  const h = (name: string) => headerMap.get(name.toLowerCase());

  let plain = '';
  let html = '';
  let hasCalendarPart = false;
  let hasAttachments = false;
  walkParts(msg.payload, (p) => {
    const mime = (p.mimeType ?? '').toLowerCase();
    if (p.filename && (p.body?.attachmentId || (p.body?.size ?? 0) > 0)) hasAttachments = true;
    if (mime === 'text/calendar' || mime === 'application/ics' || /\.ics$/i.test(p.filename ?? '')) hasCalendarPart = true;
    if (p.filename) return; // an attachment's text is not the message
    if (mime === 'text/plain' && !plain) plain = decodeBody(p.body?.data);
    else if (mime === 'text/html' && !html) html = decodeBody(p.body?.data);
  });
  const raw = plain || (html ? htmlToText(html) : '');
  const text = stripQuotedReply(raw).slice(0, INBOX_EXCERPT_CHARS);

  const references = (h('References') ?? '').split(/\s+/).filter(Boolean);
  const from = parseAddress(h('From') ?? '');
  return {
    gmailMessageId: msg.id,
    gmailThreadId: msg.threadId,
    historyId: msg.historyId,
    internalDate: new Date(Number(msg.internalDate ?? Date.now())),
    from,
    to: parseAddressList(h('To') ?? ''),
    subject: (h('Subject') ?? '').trim(),
    snippet: (msg.snippet ?? '').slice(0, 400),
    text,
    labelIds: msg.labelIds ?? [],
    headers: {
      messageId: h('Message-ID') ?? h('Message-Id'),
      inReplyTo: h('In-Reply-To'),
      references,
      listUnsubscribe: !!h('List-Unsubscribe'),
      listId: h('List-Id'),
      precedence: h('Precedence'),
      autoSubmitted: h('Auto-Submitted') ?? (h('X-Autoreply') ? 'auto-replied' : undefined),
      hasCalendarPart,
      hasAttachments,
    },
  };
}

// ---------------------------------------------------------------- matching

// Three anchors, cheapest first: Gmail's own thread id, our Message-ID in
// In-Reply-To/References, the pixel URL quoted in the body.
export async function matchTrackedEmail(ownerId: mongoose.Types.ObjectId | string, p: Pick<ParsedMessage, 'gmailThreadId' | 'headers' | 'text'>): Promise<{ emailId: mongoose.Types.ObjectId; contactId?: mongoose.Types.ObjectId; matchedBy: MatchedBy } | null> {
  const byThread = await Email.findOne({ senderId: ownerId, gmailThreadId: p.gmailThreadId, direction: { $ne: 'inbound' } }).select('_id contactId').lean();
  if (byThread) return { emailId: byThread._id, contactId: byThread.contactId, matchedBy: 'thread' };

  const fromIds = tokensInMessageIds([p.headers.inReplyTo ?? '', ...p.headers.references]);
  if (fromIds.length) {
    const e = await Email.findOne({ senderId: ownerId, trackingToken: { $in: fromIds } }).select('_id contactId').lean();
    if (e) return { emailId: e._id, contactId: e.contactId, matchedBy: 'message_id' };
  }
  const fromText = tokensInText(p.text);
  if (fromText.length) {
    const e = await Email.findOne({ senderId: ownerId, trackingToken: { $in: fromText } }).select('_id contactId').lean();
    if (e) return { emailId: e._id, contactId: e.contactId, matchedBy: 'pixel_url' };
  }
  return null;
}

// ---------------------------------------------------------------- ingest

export interface IngestOutcome { id?: string; created: boolean; skipped?: 'own_mail' | 'not_inbox' }

export function isInboxMail(labelIds: string[]): boolean {
  return labelIds.includes('INBOX') && !labelIds.includes('SPAM') && !labelIds.includes('TRASH') && !labelIds.includes('DRAFT');
}

export async function ingestMessage(ownerId: mongoose.Types.ObjectId | string, ownAddress: string, msg: GmailMessage): Promise<IngestOutcome> {
  const p = parseGmailMessage(msg);
  if (!isInboxMail(p.labelIds)) return { created: false, skipped: 'not_inbox' };
  if (p.from.address === ownAddress.toLowerCase()) return { created: false, skipped: 'own_mail' };

  const existing = await InboundMessage.findOne({ ownerId, gmailMessageId: p.gmailMessageId }).select('_id').lean();
  if (existing) return { id: existing._id.toString(), created: false };

  const match = await matchTrackedEmail(ownerId, p);
  try {
    const row = await InboundMessage.create({
      ownerId,
      gmailMessageId: p.gmailMessageId,
      gmailThreadId: p.gmailThreadId,
      historyId: p.historyId,
      internalDate: p.internalDate,
      from: p.from,
      to: p.to,
      subject: p.subject,
      snippet: p.snippet,
      textExcerpt: p.text,
      labelIds: p.labelIds,
      headers: p.headers,
      matchedEmailId: match?.emailId,
      matchedBy: match?.matchedBy,
      contactId: match?.contactId,
    });
    return { id: row._id.toString(), created: true };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const dup = await InboundMessage.findOne({ ownerId, gmailMessageId: p.gmailMessageId }).select('_id').lean();
      return { id: dup?._id.toString(), created: false };
    }
    throw err;
  }
}

// ---------------------------------------------------------------- sync

export interface SyncResult {
  skipped?: 'disabled' | 'locked' | 'not_connected';
  mode?: 'initial' | 'history' | 'relist' | 'backfill';
  fetched: number;
  created: number;
  newIds: string[];
  historyId?: string;
  capped: boolean;
  error?: string;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function acquireLock(userId: string): Promise<IUser | null> {
  const now = new Date();
  return User.findOneAndUpdate(
    { _id: userId, 'gmailRead.syncEnabled': true, $or: [{ 'gmailRead.syncLockUntil': { $exists: false } }, { 'gmailRead.syncLockUntil': { $lt: now } }] },
    { $set: { 'gmailRead.syncLockUntil': new Date(now.getTime() + SYNC_LOCK_MS) } },
    { new: true }
  );
}

async function listRecentInbox(client: GmailClient, days: number, max: number): Promise<{ refs: Array<{ id: string }>; capped: boolean }> {
  const refs: Array<{ id: string }> = [];
  let pageToken: string | undefined;
  do {
    const page = await client.listMessages({ q: `newer_than:${days}d -in:spam -in:trash`, labelIds: ['INBOX'], maxResults: Math.min(PAGE_SIZE, max - refs.length), pageToken });
    refs.push(...page.messages);
    pageToken = page.nextPageToken;
  } while (pageToken && refs.length < max);
  return { refs, capped: !!pageToken };
}

// A manual, bounded pull over a window the owner chooses, after the initial
// sync is done (before it, the ordinary sync applies the same choice). Each
// already-stored message dedupes to nothing, so this is safe to repeat and
// to widen; it never touches the history cursor.
export async function backfillInbox(userId: string, input: { days?: number; max?: number } = {}): Promise<SyncResult> {
  const base: SyncResult = { fetched: 0, created: 0, newIds: [], capped: false };
  const pre = await User.findById(userId).select('gmailRead inboxInitial');
  if (!pre?.gmailRead) return { ...base, skipped: 'not_connected' };
  if (!pre.gmailRead.syncEnabled) return { ...base, skipped: 'disabled' };
  if (!pre.gmailRead.initialSyncDone) return syncInbox(userId, { trigger: 'user' });
  const user = await acquireLock(userId);
  if (!user?.gmailRead) return { ...base, skipped: 'locked' };
  const eff = effectiveInitial(pre);
  const days = clampInt(typeof input.days === 'number' && Number.isFinite(input.days) ? input.days : eff.days, INITIAL_DAYS_BOUNDS);
  const max = clampInt(typeof input.max === 'number' && Number.isFinite(input.max) ? input.max : eff.max, INITIAL_MAX_BOUNDS);
  const result: SyncResult = { ...base, mode: 'backfill' };
  try {
    const client = makeGmailClient(await getValidReadAccessToken(userId));
    const { refs, capped } = await listRecentInbox(client, days, max);
    result.capped = capped;
    Object.assign(result, await fetchAndIngest(client, userId, user.gmailRead.address, refs));
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    await User.updateOne({ _id: userId }, { $set: { 'gmailRead.syncLockUntil': new Date(0) } });
  }
  for (let i = 0; i < result.newIds.length; i += 50) await enqueueClassify(userId, result.newIds.slice(i, i + 50));
  return result;
}

async function fetchAndIngest(client: GmailClient, ownerId: string, ownAddress: string, refs: Array<{ id: string }>): Promise<{ fetched: number; created: number; newIds: string[] }> {
  const outcomes = await mapLimit(refs, FETCH_CONCURRENCY, async (ref) => {
    try {
      const full = await client.getMessage(ref.id, 'full');
      return ingestMessage(ownerId, ownAddress, full);
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) return { created: false } as IngestOutcome; // deleted meanwhile
      throw err;
    }
  });
  const created = outcomes.filter((o) => o.created);
  return { fetched: refs.length, created: created.length, newIds: created.map((o) => o.id!) };
}

// One sync pass for one user. Initial: a bounded list of recent INBOX mail.
// After that: Gmail history from the stored historyId, advanced only past
// records whose messages were all stored. A 404 on history (id too old)
// falls back to a bounded re-list since the last sync.
export async function syncInbox(userId: string, opts: { trigger?: 'scheduled' | 'user' } = {}): Promise<SyncResult> {
  const base: SyncResult = { fetched: 0, created: 0, newIds: [], capped: false };
  const pre = await User.findById(userId).select('gmailRead');
  if (!pre?.gmailRead) return { ...base, skipped: 'not_connected' };
  if (!pre.gmailRead.syncEnabled) return { ...base, skipped: 'disabled' };
  const user = await acquireLock(userId);
  if (!user?.gmailRead) return { ...base, skipped: 'locked' };
  const grant = user.gmailRead;
  const ownAddress = grant.address;
  const result: SyncResult = { ...base };
  const patch: Record<string, unknown> = {};

  try {
    const client = makeGmailClient(await getValidReadAccessToken(userId));

    if (!grant.initialSyncDone) {
      result.mode = 'initial';
      const { days, max } = effectiveInitial(user);
      const { refs, capped } = await listRecentInbox(client, days, max);
      result.capped = capped;
      Object.assign(result, await fetchAndIngest(client, userId, ownAddress, refs));
      if (!grant.historyId) patch['gmailRead.historyId'] = (await client.getProfile()).historyId;
      patch['gmailRead.initialSyncDone'] = true;
    } else {
      result.mode = 'history';
      const cap = INBOX_SYNC_MAX_PER_RUN();
      let startHistoryId = grant.historyId;
      if (!startHistoryId) startHistoryId = (await client.getProfile()).historyId;
      let pageToken: string | undefined;
      let lastDone = startHistoryId;
      const seen = new Set<string>();
      let relist = false;
      try {
        outer: do {
          const page = await client.listHistory({ startHistoryId, labelId: 'INBOX', historyTypes: ['messageAdded'], maxResults: PAGE_SIZE, pageToken });
          for (const rec of page.history) {
            const refs = (rec.messagesAdded ?? []).map((a) => a.message).filter((m) => !seen.has(m.id) && (!m.labelIds || isInboxMail(m.labelIds)));
            if (result.fetched + refs.length > cap) { result.capped = true; break outer; }
            refs.forEach((m) => seen.add(m.id));
            const r = await fetchAndIngest(client, userId, ownAddress, refs);
            result.fetched += r.fetched; result.created += r.created; result.newIds.push(...r.newIds);
            lastDone = rec.id;
          }
          pageToken = page.nextPageToken;
          if (!pageToken && page.historyId && !result.capped) lastDone = page.historyId;
        } while (pageToken);
      } catch (err) {
        if (err instanceof GmailApiError && err.status === 404) relist = true;
        else throw err;
      }
      if (relist) {
        // The stored historyId is too old for Gmail to serve. Re-list a
        // bounded window since the last sync and restart history from now.
        result.mode = 'relist';
        const since = grant.lastSyncAt ?? new Date(Date.now() - INBOX_INITIAL_DAYS() * 86_400_000);
        const page = await client.listMessages({ q: `after:${Math.floor(since.getTime() / 1000)} -in:spam -in:trash`, labelIds: ['INBOX'], maxResults: Math.min(PAGE_SIZE, cap) });
        result.capped = !!page.nextPageToken;
        Object.assign(result, await fetchAndIngest(client, userId, ownAddress, page.messages));
        lastDone = (await client.getProfile()).historyId;
      }
      result.historyId = lastDone;
      patch['gmailRead.historyId'] = lastDone;
    }

    const retention = INBOX_RETENTION_DAYS();
    if (retention > 0) {
      await InboundMessage.deleteMany({ ownerId: userId, emailId: { $exists: false }, internalDate: { $lt: new Date(Date.now() - retention * 86_400_000) } });
    }
    patch['gmailRead.lastSyncAt'] = new Date();
    patch['gmailRead.lastSyncError'] = undefined;
    if (pushConfigured()) await ensurePushWatch(userId).catch((err) => { patch['gmailRead.lastSyncError'] = `push watch: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500); });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    patch['gmailRead.lastSyncError'] = result.error.slice(0, 500);
  } finally {
    await User.updateOne({ _id: userId }, { $set: { ...patch, 'gmailRead.syncLockUntil': new Date(0) } });
  }

  // Classification runs as jobs of 50; when the queue is off the caller
  // classifies inline (it lives on the ai/ side of the boundary).
  for (let i = 0; i < result.newIds.length; i += 50) await enqueueClassify(userId, result.newIds.slice(i, i + 50));
  return result;
}

export async function inboxStatus(userId: string): Promise<{
  connected: boolean; address?: string; syncEnabled?: boolean; initialSyncDone?: boolean; lastSyncAt?: Date; lastSyncError?: string; grantedAt?: Date;
  initial: { days: number; max: number; bounds: { days: typeof INITIAL_DAYS_BOUNDS; max: typeof INITIAL_MAX_BOUNDS } };
  counts: { total: number; unclassified: number; awaiting: number; processed: number };
}> {
  const user = await User.findById(userId).select('gmailRead inboxInitial');
  const g = user?.gmailRead;
  const [total, unclassified, awaiting, processed] = await Promise.all([
    InboundMessage.countDocuments({ ownerId: userId }),
    InboundMessage.countDocuments({ ownerId: userId, 'triage.status': 'unclassified' }),
    InboundMessage.countDocuments({ ownerId: userId, 'triage.status': 'awaiting_approval' }),
    InboundMessage.countDocuments({ ownerId: userId, 'triage.status': 'processed' }),
  ]);
  return {
    connected: !!g,
    address: g?.address, syncEnabled: g?.syncEnabled, initialSyncDone: g?.initialSyncDone, lastSyncAt: g?.lastSyncAt, lastSyncError: g?.lastSyncError, grantedAt: g?.grantedAt,
    initial: { ...effectiveInitial(user), bounds: { days: INITIAL_DAYS_BOUNDS, max: INITIAL_MAX_BOUNDS } },
    counts: { total, unclassified, awaiting, processed },
  };
}

// ---------------------------------------------------------------- push (Pub/Sub)

// Gmail push: with GMAIL_PUSH_TOPIC set (a Pub/Sub topic Gmail may publish
// to, with a push subscription pointing at /api/inbox/push?token=...), each
// grant registers a watch on INBOX and the sync job renews it a day before
// it expires. A notification only says "something changed for this
// address"; the existing history sync does the reading. Polling stays as
// the fallback, so a missed notification costs latency, not mail.
export function pushConfigured(): boolean {
  return !!process.env.GMAIL_PUSH_TOPIC && !!process.env.GMAIL_PUSH_TOKEN;
}

export async function ensurePushWatch(userId: string, opts: { force?: boolean } = {}): Promise<{ registered: boolean; expiration?: Date; reason?: string }> {
  if (!pushConfigured()) return { registered: false, reason: 'push not configured' };
  const user = await User.findById(userId).select('gmailRead');
  const g = user?.gmailRead;
  if (!g) return { registered: false, reason: 'not connected' };
  const renewBefore = new Date(Date.now() + 86_400_000);
  if (!opts.force && g.watchExpiration && g.watchExpiration > renewBefore) return { registered: true, expiration: g.watchExpiration };
  const client = makeGmailClient(await getValidReadAccessToken(userId));
  const r = await client.watch(process.env.GMAIL_PUSH_TOPIC!, ['INBOX']);
  const expiration = new Date(Number(r.expiration));
  await User.updateOne({ _id: userId }, { $set: { 'gmailRead.watchExpiration': expiration } });
  return { registered: true, expiration };
}

// The Pub/Sub push body: { message: { data: base64({ emailAddress, historyId }) } }.
export function parsePushNotification(body: unknown): { emailAddress: string; historyId?: string } | null {
  const data = (body as { message?: { data?: string } } | undefined)?.message?.data;
  if (!data) return null;
  try {
    const json = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as { emailAddress?: string; historyId?: string | number };
    if (!json.emailAddress) return null;
    return { emailAddress: json.emailAddress.toLowerCase(), historyId: json.historyId !== undefined ? String(json.historyId) : undefined };
  } catch { return null; }
}

export async function userForPushAddress(emailAddress: string): Promise<string | null> {
  const u = await User.findOne({ 'gmailRead.address': emailAddress.toLowerCase(), 'gmailRead.syncEnabled': true }).select('_id').lean();
  return u ? u._id.toString() : null;
}
