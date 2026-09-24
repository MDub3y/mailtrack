import mongoose, { Document, Schema } from 'mongoose';
import { RunKind, RUN_KINDS } from './AgentRun';

// One replay session: N stored runs re-executed under a variant (prompt,
// model, effort, or none for a drift check), each compared with its
// original. The report is a page in the app, not a log line (doc/05,
// Elevation 4).

export interface IReplayRow {
  runId: mongoose.Types.ObjectId;
  replayRunId?: mongoose.Types.ObjectId;
  status: 'ok' | 'failed' | 'skipped';
  error?: string;
  original: { model: string; costUsd: number; tokens: number };
  replay?: { model: string; costUsd: number; tokens: number; ms: number };
  // Kind-specific checks, each a boolean or a number in [0, 1] with a note.
  checks: Record<string, { value: number | boolean; note?: string }>;
  agreement?: number;   // how close the replay output is to the original, kind-specific, [0, 1]
}

export interface IReplayReport extends Document {
  ownerId: mongoose.Types.ObjectId;
  kind: RunKind;
  trigger: 'cli' | 'user' | 'drift';
  params: { since: Date; limit: number; variant?: string; variantSource?: string; model?: string; effort?: string; judge?: boolean };
  rows: IReplayRow[];
  summary: {
    n: number; ok: number; failed: number;
    meanAgreement?: number;
    checks: Record<string, { pass: number; of: number; mean?: number }>;
    costUsd: { original: number; replay: number; judge: number };
    tokens: { original: number; replay: number };
  };
  createdAt: Date;
  finishedAt?: Date;
}

const RowSchema = new Schema<IReplayRow>({
  runId: { type: Schema.Types.ObjectId, ref: 'AgentRun', required: true },
  replayRunId: { type: Schema.Types.ObjectId, ref: 'AgentRun' },
  status: { type: String, enum: ['ok', 'failed', 'skipped'], required: true },
  error: String,
  original: { type: Schema.Types.Mixed, required: true },
  replay: { type: Schema.Types.Mixed },
  checks: { type: Schema.Types.Mixed, default: {} },
  agreement: Number,
}, { _id: false });

const ReplayReportSchema = new Schema<IReplayReport>({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: RUN_KINDS, required: true },
  trigger: { type: String, enum: ['cli', 'user', 'drift'], required: true },
  params: { type: Schema.Types.Mixed, required: true },
  rows: { type: [RowSchema], default: [] },
  summary: { type: Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now },
  finishedAt: Date,
}, { minimize: false });

ReplayReportSchema.index({ ownerId: 1, createdAt: -1 });

export const ReplayReport = mongoose.model<IReplayReport>('ReplayReport', ReplayReportSchema);
