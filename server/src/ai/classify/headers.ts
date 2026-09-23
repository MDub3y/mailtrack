import { ClassifiableMessage, ClassificationResult, HeaderFacts, REPLY_KEY } from './types';

// Deterministic pre-classification from headers (doc/plan Phase 4, tier 1).
// No model, no database. A message that matches here never reaches the
// cheap classifier. Deliberately narrow: noreply senders are NOT a rule,
// because receipts come from noreply addresses; that is left to the
// classifier and the correction loop.

const INVITE_SUBJECT = /^\s*(invitation|updated invitation|accepted|declined|tentatively accepted|canceled event|cancelled event)\s*:/i;

export function preClassify(msg: ClassifiableMessage): ClassificationResult | null {
  const h = msg.headers;
  if (msg.matchedTracked) {
    return { id: msg.id, categoryKey: REPLY_KEY, confidence: 1, backend: 'headers', reason: 'in a thread MailTrack started' };
  }
  if (h.hasCalendarPart || INVITE_SUBJECT.test(msg.subject)) {
    return { id: msg.id, categoryKey: 'calendar_or_meeting', confidence: 0.95, backend: 'headers', reason: h.hasCalendarPart ? 'calendar part' : 'invitation subject' };
  }
  if (h.listUnsubscribe || h.listId || /^(bulk|list)$/i.test(h.precedence ?? '')) {
    const why = h.listUnsubscribe ? 'List-Unsubscribe header' : h.listId ? 'List-Id header' : `Precedence: ${h.precedence}`;
    return { id: msg.id, categoryKey: 'newsletter_or_bulk', confidence: 0.9, backend: 'headers', reason: why };
  }
  return null;
}

// Out-of-office and other machine replies must never count as a reply
// signal (ADR-10: say how the signal lies).
export function isAutoReply(h: Pick<HeaderFacts, 'autoSubmitted' | 'precedence'>, subject = ''): boolean {
  if (h.autoSubmitted && !/^no$/i.test(h.autoSubmitted)) return true;
  if (/^auto[-_]?reply$/i.test(h.precedence ?? '')) return true;
  return /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office)\b/i.test(subject);
}

// Tracking tokens a reply can carry: our Message-ID (<mt-<token>@domain>) in
// In-Reply-To/References, or the pixel URL quoted in the body.
const TOKEN_IN_MESSAGE_ID = /<?mt-([0-9a-f-]{36})@[^>\s]+>?/gi;
const TOKEN_IN_PIXEL_URL = /\/api\/track\/([0-9a-f-]{36})\/pixel\.png/gi;

export function trackingTokensIn(h: Pick<HeaderFacts, 'inReplyTo' | 'references'>, text: string): string[] {
  const out = new Set<string>();
  for (const src of [h.inReplyTo ?? '', ...(h.references ?? [])]) {
    for (const m of src.matchAll(TOKEN_IN_MESSAGE_ID)) out.add(m[1].toLowerCase());
  }
  for (const m of (text || '').matchAll(TOKEN_IN_PIXEL_URL)) out.add(m[1].toLowerCase());
  return [...out];
}
