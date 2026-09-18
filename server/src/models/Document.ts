import mongoose, { Document as MongoDocument, Schema } from 'mongoose';

export interface IPageDwell {
  page: number;
  seconds: number;
}

export interface IDocumentView {
  viewedAt: Date;
  ip: string;
  // Attribution: which sent email's link was used (via=<trackingToken>),
  // and therefore which contact. Absent for anonymous share-link opens.
  viaEmailId?: mongoose.Types.ObjectId;
  contactId?: mongoose.Types.ObjectId;
  // Per-page dwell reported by the viewer while the tab is visible, capped
  // per page, first second ignored (doc/02-ai-architecture.md §1.8).
  pageDwell?: IPageDwell[];
  viewId?: string; // correlates dwell reports with this view entry
}

export interface IDocument extends MongoDocument {
  ownerId: mongoose.Types.ObjectId;
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  viewCount: number;
  views: IDocumentView[];
  createdAt: Date;
}

const DocumentViewSchema = new Schema<IDocumentView>(
  {
    viewedAt:   { type: Date, default: Date.now },
    ip:         { type: String, default: '' },
    viaEmailId: { type: Schema.Types.ObjectId, ref: 'Email' },
    contactId:  { type: Schema.Types.ObjectId, ref: 'Contact' },
    pageDwell:  { type: [new Schema({ page: Number, seconds: Number }, { _id: false })], default: undefined },
    viewId:     { type: String },
  },
  { _id: false }
);

const DocumentSchema = new Schema<IDocument>({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  originalName: { type: String, required: true },
  storedName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  viewCount: { type: Number, default: 0 },
  views: { type: [DocumentViewSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});

DocumentSchema.index({ ownerId: 1, createdAt: -1 });

export const DocModel = mongoose.model<IDocument>('Document', DocumentSchema);
