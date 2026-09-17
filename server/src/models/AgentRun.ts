import mongoose, { Document, Schema } from 'mongoose';

// Every model call in the product is one of these. There is no other path to
// the API (see ai/runAgent.ts), so this collection is the complete record of
// what the model was shown, what it did, and what it cost.

export type RunKind =
  | 'smoke'
  | 'extract_memory'
  | 'contact_brief'
  | 'voice_profile'
  | 'draft_follow_up'
  | 'investigate'
  | 'judge';

export const RUN_KINDS: RunKind[] = [
  'smoke', 'extract_memory', 'contact_brief', 'voice_profile', 'draft_follow_up', 'investigate', 'judge',
];

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'refused';

export interface IReceiptSection {
  name: string;
  tokens: number;          // estimate while packing; replaced by the exact count when available
  itemIds: string[];
  droppedItemIds: string[];
  cacheBoundary: boolean;
}

export interface IContextReceipt {
  sections: IReceiptSection[];
  totalInputTokens: number;  // exact, from count_tokens when it succeeded, else the estimate
  exact: boolean;
  cacheReadTokens: number;   // filled from usage after the call
}

export interface IRunStep {
  tool: string;
  input: unknown;
  outputSummary: string;
  ms: number;
  isError?: boolean;
}

export interface IAgentRun extends Document {
  ownerId: mongoose.Types.ObjectId;
  kind: RunKind;
  provider?: string;       // anthropic | openai | openrouter | custom
  modelId: string;         // "provider:model" ref, or the task name for refused runs
  keySource?: string;      // owner | server | none
  effort?: string;
  status: RunStatus;
  inputRefs: {
    emailIds?: string[];
    contactId?: string;
    eventRefs?: Array<{ emailId: string; eventIndex: number }>;
    note?: string;
  };
  receipt: IContextReceipt;
  steps: IRunStep[];
  output?: unknown;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  costSource?: string;     // provider | table | unknown
  degraded: string[];      // features the adapter had to drop for this model
  error?: string;
  refusalCategory?: string;
  startedAt: Date;
  finishedAt?: Date;
}

const ReceiptSectionSchema = new Schema<IReceiptSection>(
  {
    name: String,
    tokens: Number,
    itemIds: [String],
    droppedItemIds: [String],
    cacheBoundary: Boolean,
  },
  { _id: false }
);

const StepSchema = new Schema<IRunStep>(
  {
    tool: String,
    input: Schema.Types.Mixed,
    outputSummary: String,
    ms: Number,
    isError: Boolean,
  },
  { _id: false }
);

const AgentRunSchema = new Schema<IAgentRun>({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  kind:    { type: String, enum: RUN_KINDS, required: true },
  provider: { type: String },
  modelId: { type: String, required: true },
  keySource: { type: String },
  effort:  { type: String },
  status:  { type: String, enum: ['running', 'succeeded', 'failed', 'refused'], default: 'running' },
  inputRefs: { type: Schema.Types.Mixed, default: {} },
  receipt: {
    sections: { type: [ReceiptSectionSchema], default: [] },
    totalInputTokens: { type: Number, default: 0 },
    exact: { type: Boolean, default: false },
    cacheReadTokens: { type: Number, default: 0 },
  },
  steps:  { type: [StepSchema], default: [] },
  output: { type: Schema.Types.Mixed },
  usage: {
    input:      { type: Number, default: 0 },
    output:     { type: Number, default: 0 },
    cacheRead:  { type: Number, default: 0 },
    cacheWrite: { type: Number, default: 0 },
  },
  costUsd: { type: Number, default: 0 },
  costSource: { type: String },
  degraded: { type: [String], default: [] },
  error: { type: String },
  refusalCategory: { type: String },
  startedAt:  { type: Date, default: Date.now },
  finishedAt: { type: Date },
});

// Run log per owner, and the daily budget query (owner + kind + since).
AgentRunSchema.index({ ownerId: 1, startedAt: -1 });
AgentRunSchema.index({ ownerId: 1, kind: 1, startedAt: -1 });

export const AgentRun = mongoose.model<IAgentRun>('AgentRun', AgentRunSchema);
