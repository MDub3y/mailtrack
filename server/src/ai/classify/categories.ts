import mongoose from 'mongoose';
import { Category, ICategory, CategoryPolicy, MAX_EXAMPLES, CATEGORY_KEY_RE } from '../../models/Category';
import { CategoryDef, FALLBACK_KEY, REPLY_KEY } from './types';

// Default categories and the operations on a user's category list. Every
// owner gets the defaults once; edits are never overwritten by the seed.

export const DEFAULT_CATEGORIES: Array<Omit<CategoryDef, 'policy'> & { policy: CategoryPolicy; order: number }> = [
  {
    key: REPLY_KEY, name: 'Reply to my email', order: 10, policy: 'auto',
    description: 'A person answering an email I sent through MailTrack, in the same thread.',
    examples: ['Thanks for sending the proposal, a couple of questions on pricing.', 'Thursday works for me, send the contract over.', 'Got it, I will confirm headcount by Friday.'],
  },
  {
    key: 'newsletter_or_bulk', name: 'Newsletter or bulk', order: 20, policy: 'ask',
    description: 'Mass mail: newsletters, marketing, digests, announcements sent to many recipients, with an unsubscribe link.',
    examples: ['Your weekly digest: top stories this week. Unsubscribe here.', 'Introducing our new plans, 20% off this month only.', 'Product update: what shipped in September.'],
  },
  {
    key: 'transactional', name: 'Transactional', order: 30, policy: 'ask',
    description: 'Automated notifications about an account or order: receipts, invoices, password resets, shipping updates, sign-in alerts.',
    examples: ['Your receipt for order #48213: total $129.00.', 'Invoice INV-2041 is due on 30 September.', 'A new sign-in to your account from Chrome on Windows.'],
  },
  {
    key: 'calendar_or_meeting', name: 'Calendar or meeting', order: 40, policy: 'ask',
    description: 'Invitations, acceptances, declines and reschedules for meetings and calls.',
    examples: ['Invitation: Pricing review @ Tue 14:00 (IST).', 'Accepted: Kickoff call on Thursday.', 'Can we move our call to 3pm tomorrow?'],
  },
  {
    key: 'needs_action', name: 'Needs action', order: 50, policy: 'ask',
    description: 'A person asking me for something specific: a decision, a document, a reply by a date, an approval.',
    examples: ['Can you send the security overview before Friday?', 'Please approve the attached quote so we can proceed.', 'Quick question: which plan should we go with?'],
  },
  {
    key: FALLBACK_KEY, name: 'Personal or other', order: 100, policy: 'ask',
    description: 'Anything that does not fit the other categories: personal notes, introductions, general conversation.',
    examples: ['Great to meet you at the conference last week.', 'Happy birthday from all of us.', 'Sharing an article I thought you would find interesting.'],
  },
];

export async function ensureDefaultCategories(ownerId: mongoose.Types.ObjectId | string): Promise<void> {
  const existing = new Set((await Category.find({ ownerId }).select('key').lean()).map((c) => c.key));
  const missing = DEFAULT_CATEGORIES.filter((d) => !existing.has(d.key));
  if (!missing.length) return;
  await Category.insertMany(missing.map((d) => ({
    ownerId, key: d.key, name: d.name, description: d.description, policy: d.policy, builtin: true, order: d.order,
    examples: d.examples.map((text) => ({ text, source: 'seed', addedAt: new Date() })),
  })), { ordered: false }).catch((err: { code?: number }) => { if (err.code !== 11000) throw err; }); // a parallel insert already won
}

export async function loadCategories(ownerId: mongoose.Types.ObjectId | string, opts: { withEmbedding?: boolean } = {}): Promise<ICategory[]> {
  await ensureDefaultCategories(ownerId);
  const q = Category.find({ ownerId }).sort({ order: 1, createdAt: 1 });
  return opts.withEmbedding ? q.select('+embedding') : q;
}

export function toDef(c: ICategory): CategoryDef {
  return { key: c.key, name: c.name, description: c.description, examples: c.examples.map((e) => e.text), policy: c.policy };
}

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z]/.test(s) ? s : `c_${s}`.slice(0, 40);
}

