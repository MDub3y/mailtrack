import axios from 'axios';
import type { AuthResponse, Email, User, PlatformUser, PlatformDocument, ShareTokenInfo, BulkJobStatus, DocumentAttachment, Organization, AgentRun, AiSettingsView, AiSettingsUpdate, AiConnectionTest, ContactSummary, ContactDetailView, MemoryItem, QueueItem, QueueRule } from '../types';

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
};

export const emailsApi = {
  send: (data: { to: string; subject: string; htmlBody: string; textBody: string; attachments?: DocumentAttachment[] }) =>
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
};

export const contactsApi = {
  list: () => api.get<ContactSummary[]>('/contacts'),
  get: (id: string) => api.get<ContactDetailView>(`/contacts/${id}`),
  addMemory: (id: string, data: { kind: 'fact' | 'commitment' | 'preference'; content: string; structured?: Record<string, unknown> }) =>
    api.post<MemoryItem>(`/contacts/${id}/memory`, data),
  regenerateBrief: (id: string) => api.post<{ generated: boolean; text?: string; runId?: string; message?: string }>(`/contacts/${id}/brief`, {}),
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

export const bulkEmailApi = {
  sendBulk: (data: { recipients: string[]; subject: string; htmlBody: string; textBody: string }) =>
    api.post<{ jobId: string; recipientCount: number }>('/emails/send-bulk', data),
  getStatus: (jobId: string) => api.get<BulkJobStatus>(`/emails/bulk-status/${jobId}`),
};

export default api;
