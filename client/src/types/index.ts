export interface Organization {
  _id: string;
  name: string;
  domain: string;
  fromEmail: string;
}

export interface User {
  _id: string;
  name: string;
  email: string;
  emailAddress: string;
  gmailAddress?: string;
  organizationId?: Organization;
}

export type EmailStatus = 'sent' | 'delivered' | 'opened' | 'failed';

export interface EmailEvent {
  type: EmailStatus;
  timestamp: string;
  automated?: boolean;
}

export interface DocumentAttachment {
  documentId: string;
  name: string;
  shareUrl: string;
}

export interface Email {
  _id: string;
  senderId: string;
  recipientId?: string;
  from: string;
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  status: EmailStatus;
  events: EmailEvent[];
  attachments: DocumentAttachment[];
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface PlatformUser {
  _id: string;
  name: string;
  emailAddress: string;
}

export interface PlatformDocument {
  _id: string;
  ownerId: string;
  originalName: string;
  mimeType: string;
  size: number;
  viewCount: number;
  createdAt: string;
}

export interface ShareTokenInfo {
  _id: string;
  token: string;
  documentId: string;
  requiresPassword: boolean;
  expiresAt?: string;
  accessCount: number;
  createdAt: string;
  shareUrl: string;
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'refused';

export interface ReceiptSection {
  name: string;
  tokens: number;
  itemIds: string[];
  droppedItemIds: string[];
  cacheBoundary: boolean;
}

export type ProviderName = 'anthropic' | 'openai' | 'openrouter' | 'custom';

export interface AiSettingsView {
  providers: Record<ProviderName, { configured: boolean; last4?: string; addedAt?: string }>;
  customBaseUrl: string | null;
  models: { primary: string | null; extractor: string | null };
  defaults: { primary: string; extractor: string };
  serverKeysAllowed: boolean;
}

export interface AiSettingsUpdate {
  keys?: Partial<Record<ProviderName, string | null>>;
  customBaseUrl?: string | null;
  models?: { primary?: string | null; extractor?: string | null };
}

export interface AiConnectionTest {
  ok: boolean;
  message?: string;
  runId?: string;
  provider?: string;
  model?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd?: number;
  degraded?: string[];
}

export interface AgentRun {
  _id: string;
  kind: string;
  provider?: string;
  modelId: string;
  keySource?: string;
  costSource?: string;
  degraded?: string[];
  effort?: string;
  status: RunStatus;
  inputRefs: Record<string, unknown>;
  receipt: {
    sections: ReceiptSection[];
    totalInputTokens: number;
    exact: boolean;
    cacheReadTokens: number;
  };
  steps?: Array<{ tool: string; input: unknown; outputSummary: string; ms: number; isError?: boolean }>;
  output?: unknown;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  error?: string;
  refusalCategory?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface BulkJobStatus {
  jobId: string;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed';
  progress: number;
  result?: { sent: number; failed: number; errors: string[] };
  failedReason?: string;
}
