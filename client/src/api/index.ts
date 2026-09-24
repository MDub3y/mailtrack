import axios from 'axios';
import type { AuthResponse, Email, User, PlatformUser, PlatformDocument, ShareTokenInfo, BulkJobStatus, DocumentAttachment, Organization, AgentRun, AiSettingsView, AiSettingsUpdate, AiConnectionTest, ContactSummary, ContactDetailView, MemoryItem, QueueItem, QueueRule, DraftResult, VoiceView, IntegrityView, OpenSignalRow, InboundMessageView, CategoryView, InboxStatusView, InboxSyncResult, CategoryPolicy, TriageStatus, DigestView, IntegrationsView, ReplayReportView, TrustOverviewView } from '../types';

const API_BASE = 'http://localhost:5000/api';
const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const authApi = {
  register: (data: { name: string; email: string; password: string; emailAddress: string }) =>
    api.post<AuthResponse>('/auth/register', data),
  login: (data: { email: string; password: string }) =>
    api.post<AuthResponse>('/auth/login', data),
  me: () => api.get<User>('/auth/me'),
  googleConnectUrl: () => `${API_BASE}/auth/google?token=${encodeURIComponent(localStorage.getItem('token') || '')}`,
  googleReadConnectUrl: () => `${API_BASE}/auth/google/read?token=${encodeURIComponent(localStorage.getItem('token') || '')}`,
};

export const emailsApi = {
  send: (data: { to: string; subject: string; htmlBody: string; textBody: string; attachments?: DocumentAttachment[]; draftProposalId?: string }) =>
    api.post<Email>('/emails/send', data),
  getSent:  () => api.get<Email[]>('/emails/sent'),
  getInbox: () => api.get<Email[]>('/emails/inbox'),
  getById:  (id: string) => api.get<Email>(`/emails/${id}`),
  searchUsers: (q: string) => api.get<PlatformUser[]>(`/emails/users/search?q=${encodeURIComponent(q)}`),
};

