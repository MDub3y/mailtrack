import crypto from 'crypto';
import mongoose from 'mongoose';
import { Category, ICategory } from '../../models/Category';
import { runEmbedding } from '../runAgent';
import { resolveProvider, NoProviderKeyError } from '../providers';
import { AiSettings } from '../../models/AiSettings';
import { CategoryDef, ClassifiableMessage, ClassificationResult, ClassifierBackend, FALLBACK_KEY } from './types';

// Embeddings backend: a category is the mean of its texts (name + description
// and each example); a message is matched by cosine similarity. Category
// vectors are computed once per (model, text) and cached on the category;
// message vectors are never stored. Cost is one embedding call per batch.

export const MIN_SIMILARITY = Number(process.env.AI_CLASSIFY_MIN_SIM || 0.25);
const NEGATIVE_CACHE_HOURS = 24;

export function hashText(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

export function categoryTexts(def: CategoryDef): string[] {
  return [`${def.name}: ${def.description}`, ...def.examples.map((e) => e.trim()).filter(Boolean)];
}

export function messageText(msg: Pick<ClassifiableMessage, 'subject' | 'text'>): string {
  return `${msg.subject}\n\n${msg.text}`.slice(0, 1500);
}

export function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function centroidOf(vectors: number[][]): number[] {
  if (!vectors.length) return [];
  const dims = vectors[0].length;
  const sum = new Array<number>(dims).fill(0);
  for (const v of vectors) for (let i = 0; i < dims; i++) sum[i] += v[i];
  return normalise(sum.map((x) => x / vectors.length));
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Brings every category's centroid up to date for the given model, embedding
// only texts that have no stored vector yet. One embedding run for all
// categories, or none when nothing changed.
export async function ensureCentroids(ownerId: mongoose.Types.ObjectId | string, categories: ICategory[], modelRef: string): Promise<{ embedded: number; runId?: string }> {
  const toEmbed: Array<{ cat: ICategory; hash: string; text: string }> = [];
  for (const cat of categories) {
    const known = new Map((cat.embedding?.modelRef === modelRef ? cat.embedding.items : []).map((i) => [i.hash, i.vector]));
    for (const text of categoryTexts({ key: cat.key, name: cat.name, description: cat.description, examples: cat.examples.map((e) => e.text), policy: cat.policy })) {
      const hash = hashText(text);
      if (!known.has(hash)) toEmbed.push({ cat, hash, text });
    }
  }
  const staleModel = categories.some((c) => c.embedding && c.embedding.modelRef !== modelRef);
  const staleCentroid = categories.some((c) => {
    if (!c.embedding || c.embedding.modelRef !== modelRef) return true;
    const hashes = new Set(categoryTexts({ key: c.key, name: c.name, description: c.description, examples: c.examples.map((e) => e.text), policy: c.policy }).map(hashText));
    return c.embedding.items.length !== hashes.size || !c.embedding.items.every((i) => hashes.has(i.hash));
  });
  if (!toEmbed.length && !staleModel && !staleCentroid) return { embedded: 0 };

  let runId: string | undefined;
  const fresh = new Map<string, number[]>();
  if (toEmbed.length) {
    const r = await runEmbedding({ ownerId, model: modelRef, inputs: toEmbed.map((t) => t.text), inputRefs: { note: `category centroids: ${toEmbed.length} texts`, categoryKeys: [...new Set(toEmbed.map((t) => t.cat.key))] } });
    runId = r.runId;
    toEmbed.forEach((t, i) => fresh.set(`${t.cat.key}:${t.hash}`, r.vectors[i]));
  }

  for (const cat of categories) {
    const texts = categoryTexts({ key: cat.key, name: cat.name, description: cat.description, examples: cat.examples.map((e) => e.text), policy: cat.policy });
    const known = new Map((cat.embedding?.modelRef === modelRef ? cat.embedding.items : []).map((i) => [i.hash, i.vector]));
    const items = texts.map((text) => {
      const hash = hashText(text);
      const vector = fresh.get(`${cat.key}:${hash}`) ?? known.get(hash);
      return vector ? { hash, vector } : null;
    }).filter((x): x is { hash: string; vector: number[] } => x !== null);
    const centroid = centroidOf(items.map((i) => i.vector));
    cat.embedding = { modelRef, dimensions: centroid.length, items, centroid, computedAt: new Date() };
    await Category.updateOne({ _id: cat._id }, { $set: { embedding: cat.embedding } });
  }
  return runId ? { embedded: toEmbed.length, runId } : { embedded: toEmbed.length };
}

async function embedderModelRef(ownerId: mongoose.Types.ObjectId | string): Promise<{ ref: string; provider: string }> {
  const r = await resolveProvider(ownerId, 'embedder');
  return { ref: r.ref, provider: r.provider };
}

export const embeddingsBackend: ClassifierBackend = {
  name: 'embeddings',

  async available(ownerId) {
    let resolved;
    try { resolved = await resolveProvider(ownerId, 'embedder'); }
    catch (err) { return { ok: false, reason: err instanceof NoProviderKeyError ? `no key for the embedder's provider (${err.provider})` : (err instanceof Error ? err.message : String(err)) }; }
    if (!resolved.client.embed) return { ok: false, reason: `${resolved.provider} has no embeddings endpoint` };
    const settings = await AiSettings.findOne({ ownerId }).select('capabilities').lean();
    const negativeAt = settings?.capabilities?.embeddingsUnsupported?.[resolved.provider];
    if (negativeAt && Date.now() - new Date(negativeAt).getTime() < NEGATIVE_CACHE_HOURS * 3_600_000) {
      return { ok: false, reason: `${resolved.provider} answered that it has no embeddings (cached)` };
    }
    return { ok: true, modelRef: resolved.ref };
  },

  async classify(ownerId, defs, messages) {
    if (!messages.length) return [];
    const { ref } = await embedderModelRef(ownerId);
    const cats = await Category.find({ ownerId, key: { $in: defs.map((d) => d.key) } }).select('+embedding');
    await ensureCentroids(ownerId, cats, ref);
    const centroids = cats.filter((c) => c.embedding?.centroid.length).map((c) => ({ key: c.key, centroid: c.embedding!.centroid }));
    if (!centroids.length) return messages.map((m) => ({ id: m.id, categoryKey: FALLBACK_KEY, confidence: 0, backend: 'embeddings' as const, modelRef: ref, reason: 'no category centroids' }));

    const r = await runEmbedding({ ownerId, model: ref, inputs: messages.map(messageText), inputRefs: { note: `classify ${messages.length} messages`, inboundMessageIds: messages.map((m) => m.id) } });
    return messages.map((m, i) => {
      const scores: Record<string, number> = {};
      for (const c of centroids) scores[c.key] = Number(cosine(r.vectors[i], c.centroid).toFixed(4));
      const [bestKey, best] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
      const low = best < MIN_SIMILARITY;
      return {
        id: m.id,
        categoryKey: low ? FALLBACK_KEY : bestKey,
        confidence: Math.max(0, Math.min(1, best)),
        backend: 'embeddings' as const,
        modelRef: ref,
        runId: r.runId,
        scores,
        reason: low ? `low_similarity: best ${bestKey} at ${best.toFixed(2)}` : undefined,
      };
    });
  },
};

// Called by the chooser when a call fails with UnsupportedCapabilityError.
export async function markEmbeddingsUnsupported(ownerId: mongoose.Types.ObjectId | string, provider: string): Promise<void> {
  await AiSettings.updateOne({ ownerId }, { $set: { [`capabilities.embeddingsUnsupported.${provider}`]: new Date() } }, { upsert: true });
}
