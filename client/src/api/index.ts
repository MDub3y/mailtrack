import axios from 'axios';
import type { AuthResponse, Email, User, PlatformUser, PlatformDocument, ShareTokenInfo, BulkJobStatus, DocumentAttachment } from '../types';

const api = axios.create({ baseURL: 'http://localhost:5000/api' });

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
};

export const emailsApi = {
  send: (data: { to: string; subject: string; htmlBody: string; textBody: string; attachments?: DocumentAttachment[] }) =>
    api.post<Email>('/emails/send', data),
  getSent:  () => api.get<Email[]>('/emails/sent'),
  getInbox: () => api.get<Email[]>('/emails/inbox'),
  getById:  (id: string) => api.get<Email>(`/emails/${id}`),
  markOpened: (id: string) => api.patch<Email>(`/emails/${id}/open`),
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

export const bulkEmailApi = {
  sendBulk: (data: { recipients: string[]; subject: string; htmlBody: string; textBody: string }) =>
    api.post<{ jobId: string; recipientCount: number }>('/emails/send-bulk', data),
  getStatus: (jobId: string) => api.get<BulkJobStatus>(`/emails/bulk-status/${jobId}`),
};

export default api;
