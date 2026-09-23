import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preClassify, isAutoReply, trackingTokensIn } from '../ai/classify/headers';
import { renderCategoriesForPrompt, slugify, DEFAULT_CATEGORIES } from '../ai/classify/categories';
import { buildMimeMessage, rfcMessageIdFor } from '../services/gmailService';
import type { ClassifiableMessage } from '../ai/classify/types';

// The free tier: header rules, auto-reply detection, and the tracking-token
// anchors a reply can carry. Pure functions, no database.

const base = (over: Omit<Partial<ClassifiableMessage>, 'headers'> & { headers?: Partial<ClassifiableMessage['headers']> } = {}): ClassifiableMessage => ({
  id: 'm1', subject: over.subject ?? 'Hello', text: over.text ?? 'Just a note.', from: over.from ?? 'priya@example.com',
  matchedTracked: over.matchedTracked ?? false,
  headers: { listUnsubscribe: false, references: [], hasCalendarPart: false, fromAddress: over.from ?? 'priya@example.com', ...(over.headers ?? {}) },
});

test('a matched tracked thread wins over everything, at confidence 1', () => {
  const r = preClassify(base({ matchedTracked: true, headers: { listUnsubscribe: true } }));
  assert.equal(r?.categoryKey, 'reply_to_tracked');
  assert.equal(r?.confidence, 1);
  assert.equal(r?.backend, 'headers');
});

test('calendar parts and invitation subjects are calendar_or_meeting', () => {
  assert.equal(preClassify(base({ headers: { hasCalendarPart: true } }))?.categoryKey, 'calendar_or_meeting');
  assert.equal(preClassify(base({ subject: 'Invitation: Pricing review @ Tue 14:00' }))?.categoryKey, 'calendar_or_meeting');
  assert.equal(preClassify(base({ subject: 'Accepted: Kickoff' }))?.categoryKey, 'calendar_or_meeting');
  assert.equal(preClassify(base({ subject: 'Re: invitation to speak' })), null); // not the invite format
});

test('bulk markers are newsletter_or_bulk; noreply senders and plain mail are left to the classifier', () => {
  assert.equal(preClassify(base({ headers: { listUnsubscribe: true } }))?.categoryKey, 'newsletter_or_bulk');
  assert.equal(preClassify(base({ headers: { listId: '<news.example.com>' } }))?.categoryKey, 'newsletter_or_bulk');
  assert.equal(preClassify(base({ headers: { precedence: 'bulk' } }))?.categoryKey, 'newsletter_or_bulk');
  assert.equal(preClassify(base({ headers: { precedence: 'list' } }))?.categoryKey, 'newsletter_or_bulk');
  assert.equal(preClassify(base({ from: 'noreply@shop.example', subject: 'Your receipt' })), null);
  assert.equal(preClassify(base()), null);
});

test('auto-replies are detected from headers or subject', () => {
  assert.equal(isAutoReply({ autoSubmitted: 'auto-replied', precedence: undefined }), true);
  assert.equal(isAutoReply({ autoSubmitted: 'no', precedence: undefined }), false);
  assert.equal(isAutoReply({ autoSubmitted: undefined, precedence: 'auto_reply' }), true);
  assert.equal(isAutoReply({ autoSubmitted: undefined, precedence: undefined }, 'Automatic reply: Out of office until 3 Oct'), true);
  assert.equal(isAutoReply({ autoSubmitted: undefined, precedence: undefined }, 'Re: quote'), false);
});

test('tracking tokens are recovered from our Message-ID in In-Reply-To/References and from a quoted pixel URL', () => {
  const token = '4a7c1b1e-9f2d-4c33-8a1e-0b6d2f9c1a55';
  const mid = rfcMessageIdFor(token, 'sam@gmail.com');
  assert.equal(mid, `<mt-${token}@gmail.com>`);
  assert.deepEqual(trackingTokensIn({ inReplyTo: mid, references: [] }, ''), [token]);
  assert.deepEqual(trackingTokensIn({ inReplyTo: '<abc@other>', references: ['<x@y>', mid.toUpperCase()] }, ''), [token]);
  assert.deepEqual(trackingTokensIn({ references: [] }, `> quoted <img src="https://t.example/api/track/${token}/pixel.png">`), [token]);
  assert.deepEqual(trackingTokensIn({ references: [] }, 'nothing here'), []);

  // And the send path actually emits it.
  const mime = buildMimeMessage({ from: 'sam@gmail.com', to: 'p@x.com', subject: 'S', html: '<p>x</p>', text: 'x', trackingToken: token });
  assert.match(mime, new RegExp(`^Message-ID: <mt-${token}@gmail.com>\\r?$`, 'm'));
  assert.doesNotMatch(buildMimeMessage({ from: 'a@b.c', to: 'p@x.com', subject: 'S', html: '', text: '' }), /Message-ID/);
});

test('category prompt rendering is sorted, capped, and stable; slugify makes valid keys', () => {
  const defs = DEFAULT_CATEGORIES.map((d) => ({ key: d.key, name: d.name, description: d.description, examples: d.examples, policy: d.policy }));
  const a = renderCategoriesForPrompt(defs);
  const b = renderCategoriesForPrompt([...defs].reverse());
  assert.equal(a, b);
  assert.ok(a.startsWith('calendar_or_meeting:'));
  assert.doesNotMatch(a, /[0-9a-f]{24}/);
  assert.equal(slugify('Investor Updates!'), 'investor_updates');
  assert.equal(slugify('2024 plans'), 'c_2024_plans');
});
