import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { Category, MAX_EXAMPLES } from '../models/Category';
import { ensureDefaultCategories, loadCategories, createCategory, updateCategory, deleteCategory, addExample, toDef, DEFAULT_CATEGORIES } from '../ai/classify/categories';

// Categories are the user's own words for what their mail is. Defaults are
// seeded once and never overwrite edits; builtins cannot be deleted;
// correction examples are what the cheap tier learns from.

const owner = new mongoose.Types.ObjectId();

before(async () => { await connectTestDb(); });
beforeEach(async () => { await resetTestDb(); });
after(async () => { await disconnectTestDb(); });

test('defaults are seeded once per owner, with policies, and edits survive a re-seed', async () => {
  await ensureDefaultCategories(owner);
  await ensureDefaultCategories(owner);
  const cats = await loadCategories(owner);
  assert.deepEqual(cats.map((c) => c.key), DEFAULT_CATEGORIES.map((d) => d.key));
  assert.equal(cats.find((c) => c.key === 'reply_to_tracked')!.policy, 'auto');
  assert.ok(cats.filter((c) => c.key !== 'reply_to_tracked').every((c) => c.policy === 'ask'));
  assert.ok(cats.every((c) => c.builtin && c.examples.length >= 3 && c.examples.every((e) => e.source === 'seed')));

  await updateCategory(owner, 'needs_action', { description: 'Anything I must answer this week.', policy: 'auto' });
  await ensureDefaultCategories(owner);
  const edited = await Category.findOne({ ownerId: owner, key: 'needs_action' }).lean();
  assert.equal(edited!.description, 'Anything I must answer this week.');
  assert.equal(edited!.policy, 'auto');

  // Another owner gets their own copy.
  const other = new mongoose.Types.ObjectId();
  await ensureDefaultCategories(other);
  assert.equal(await Category.countDocuments(), DEFAULT_CATEGORIES.length * 2);
});

test('custom categories: slug keys, uniqueness, ordering after the defaults, deletion rules', async () => {
  await ensureDefaultCategories(owner);
  const c = await createCategory(owner, { name: 'Investor updates', description: 'Mail from or about our investors.', examples: ['Board deck for Q3 attached', ' '] });
  assert.equal(c.key, 'investor_updates');
  assert.equal(c.builtin, false);
  assert.equal(c.policy, 'ask');
  assert.ok(c.order > 100);
  assert.deepEqual(c.examples.map((e) => [e.text, e.source]), [['Board deck for Q3 attached', 'user']]);

  await assert.rejects(createCategory(owner, { key: 'investor_updates', name: 'Dup', description: 'x' }), /already exists/);
  await assert.rejects(createCategory(owner, { key: 'Bad Key', name: 'x', description: 'x' }), /slug/);
  assert.equal(await deleteCategory(owner, 'transactional'), 'builtin');
  assert.equal(await deleteCategory(owner, 'nope'), 'missing');
  assert.equal(await deleteCategory(owner, 'investor_updates'), 'deleted');
  assert.equal(await Category.exists({ ownerId: owner, key: 'investor_updates' }), null);
});

test('updating examples replaces seed/user ones but keeps corrections; addExample dedupes and evicts oldest corrections first', async () => {
  await ensureDefaultCategories(owner);
  const m1 = new mongoose.Types.ObjectId();
  await addExample(owner, 'needs_action', { text: 'Please sign the NDA by Monday', source: 'correction', inboundMessageId: m1 });
  await addExample(owner, 'needs_action', { text: 'Please sign the NDA by Monday (again)', source: 'correction', inboundMessageId: m1 }); // same message → no duplicate
  let c = (await Category.findOne({ ownerId: owner, key: 'needs_action' }))!;
  assert.equal(c.examples.filter((e) => e.source === 'correction').length, 1);

  await updateCategory(owner, 'needs_action', { examples: ['Decide on the vendor by Friday'] });
  c = (await Category.findOne({ ownerId: owner, key: 'needs_action' }))!;
  assert.deepEqual(c.examples.map((e) => e.source), ['user', 'correction']);
  assert.equal(toDef(c).examples.length, 2);

  // Fill past the cap with corrections: the oldest correction goes first,
  // the user example stays.
  for (let i = 0; i < MAX_EXAMPLES + 5; i++) {
    await addExample(owner, 'needs_action', { text: `correction ${i}`, source: 'correction', inboundMessageId: new mongoose.Types.ObjectId() });
  }
  c = (await Category.findOne({ ownerId: owner, key: 'needs_action' }))!;
  assert.equal(c.examples.length, MAX_EXAMPLES);
  assert.equal(c.examples[0].source, 'user');
  assert.equal(c.examples.some((e) => e.text === 'Please sign the NDA by Monday'), false);
  assert.equal(c.examples.at(-1)!.text, `correction ${MAX_EXAMPLES + 4}`);

  assert.equal(await addExample(owner, 'missing_key', { text: 'x', source: 'user' }), null);
});

test('the embedding field is hidden unless asked for', async () => {
  await ensureDefaultCategories(owner);
  await Category.updateOne({ ownerId: owner, key: 'transactional' }, { $set: { embedding: { modelRef: 'openai:text-embedding-3-small', dimensions: 2, items: [{ hash: 'h', vector: [1, 0] }], centroid: [1, 0], computedAt: new Date() } } });
  const plain = (await loadCategories(owner)).find((c) => c.key === 'transactional')!;
  assert.equal(plain.embedding, undefined);
  const withEmb = (await loadCategories(owner, { withEmbedding: true })).find((c) => c.key === 'transactional')!;
  assert.deepEqual(withEmb.embedding!.centroid, [1, 0]);
});
