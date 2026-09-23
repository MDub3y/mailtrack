import { resolveProvider, UnsupportedCapabilityError } from '../providers';
import { embeddingsBackend, markEmbeddingsUnsupported } from './embeddings';
import { llmBackend } from './llm';
import { CategoryDef, ClassifiableMessage, ClassificationResult, ClassifierBackend } from './types';

// Picks the cheapest backend the owner's keys can serve. Embeddings when the
// embedder's provider has a key and an embeddings endpoint (and has not
// recently said otherwise); else the cheap LLM; else nothing, with a reason
// the UI can show. A third backend (local model) slots in front of both.

export interface BackendChoice {
  backend: ClassifierBackend | null;
  modelRef?: string;
  reasons: string[]; // why the cheaper options were passed over
}

let extraBackends: ClassifierBackend[] = [];
// Test/extension seam: backends tried before embeddings, in order.
export function __setExtraBackendsForTests(backends: ClassifierBackend[]): void {
  extraBackends = backends;
}

export async function pickBackend(ownerId: string): Promise<BackendChoice> {
  const reasons: string[] = [];
  for (const b of [...extraBackends, embeddingsBackend, llmBackend]) {
    const a = await b.available(ownerId);
    if (a.ok) return { backend: b, modelRef: a.modelRef, reasons };
    reasons.push(`${b.name}: ${a.reason}`);
  }
  return { backend: null, reasons };
}

export interface ClassifyOutcome {
  results: ClassificationResult[];
  backend: ClassifierBackend['name'] | null;
  reasons: string[];
}

// Runs the chosen backend; if embeddings turn out unsupported at call time,
// caches that on the owner's settings and retries the same batch with the LLM.
export async function classifyWithBestBackend(ownerId: string, defs: CategoryDef[], messages: ClassifiableMessage[]): Promise<ClassifyOutcome> {
  if (!messages.length) return { results: [], backend: null, reasons: [] };
  const choice = await pickBackend(ownerId);
  if (!choice.backend) return { results: [], backend: null, reasons: choice.reasons };
  try {
    const results = await choice.backend.classify(ownerId, defs, messages);
    return { results, backend: choice.backend.name, reasons: choice.reasons };
  } catch (err) {
    if (!(err instanceof UnsupportedCapabilityError) || choice.backend.name !== 'embeddings') throw err;
    const provider = (await resolveProvider(ownerId, 'embedder')).provider;
    await markEmbeddingsUnsupported(ownerId, provider);
    const reasons = [...choice.reasons, `embeddings: ${provider} answered "${err.detail ?? 'unsupported'}"; cached for 24h`];
    const llm = await llmBackend.available(ownerId);
    if (!llm.ok) return { results: [], backend: null, reasons: [...reasons, `llm: ${llm.reason}`] };
    const results = await llmBackend.classify(ownerId, defs, messages);
    return { results, backend: 'llm', reasons };
  }
}
