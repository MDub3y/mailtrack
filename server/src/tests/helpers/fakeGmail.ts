import type { GmailClient, GmailMessage, GmailHistoryRecord, GmailPart } from '../../services/gmailClient';
import { GmailApiError } from '../../services/gmailClient';

// An in-memory Gmail: messages, a history log, and a profile. Tests build
// messages with `gmailMessage()` and drive inboxService through the factory
// seam. Records every call so tests can assert on request shapes and counts.

function b64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface MessageSpec {
  id: string;
  threadId?: string;
  from: string;               // "Name <addr>" or "addr"
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  labelIds?: string[];
  internalDate?: Date | number;
  historyId?: string;
  calendar?: boolean;         // adds a text/calendar part
  attachment?: string;        // adds an attachment part with this filename
  snippet?: string;
}

export function gmailMessage(spec: MessageSpec): GmailMessage {
  const headers = Object.entries({ From: spec.from, To: spec.to ?? 'me@gmail.com', Subject: spec.subject ?? '', Date: new Date(spec.internalDate ?? Date.now()).toUTCString(), 'Message-ID': `<${spec.id}@mail.example>`, ...(spec.headers ?? {}) })
    .map(([name, value]) => ({ name, value }));
  const parts: GmailPart[] = [];
  if (spec.text !== undefined) parts.push({ mimeType: 'text/plain', body: { data: b64url(spec.text), size: spec.text.length } });
  if (spec.html !== undefined) parts.push({ mimeType: 'text/html', body: { data: b64url(spec.html), size: spec.html.length } });
  if (spec.calendar) parts.push({ mimeType: 'text/calendar', filename: 'invite.ics', body: { data: b64url('BEGIN:VCALENDAR'), size: 15 } });
  if (spec.attachment) parts.push({ mimeType: 'application/pdf', filename: spec.attachment, body: { attachmentId: 'att-1', size: 1000 } });
  const payload: GmailPart = parts.length === 1 && !spec.calendar && !spec.attachment
    ? { ...parts[0], headers }
    : { mimeType: 'multipart/mixed', headers, parts };
  return {
    id: spec.id,
    threadId: spec.threadId ?? `thread-${spec.id}`,
    labelIds: spec.labelIds ?? ['INBOX', 'UNREAD'],
    snippet: spec.snippet ?? (spec.text ?? '').slice(0, 80),
    historyId: spec.historyId,
    internalDate: String(new Date(spec.internalDate ?? Date.now()).getTime()),
    payload,
  };
}

export interface FakeGmail extends GmailClient {
  messages: Map<string, GmailMessage>;
  history: GmailHistoryRecord[];
  profile: { emailAddress: string; historyId: string };
  calls: Array<{ method: string; args: unknown }>;
  historyStatus: number | null; // when set, listHistory throws with this status
  add(spec: MessageSpec, opts?: { history?: boolean }): GmailMessage;
}

export function fakeGmail(address = 'me@gmail.com', opts: { historyId?: string } = {}): FakeGmail {
  const self: FakeGmail = {
    messages: new Map(),
    history: [],
    profile: { emailAddress: address, historyId: opts.historyId ?? '1000' },
    calls: [],
    historyStatus: null,
    add(spec, o = {}) {
      const m = gmailMessage(spec);
      self.messages.set(m.id, m);
      if (o.history !== false) {
        const id = String(Number(self.profile.historyId) + 1);
        self.profile.historyId = id;
        self.history.push({ id, messagesAdded: [{ message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds } }] });
        m.historyId = id;
      }
      return m;
    },
    async getProfile() {
      self.calls.push({ method: 'getProfile', args: null });
      return { ...self.profile };
    },
    async listMessages(q) {
      self.calls.push({ method: 'listMessages', args: q });
      let all = [...self.messages.values()].sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
      if (q.labelIds?.length) all = all.filter((m) => q.labelIds!.every((l) => m.labelIds?.includes(l)));
      const after = /after:(\d+)/.exec(q.q ?? '');
      if (after) all = all.filter((m) => Number(m.internalDate) >= Number(after[1]) * 1000);
      const newer = /newer_than:(\d+)d/.exec(q.q ?? '');
      if (newer) all = all.filter((m) => Number(m.internalDate) >= Date.now() - Number(newer[1]) * 86_400_000);
      const start = Number(q.pageToken ?? 0);
      const size = q.maxResults ?? 100;
      const page = all.slice(start, start + size);
      return { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: start + size < all.length ? String(start + size) : undefined, resultSizeEstimate: all.length };
    },
    async getMessage(id) {
      self.calls.push({ method: 'getMessage', args: id });
      const m = self.messages.get(id);
      if (!m) throw new GmailApiError(404, `message ${id} not found`);
      return m;
    },
    async listHistory(q) {
      self.calls.push({ method: 'listHistory', args: q });
      if (self.historyStatus) throw new GmailApiError(self.historyStatus, 'history unavailable');
      const from = Number(q.startHistoryId);
      const all = self.history.filter((h) => Number(h.id) > from);
      const start = Number(q.pageToken ?? 0);
      const size = q.maxResults ?? 100;
      const page = all.slice(start, start + size);
      return { history: page, historyId: self.profile.historyId, nextPageToken: start + size < all.length ? String(start + size) : undefined };
    },
  };
  return self;
}
