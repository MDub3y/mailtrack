import mongoose, { Document, Schema } from 'mongoose';

// One outbound delivery attempt record per envelope and endpoint (Phase 6),
// so failed deliveries can be redelivered on request and the page can show
// what went out. Kept for WEBHOOK_DELIVERY_RETENTION_DAYS (default 30).

export interface IWebhookDelivery extends Document {
  ownerId: mongoose.Types.ObjectId;
  endpointId: mongoose.Types.ObjectId;
  envelopeId: string;
  event: string;
  envelope: unknown;
  status: 'ok' | 'failed';
  attempts: number;
  lastStatus?: number;
  lastError?: string;
  createdAt: Date;
  lastAttemptAt: Date;
}

const WebhookDeliverySchema = new Schema<IWebhookDelivery>({
  ownerId:       { type: Schema.Types.ObjectId, ref: 'User', required: true },
  endpointId:    { type: Schema.Types.ObjectId, required: true },
  envelopeId:    { type: String, required: true },
  event:         { type: String, required: true },
  envelope:      { type: Schema.Types.Mixed, required: true },
  status:        { type: String, enum: ['ok', 'failed'], required: true },
  attempts:      { type: Number, default: 1 },
  lastStatus:    Number,
  lastError:     String,
  createdAt:     { type: Date, default: Date.now },
  lastAttemptAt: { type: Date, default: Date.now },
}, { minimize: false });

WebhookDeliverySchema.index({ endpointId: 1, envelopeId: 1 }, { unique: true });
WebhookDeliverySchema.index({ ownerId: 1, status: 1, createdAt: -1 });

export const WebhookDelivery = mongoose.model<IWebhookDelivery>('WebhookDelivery', WebhookDeliverySchema);
