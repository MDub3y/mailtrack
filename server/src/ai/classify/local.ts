import { CategoryDef, ClassifiableMessage, ClassificationResult, ClassifierBackend, FALLBACK_KEY } from './types';

// A local backend with no model and no key: term-frequency vectors over
// each category's name, description and examples, cosine against the
// message. Weak but free, and it runs when nothing else can (no key at all)
// or first when AI_CLASSIFY_LOCAL_FIRST=true. Confidence is the cosine
// itself, which is honest about how little it knows. A real local model
// (ONNX zero-shot) would implement the same interface.

const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'with', 'this', 'that', 'from', 'are', 'was', 'have', 'has', 'will', 'our', 'can', 'not', 'but', 'all', 'any', 'here', 'there', 'about', 'into', 'more', 'per', 'please', 'thanks', 'hello']);

export function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9@. ]+/g, ' ').split(/\s+/).map((t) => t.replace(/^\.+|\.+$/g, '')).filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));
}

export function termVector(text: string): Map<string, number> {
  const v = new Map<string, number>();
  for (const t of tokens(text)) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

export function cosineTf(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [, y] of b) nb += y * y;
  for (const [t, x] of a) { const y = b.get(t); if (y) dot += x * y; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export const LOCAL_MIN_SIM = () => Number(process.env.AI_CLASSIFY_LOCAL_MIN_SIM || 0.12);

export function categoryVector(def: CategoryDef): Map<string, number> {
  return termVector([def.name, def.description, ...def.examples].join(' '));
}

export function classifyLocally(defs: CategoryDef[], messages: ClassifiableMessage[]): ClassificationResult[] {
  const vectors = defs.map((d) => ({ key: d.key, v: categoryVector(d) }));
  return messages.map((m) => {
    const mv = termVector(`${m.subject} ${m.subject} ${m.text}`);
    const scores: Record<string, number> = {};
    for (const c of vectors) scores[c.key] = Number(cosineTf(mv, c.v).toFixed(4));
    const [bestKey, best] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] ?? [FALLBACK_KEY, 0];
    const low = best < LOCAL_MIN_SIM();
    return { id: m.id, categoryKey: low ? FALLBACK_KEY : bestKey, confidence: Math.max(0, Math.min(1, best)), backend: 'local' as const, modelRef: 'local:tf-cosine', scores, reason: low ? `low_similarity: best ${bestKey} at ${best.toFixed(2)}` : undefined };
  });
}

export const localBackend: ClassifierBackend = {
  name: 'local',
  async available() { return { ok: true, modelRef: 'local:tf-cosine' }; },
  async classify(_ownerId, defs, messages) { return classifyLocally(defs, messages); },
};
