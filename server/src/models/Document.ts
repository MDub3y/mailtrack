import mongoose, { Document as MongoDocument, Schema } from 'mongoose';

export interface IDocumentView {
  viewedAt: Date;
  ip: string;
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
  { viewedAt: { type: Date, default: Date.now }, ip: { type: String, default: '' } },
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
