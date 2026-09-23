import type { CategoryPolicy } from '../../models/Category';
import type { ClassifierBackendName } from '../../models/InboundMessage';

// The neutral shapes every classification backend speaks. A local model
// (ONNX zero-shot) later implements ClassifierBackend directly; it never
// needs the LLM provider interface.

export interface HeaderFacts {
  listUnsubscribe: boolean;
  listId?: string;
  precedence?: string;
  autoSubmitted?: string;
  hasCalendarPart: boolean;
  inReplyTo?: string;
  references: string[];
  fromAddress: string;
}

export interface ClassifiableMessage {
  id: string;
  subject: string;
  text: string;            // excerpt, already capped
  from: string;
  headers: HeaderFacts;
  matchedTracked: boolean; // deterministic reply match already found
}

export interface CategoryDef {
  key: string;
  name: string;
  description: string;
  examples: string[];
  policy: CategoryPolicy;
}

export interface ClassificationResult {
  id: string;
  categoryKey: string;
  confidence: number;
  backend: Exclude<ClassifierBackendName, 'human'>;
  modelRef?: string;
  runId?: string;
  scores?: Record<string, number>;
  reason?: string;
}

export interface ClassifierBackend {
  readonly name: 'embeddings' | 'llm' | 'local';
  available(ownerId: string): Promise<{ ok: true; modelRef: string } | { ok: false; reason: string }>;
  classify(ownerId: string, categories: CategoryDef[], messages: ClassifiableMessage[]): Promise<ClassificationResult[]>;
}

// The one category everything falls back to.
export const FALLBACK_KEY = 'personal_or_other';
export const REPLY_KEY = 'reply_to_tracked';
