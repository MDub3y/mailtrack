// A thin, typed seam over the Gmail REST API for reading mail. Only what
// inbox sync needs; fetch-based like gmailService.ts, no SDK. Tests replace
// the factory with an in-memory client (tests/helpers/fakeGmail.ts).

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailMessageRef { id: string; threadId: string }

export interface GmailHeader { name: string; value: string }

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string; // epoch ms as a string
  payload?: GmailPart;
  sizeEstimate?: number;
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: GmailMessageRef & { labelIds?: string[] } }>;
}

export interface GmailClient {
  getProfile(): Promise<{ emailAddress: string; historyId: string; messagesTotal?: number }>;
  listMessages(q: { q?: string; labelIds?: string[]; maxResults?: number; pageToken?: string }): Promise<{ messages: GmailMessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }>;
  getMessage(id: string, format?: 'full' | 'metadata' | 'minimal'): Promise<GmailMessage>;
  listHistory(q: { startHistoryId: string; labelId?: string; historyTypes?: string[]; maxResults?: number; pageToken?: string }): Promise<{ history: GmailHistoryRecord[]; historyId?: string; nextPageToken?: string }>;
}

export class GmailApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function gmailFetch<T>(accessToken: string, path: string, params: Record<string, string | string[] | number | undefined> = {}): Promise<T> {
  const url = new URL(`${GMAIL_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GmailApiError(res.status, `Gmail ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export function gmailClientFor(accessToken: string): GmailClient {
  return {
    getProfile: () => gmailFetch(accessToken, '/profile'),
    async listMessages(q) {
      const r = await gmailFetch<{ messages?: GmailMessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }>(accessToken, '/messages', {
        q: q.q, labelIds: q.labelIds, maxResults: q.maxResults, pageToken: q.pageToken,
      });
      return { messages: r.messages ?? [], nextPageToken: r.nextPageToken, resultSizeEstimate: r.resultSizeEstimate };
    },
    getMessage: (id, format = 'full') => gmailFetch(accessToken, `/messages/${encodeURIComponent(id)}`, { format }),
    async listHistory(q) {
      const r = await gmailFetch<{ history?: GmailHistoryRecord[]; historyId?: string; nextPageToken?: string }>(accessToken, '/history', {
        startHistoryId: q.startHistoryId, labelId: q.labelId, historyTypes: q.historyTypes, maxResults: q.maxResults, pageToken: q.pageToken,
      });
      return { history: r.history ?? [], historyId: r.historyId, nextPageToken: r.nextPageToken };
    },
  };
}

type Factory = (accessToken: string) => GmailClient;
let factory: Factory = gmailClientFor;

export function makeGmailClient(accessToken: string): GmailClient {
  return factory(accessToken);
}

// Test seam. Never called from product code.
export function __setGmailClientFactoryForTests(f: Factory | null): void {
  factory = f ?? gmailClientFor;
}
