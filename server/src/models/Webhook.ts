import mongoose, { Document, Schema } from 'mongoose';

// Per-owner integration settings (doc/05, Elevation 1): one inbound secret
// that lets outside systems add signals about a contact, and any number of
// outbound endpoints that receive what MailTrack decided.

export type OutboundEvent = 'signal' | 'queue';
export const OUTBOUND_EVENTS: OutboundEvent[] = ['signal', 'queue'];

export interface IOutboundEndpoint {
  _id: mongoose.Types.ObjectId;
  url: string;
  secret: string;           // HMAC key; shown once at creation
  events: OutboundEvent[];
  enabled: boolean;
  createdAt: Date;
  lastDeliveryAt?: Date;
  lastStatus?: number;
  lastError?: string;
  failures: number;         // consecutive; the endpoint is paused past MAX_FAILURES
}

export interface IWebhookConfig extends Document {
  ownerId: mongoose.Types.ObjectId;
  inboundSecret: string;
  outbound: IOutboundEndpoint[];
  queueKeys: string[];      // baseline for queue appeared/resolved events
  updatedAt: Date;
}

export const MAX_FAILURES = 20;

const OutboundSchema = new Schema<IOutboundEndpoint>({
  url:            { type: String, required: true },
  secret:         { type: String, required: true, select: false },
  events:         { type: [String], enum: OUTBOUND_EVENTS, default: ['signal', 'queue'] },
  enabled:        { type: Boolean, default: true },
  createdAt:      { type: Date, default: Date.now },
  lastDeliveryAt: Date,
  lastStatus:     Number,
  lastError:      String,
  failures:       { type: Number, default: 0 },
});

const WebhookConfigSchema = new Schema<IWebhookConfig>({
  ownerId:       { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  inboundSecret: { type: String, required: true, unique: true },
  outbound:      { type: [OutboundSchema], default: [] },
  queueKeys:     { type: [String], default: [] },
  updatedAt:     { type: Date, default: Date.now },
});

export const WebhookConfig = mongoose.model<IWebhookConfig>('WebhookConfig', WebhookConfigSchema);