export const documentsApi = {
  upload: (formData: FormData) =>
    api.post<PlatformDocument>('/documents/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  list: () => api.get<PlatformDocument[]>('/documents'),
  delete: (id: string) => api.delete(`/documents/${id}`),
  createShare: (id: string, opts: { password?: string; expiresInHours?: number }) =>
    api.post<{ token: string; shareUrl: string; requiresPassword: boolean; expiresAt?: string }>(`/documents/${id}/share`, opts),
  listShares: (id: string) => api.get<ShareTokenInfo[]>(`/documents/${id}/shares`),
  revokeShare: (docId: string, tokenId: string) => api.delete(`/documents/${docId}/shares/${tokenId}`),
};

export const organizationsApi = {
  create: (data: { name: string; domain: string; sendgridApiKey: string; fromEmail: string }) =>
    api.post<Organization>('/organizations', data),
  join: (organizationId: string) =>
    api.post<Organization>('/organizations/join', { organizationId }),
  me: () => api.get<Organization>('/organizations/me'),
};

export const aiApi = {
  status: () => api.get<{ enabled: boolean; serverKeysAllowed: boolean }>('/ai/status'),
  listRuns: () => api.get<AgentRun[]>('/ai/runs'),
  getRun: (id: string) => api.get<AgentRun>(`/ai/runs/${id}`),
  getSettings: () => api.get<AiSettingsView>('/ai/settings'),
  updateSettings: (data: AiSettingsUpdate) => api.put<AiSettingsView>('/ai/settings', data),
  testConnection: (model?: string) => api.post<AiConnectionTest>('/ai/settings/test', { model }),
  draft: (data: { contactId: string; emailId?: string; rule?: QueueRule; reason?: string }) => api.post<DraftResult>('/ai/draft', data),
  getVoice: () => api.get<VoiceView>('/ai/voice'),
  regenerateVoice: () => api.post<{ prose: string; runId: string; status: string }>('/ai/voice', {}),
  setVoice: (prose: string) => api.put<{ prose: string; source: string }>('/ai/voice', { prose }),
  getTrust: () => api.get<TrustOverviewView>('/ai/trust'),
  setTrust: (data: { enabled?: boolean; minSample?: number; minAcceptanceRate?: number; minConfidence?: number }) => api.put<TrustOverviewView>('/ai/trust', data),
  listReplays: () => api.get<ReplayReportView[]>('/ai/replays'),
  getReplay: (id: string) => api.get<ReplayReportView>(`/ai/replays/${id}`),
  runReplay: (data: { kind?: string; sinceDays?: number; limit?: number; judge?: boolean; drift?: boolean }) => api.post<ReplayReportView | ReplayReportView[]>('/ai/replays', data),
};

export const contactsApi = {
  list: () => api.get<ContactSummary[]>('/contacts'),
  get: (id: string) => api.get<ContactDetailView>(`/contacts/${id}`),
  addMemory: (id: string, data: { kind: 'fact' | 'commitment' | 'preference'; content: string; structured?: Record<string, unknown> }) =>
    api.post<MemoryItem>(`/contacts/${id}/memory`, data),
  regenerateBrief: (id: string) => api.post<{ generated: boolean; text?: string; runId?: string; message?: string }>(`/contacts/${id}/brief`, {}),
  exportMarkdown: (id: string) => api.get<Blob>(`/contacts/${id}/export.md`, { responseType: 'blob' }),
  exportAll: () => api.get<Blob>('/contacts/export.md', { responseType: 'blob' }),
};

// Saves a downloaded blob through a temporary link (the API needs the
// bearer token, so a plain href cannot be used).
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const integrationsApi = {
  get: () => api.get<IntegrationsView>('/integrations'),
  rotateInbound: () => api.post<IntegrationsView>('/integrations/inbound/rotate', {}),
  addOutbound: (data: { url: string; events?: Array<'signal' | 'queue'> }) => api.post<{ _id: string; url: string; events: string[]; secret: string }>('/integrations/outbound', data),
  setOutboundEnabled: (id: string, enabled: boolean) => api.put<{ enabled: boolean }>(`/integrations/outbound/${id}`, { enabled }),
  removeOutbound: (id: string) => api.delete<{ deleted: boolean }>(`/integrations/outbound/${id}`),
  testOutbound: (id: string) => api.post<{ ok: boolean; status?: number; error?: string }>(`/integrations/outbound/${id}/test`, {}).catch((err) => { const d = err?.response?.data; if (d && typeof d.ok === 'boolean') return { data: d as { ok: boolean; status?: number; error?: string } }; throw err; }),
  mcpToken: () => api.post<{ token: string; expiresInDays: number; scope: string }>('/integrations/mcp-token', {}),
};

export const memoryApi = {
  decide: (id: string, data: { decision: 'accept' | 'reject' | 'edit'; content?: string; structured?: Record<string, unknown> }) =>
    api.patch<MemoryItem>(`/memory/${id}`, data),
};

export const queueApi = {
  list: () => api.get<{ items: QueueItem[]; thresholds: Record<string, number> }>('/queue'),
  snooze: (rule: QueueRule, ref: { emailId?: string; memoryId?: string }, days = 3) =>
    api.post(`/queue/${rule}/snooze`, { ...ref, days }),
  dismiss: (rule: QueueRule, ref: { emailId?: string; memoryId?: string }) =>
    api.post(`/queue/${rule}/dismiss`, ref),
};

export const integrityApi = {
  overview: () => api.get<IntegrityView>('/integrity'),
  opensForEmail: (emailId: string) => api.get<OpenSignalRow[]>(`/integrity/email/${emailId}/opens`),
  label: (signalId: string, label: 'human' | 'automated') => api.post<{ ok: boolean; verdict: string; label: string }>(`/integrity/signals/${signalId}/label`, { label }),
  investigate: () => api.post<{ ran: boolean; message?: string; candidates?: number; proposals?: Array<{ ruleId: string; proposalId: string; pattern: string; verdict: string; modelDisagreed: boolean }>; notes?: string; runId?: string }>('/integrity/investigate', {}),
  reclassify: () => api.post<{ scanned: number; changed: number; emailsTouched: number }>('/integrity/reclassify', {}),
  decideProposal: (proposalId: string, decision: 'accept' | 'reject', reason?: string) => api.post(`/ai/proposals/${proposalId}/decide`, { decision, reason }),
};

export const inboxApi = {
  status: () => api.get<InboxStatusView>('/inbox/status'),
  syncNow: () => api.post<InboxSyncResult>('/inbox/sync', {}),
  setSyncEnabled: (enabled: boolean) => api.put<{ enabled: boolean }>('/inbox/sync', { enabled }),
  revoke: () => api.delete<{ revoked: boolean; deletedMessages: number }>('/inbox/grant'),
  listMessages: (q: { category?: string; status?: TriageStatus; limit?: number; before?: string } = {}) => {
    const params = new URLSearchParams();
    if (q.category) params.set('category', q.category);
    if (q.status) params.set('status', q.status);
    if (q.limit) params.set('limit', String(q.limit));
    if (q.before) params.set('before', q.before);
    return api.get<{ messages: InboundMessageView[]; nextBefore: string | null }>(`/inbox/messages?${params.toString()}`);
  },
  getMessage: (id: string) => api.get<InboundMessageView>(`/inbox/messages/${id}`),
  correct: (id: string, categoryKey: string) => api.post<InboundMessageView>(`/inbox/messages/${id}/category`, { categoryKey }),
  process: (id: string) => api.post<{ queued: boolean; status?: string; emailId?: string; runId?: string; extracted?: number; error?: string }>(`/inbox/messages/${id}/process`, {}),
  skip: (id: string) => api.post<{ status: TriageStatus }>(`/inbox/messages/${id}/skip`, {}),
  reclassify: (q: { categoryKey?: string; status?: string; sinceDays?: number } = {}) => api.post<{ selected: number; queued: number; classified?: number }>('/inbox/reclassify', q),
  categories: () => api.get<CategoryView[]>('/inbox/categories'),
  createCategory: (data: { key?: string; name: string; description: string; examples?: string[]; policy?: CategoryPolicy }) => api.post<CategoryView>('/inbox/categories', data),
  updateCategory: (key: string, data: { name?: string; description?: string; examples?: string[]; policy?: CategoryPolicy }) => api.put<CategoryView>(`/inbox/categories/${key}`, data),
  deleteCategory: (key: string) => api.delete<{ deleted: boolean }>(`/inbox/categories/${key}`),
  addExample: (key: string, text: string) => api.post<CategoryView>(`/inbox/categories/${key}/examples`, { text }),
  removeExample: (key: string, index: number) => api.delete<CategoryView>(`/inbox/categories/${key}/examples/${index}`),
};

export const digestApi = {
  get: (since?: string) => api.get<DigestView>(`/digest${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  seen: () => api.post<{ ok: boolean }>('/digest/seen', {}),
  headline: (since?: string) => api.post<{ headline: string | null; runId?: string; message?: string }>('/digest/headline', { since }),
  email: (data: { since?: string; headline?: string }) => api.post<{ sent: boolean; to: string; subject: string }>('/digest/email', data),
  revert: (proposalId: string) => api.post(`/ai/proposals/${proposalId}/decide`, { decision: 'revert', reason: 'reverted from the digest' }),
};

export const bulkEmailApi = {
  sendBulk: (data: { recipients: string[]; subject: string; htmlBody: string; textBody: string }) =>
    api.post<{ jobId: string; recipientCount: number }>('/emails/send-bulk', data),
  getStatus: (jobId: string) => api.get<BulkJobStatus>(`/emails/bulk-status/${jobId}`),
};

export default api;
