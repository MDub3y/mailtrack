import mongoose, { Document, Schema } from 'mongoose';

// A classification category the cheap tier sorts inbound mail into. Users
// define their own (name, description, examples): directed classification.
// The policy gates the expensive LLM step only; classification itself
// always runs.

export type CategoryPolicy = 'never' | 'ask' | 'auto';
export const CATEGORY_POLICIES: CategoryPolicy[] = ['never', 'ask', 'auto'];

export interface ICategoryExample {
  text: string;
  source: 'seed' | 'user' | 'correction';
  inboundMessageId?: mongoose.Types.ObjectId;
  addedAt: Date;
}

export interface ICategoryEmbedding {
  modelRef: string;                                   // centroids are only valid for the model that produced them
  dimensions: number;
  items: Array<{ hash: string; vector: number[] }>;   // one per category text, keyed by content hash
  centroid: number[];                                 // unit-normalised mean of items
  computedAt: Date;
}

export interface ICategory extends Document {
  ownerId: mongoose.Types.ObjectId;
  key: string;              // slug, unique per owner
  name: string;
  description: string;
  examples: ICategoryExample[];
  policy: CategoryPolicy;
  builtin: boolean;         // shipped defaults: editable, not deletable
  order: number;
  embedding?: ICategoryEmbedding;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_EXAMPLES = 40;
export const CATEGORY_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;

const ExampleSchema = new Schema<ICategoryExample>(
  {
    text: { type: String, required: true, maxlength: 600 },
    source: { type: String, enum: ['seed', 'user', 'correction'], required: true },
    inboundMessageId: { type: Schema.Types.ObjectId, ref: 'InboundMessage' },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const CategorySchema = new Schema<ICategory>({
  ownerId:     { type: Schema.Types.ObjectId, ref: 'User', required: true },
  key:         { type: String, required: true, match: CATEGORY_KEY_RE },
  name:        { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, required: true, maxlength: 400 },
  examples:    { type: [ExampleSchema], default: [] },
  policy:      { type: String, enum: CATEGORY_POLICIES, default: 'ask' },
  builtin:     { type: Boolean, default: false },
  order:       { type: Number, default: 100 },
  embedding: {
    type: new Schema({
      modelRef: String,
      dimensions: Number,
      items: { type: [new Schema({ hash: String, vector: [Number] }, { _id: false })], default: [] },
      centroid: { type: [Number], default: [] },
      computedAt: Date,
    }, { _id: false }),
    select: false, // vectors are large; only the classifier loads them
  },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

CategorySchema.index({ ownerId: 1, key: 1 }, { unique: true });
CategorySchema.index({ ownerId: 1, order: 1 });

export const Category = mongoose.model<ICategory>('Category', CategorySchema);
