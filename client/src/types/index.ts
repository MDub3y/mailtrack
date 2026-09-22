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

export type MemoryKind = 'fact' | 'commitment' | 'preference' | 'engagement' | 'voice' | 'fingerprint';
export type MemoryStatus = 'proposed' | 'active' | 'rejected' | 'superseded';

export interface MemoryItem {
  _id: string;
  kind: MemoryKind;
  content: string;
  structured?: Record<string, unknown>;
  evidence: Array<{ emailId?: string; signalId?: string; quote?: string }>;
  confidence: number;
  source: 'agent' | 'user' | 'system';
  status: MemoryStatus;
  createdAt: string;
  lastConfirmedAt?: string;
  expiresAt?: string;
  proposalId?: string;
  createdByRunId?: string;
}

export interface ContactBrief {
  text: string;
  citedMemoryIds: string[];
  basedOnSignalCount: number;
  generatedAt: string;
  runId: string;
}

export interface ContactSummary {
  _id: string;
  address: string;
  domain: string;
  displayName?: string;
  lastSentAt?: string;
  lastSignalAt?: string;
  stats: { sent: number; opened: number; replied: number; docViews: number };
  memoryCounts: { active: number; proposed: number };
  briefText?: string;
}

export interface SignalRow {
  _id: string;
  type: string;
  at: string;
  emailId?: string;
  payload: Record<string, unknown>;
  integrity: { verdict: 'human' | 'automated' | 'unknown' };
}

export interface ContactDetailView {
  contact: ContactSummary & { brief?: ContactBrief };
  memory: MemoryItem[];
  emails: Array<{ _id: string; subject: string; status: EmailStatus; createdAt: string; openCount: number; firstOpenedAt?: string }>;
  signals: SignalRow[];
}

export type QueueRule = 'unopened' | 'opened_no_reply' | 'document_interest' | 'your_commitment_due' | 'their_commitment_due' | 'renewed_interest';

export interface QueueItem {
  rule: QueueRule;
  reason: string;
  contact: { _id: string; address: string; displayName?: string; brief?: string };
  email?: { _id: string; subject: string; createdAt: string; status: string };
  memoryId?: string;
  at: string;
}

export interface DraftResult {
  draft: { subject: string; body: string; usedMemoryIds: string[]; usedEmailIds: string[]; gaps?: string[] };
  receipt: { sections: ReceiptSection[]; totalInputTokens: number; exact: boolean; cacheReadTokens: number };
  runId: string;
  proposalId: string;
  provider: string;
  model: string;
  degraded: string[];
  usedMemory: Array<{ id: string; text: string }>;
  usedEmails: Array<{ id: string; subject: string; date: string }>;
  gaps: string[];
}

export interface VoiceView {
  profile: { _id: string; prose: string; structured?: Record<string, unknown>; source: 'agent' | 'user' | 'system'; createdAt: string; runId?: string } | null;
  samples: number;
  minSamples: number;
}

export interface FingerprintRuleView {
  _id: string;
  patternType: 'ua_regex' | 'ip_cidr' | 'timing_floor_ms';
  pattern: string;
  verdict: 'automated' | 'human';
  status: 'proposed' | 'active' | 'retired' | 'rejected';
  confidence: number;
  reasoning?: string;
  evidence: Array<{ signalId: string }>;
  predictedEffect?: { wouldReclassify: number; matchesLabelled: { agree: number; disagree: number }; modelDisagreed?: boolean; modelReported?: { wouldReclassify: number; matchesLabelled: { agree: number; disagree: number } } };
  proposedByRunId?: string;
  proposalId?: string;
  reviewNote?: string;
  measured?: { precision: number; recall: number; n: number; at: string };
  origin: 'seed' | 'investigator' | 'user';
  createdAt: string;
}

export interface IntegrityView {
  metrics: {
    n: number; truePositive: number; falsePositive: number; falseNegative: number; trueNegative: number;
    precision: number; recall: number; humanRecall: number;
    misses: Array<{ id: string; label: string; predicted: string; userAgent: string; msSinceCreated: number }>;
  };
  seedHeuristics: Array<{ patternType: string; pattern: string; verdict: string; reasoning?: string }>;
  rules: { active: FingerprintRuleView[]; proposed: FingerprintRuleView[]; rejected: FingerprintRuleView[] };
  volume30d: Record<string, number>;
}

export interface OpenSignalRow {
  _id: string;
  at: string;
  verdict: 'human' | 'automated' | 'unknown';
  label: 'human' | 'automated' | null;
  userAgent?: string;
  msSinceCreated?: number;
  matchedBy: string | null;
  eventIndex?: number;
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