export interface CategoryInput {
  key?: string;
  name: string;
  description: string;
  examples?: string[];
  policy?: CategoryPolicy;
}

export async function createCategory(ownerId: mongoose.Types.ObjectId | string, input: CategoryInput): Promise<ICategory> {
  const key = input.key ?? slugify(input.name);
  if (!CATEGORY_KEY_RE.test(key)) throw new Error('key must be a slug: lowercase letters, digits and underscores, starting with a letter');
  if (await Category.exists({ ownerId, key })) throw new Error(`a category with key "${key}" already exists`);
  const maxOrder = (await Category.findOne({ ownerId }).sort({ order: -1 }).select('order').lean())?.order ?? 0;
  return Category.create({
    ownerId, key, name: input.name.trim(), description: input.description.trim(), policy: input.policy ?? 'ask', builtin: false,
    order: Math.max(maxOrder + 10, 110),
    examples: (input.examples ?? []).map((text) => ({ text: text.trim(), source: 'user', addedAt: new Date() })).filter((e) => e.text),
  });
}

export async function updateCategory(ownerId: mongoose.Types.ObjectId | string, key: string, patch: Partial<Pick<CategoryInput, 'name' | 'description' | 'policy'>> & { examples?: string[] }): Promise<ICategory | null> {
  const c = await Category.findOne({ ownerId, key });
  if (!c) return null;
  if (patch.name !== undefined) c.name = patch.name.trim();
  if (patch.description !== undefined) c.description = patch.description.trim();
  if (patch.policy !== undefined) c.policy = patch.policy;
  if (patch.examples !== undefined) {
    // Replaces seed/user examples; correction examples are kept (they came
    // from real mail and are what the tier learns from).
    const corrections = c.examples.filter((e) => e.source === 'correction');
    c.examples = [...patch.examples.map((t) => t.trim()).filter(Boolean).map((text) => ({ text, source: 'user' as const, addedAt: new Date() })), ...corrections];
  }
  c.updatedAt = new Date();
  await c.save();
  return c;
}

// Builtins cannot be deleted. Deleting a custom category reassigns its
// messages to the fallback (done by the caller in ai/classify, which owns
// InboundMessage) — this returns the deleted key so the caller can.
export async function deleteCategory(ownerId: mongoose.Types.ObjectId | string, key: string): Promise<'deleted' | 'builtin' | 'missing'> {
  const c = await Category.findOne({ ownerId, key });
  if (!c) return 'missing';
  if (c.builtin) return 'builtin';
  await c.deleteOne();
  return 'deleted';
}

// A correction adds the message as an example so the centroid moves. Oldest
// correction examples are evicted first once the cap is hit; seed and user
// examples are never evicted here.
export async function addExample(ownerId: mongoose.Types.ObjectId | string, key: string, example: { text: string; source: 'user' | 'correction'; inboundMessageId?: mongoose.Types.ObjectId }): Promise<ICategory | null> {
  const c = await Category.findOne({ ownerId, key });
  if (!c) return null;
  if (example.inboundMessageId && c.examples.some((e) => e.inboundMessageId?.equals(example.inboundMessageId!))) return c;
  c.examples.push({ text: example.text.slice(0, 600), source: example.source, inboundMessageId: example.inboundMessageId, addedAt: new Date() });
  while (c.examples.length > MAX_EXAMPLES) {
    const idx = c.examples.findIndex((e) => e.source === 'correction');
    if (idx < 0) break;
    c.examples.splice(idx, 1);
  }
  c.updatedAt = new Date();
  await c.save();
  return c;
}

// Prompt rendering for the LLM backend: sorted by key, no ids, no dates, so
// the text is byte-stable for the same category set (cache-friendly).
export function renderCategoriesForPrompt(defs: CategoryDef[], maxExamples = 3): string {
  return [...defs]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((d) => {
      const ex = d.examples.slice(0, maxExamples).map((e) => `  - "${e.replace(/\s+/g, ' ').slice(0, 140)}"`).join('\n');
      return `${d.key}: ${d.name}. ${d.description}${ex ? `\n${ex}` : ''}`;
    })
    .join('\n');
}
