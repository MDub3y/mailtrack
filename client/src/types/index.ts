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

export type EmailStatus = 'sent' | 'delivered' | 'opened' | 'failed' | 'received';

export interface EmailEvent {
  type: EmailStatus | 'clicked';
  linkId?: string;
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
  trackedLinks?: Array<{ linkId: string; originalUrl: string; clickCount: number }>;
  clickCount?: number;
  lastClickedAt?: string;
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
  volume30dByType?: Record<string, Record<string, number>>;
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
  models: { primary: string | null; extractor: string | null; embedder: string | null };
  defaults: { primary: string; extractor: string; embedder: string };
  serverKeysAllowed: boolean;
}

export interface AiSettingsUpdate {
  keys?: Partial<Record<ProviderName, string | null>>;
  customBaseUrl?: string | null;
  models?: { primary?: string | null; extractor?: string | null; embedder?: string | null };
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
  dimensions?: number;
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

// ---------------------------------------------------------------------------
// Inbox triage (Phase 4)
// ---------------------------------------------------------------------------

export type TriageStatus = 'unclassified' | 'classified' | 'awaiting_approval' | 'processed' | 'skipped' | 'failed';
export type ClassifierBackend = 'headers' | 'embeddings' | 'llm' | 'local' | 'human';
export type CategoryPolicy = 'never' | 'ask' | 'auto';

export interface InboundMessageView {
  _id: string;
  gmailMessageId: string;
  gmailThreadId: string;
  internalDate: string;
  from: { address: string; name?: string };
  subject: string;
  snippet: string;
  textExcerpt?: string;
  matchedEmailId?: string;
  matchedBy?: 'thread' | 'message_id' | 'pixel_url';
  contactId?: string;
  emailId?: string;
  headers?: { hasAttachments?: boolean; hasCalendarPart?: boolean; listUnsubscribe?: boolean };
  classification?: {
    categoryKey: string;
    confidence: number;
    backend: ClassifierBackend;
    modelRef?: string;
    runId?: string;
    scores?: Record<string, number>;
    reason?: string;
    correctedFrom?: string;
    at: string;
  };
  triage: { status: TriageStatus; policyAtDecision?: CategoryPolicy; processedAt?: string; processRunId?: string; error?: string };
}

export interface CategoryView {
  key: string;
  name: string;
  description: string;
  policy: CategoryPolicy;
  builtin: boolean;
  order: number;
  examples: Array<{ text: string; source: 'seed' | 'user' | 'correction'; addedAt: string }>;
  counts: { total: number; awaiting: number };
}

export interface InboxStatusView {
  aiEnabled: boolean;
  connected: boolean;
  address?: string;
  syncEnabled?: boolean;
  initialSyncDone?: boolean;
  lastSyncAt?: string;
  lastSyncError?: string;
  grantedAt?: string;
  counts: { total: number; unclassified: number; awaiting: number; processed: number };
}

export interface InboxSyncResult {
  queued: boolean;
  sync?: { skipped?: string; mode?: string; fetched: number; created: number; capped: boolean; error?: string };
  classify?: { considered: number; classified: number; awaiting: number; auto: number; skipped: number; unclassified: number };
}

// ---------------------------------------------------------------------------
// Digest (Phase 5)
// ---------------------------------------------------------------------------

export interface DigestContactRef { _id: string; address: string; displayName?: string }

export interface DigestView {
  since: string;
  now: string;
  firstLook: boolean;
  contacts: Array<{ contact: DigestContactRef; signals: Array<{ type: string; count: number; last: string; detail?: string }>; total: number }>;
  queue: { appeared: QueueItem[]; resolved: Array<{ key: string; rule: string }>; current: number };
  autoAccepted: Array<{ proposalId: string; kind: string; content: string; contact?: DigestContactRef; decidedAt: string; memoryId?: string }>;
  commitmentsDue: Array<{ memoryId: string; contact: DigestContactRef; content: string; by: 'sender' | 'contact' | 'unknown'; dueAt: string; overdue: boolean }>;
  integrity: { rulesAccepted: Array<{ ruleId: string; pattern: string; patternType: string; verdict: string; at: string }>; corrections: number };
  hasSomething: boolean;
  text: string;
  aiEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Integrations (Phase 5)
// ---------------------------------------------------------------------------

export interface OutboundEndpointView {
  _id: string;
  url: string;
  events: Array<'signal' | 'queue'>;
  enabled: boolean;
  createdAt: string;
  lastDeliveryAt?: string;
  lastStatus?: number;
  lastError?: string;
  failures: number;
}

export interface IntegrationsView {
  inbound: { url: string };
  outbound: OutboundEndpointView[];
  mcp: { url: string };
}

// ---------------------------------------------------------------------------
// Replay reports (Phase 6)
// ---------------------------------------------------------------------------

export interface ReplayCheckSummary { pass: number; of: number; mean?: number }

export interface ReplayReportView {
  _id: string;
  kind: string;
  trigger: 'cli' | 'user' | 'drift';
  params: { since: string; limit: number; variant?: string; variantSource?: string; model?: string; effort?: string; judge?: boolean };
  rows?: Array<{ runId: string; replayRunId?: string; status: 'ok' | 'failed' | 'skipped'; error?: string; original: { model: string; costUsd: number; tokens: number }; replay?: { model: string; costUsd: number; tokens: number; ms: number }; checks: Record<string, { value: number | boolean; note?: string }>; agreement?: number }>;
  summary: { n: number; ok: number; failed: number; meanAgreement?: number; checks: Record<string, ReplayCheckSummary>; costUsd: { original: number; replay: number; judge: number }; tokens: { original: number; replay: number } };
  createdAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Trust policy (Phase 6)
// ---------------------------------------------------------------------------

export interface TrustOverviewView {
  config: { enabled: boolean; minSample: number; minAcceptanceRate: number; minConfidence: number; source: { enabled: 'server' | 'owner' | 'default'; thresholds: 'server' | 'owner' | 'default' } };
  kinds: Array<{ kind: string; reversible: boolean; sample: number; acceptanceRate: number; earned: boolean; reason: string; autoAccepted30d: number; reverted30d: number; pending: number }>;
  calibration: Record<string, { buckets: Array<{ from: number; to: number; n: number; accepted: number; rate: number }>; suggestedMinConfidence?: number; n: number }>;
}
