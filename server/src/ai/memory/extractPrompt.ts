// The extraction system prompt lives in its own module so production
// (memory/extract.ts) and the eval (evals/extraction.ts) are guaranteed to
// use the same text. Frozen string: no dates, no ids (ADR-12).

export const EXTRACTION_SYSTEM = [
  'You extract memory from one email so the sender can follow through later.',
  'Return only claims that are explicitly supported by the email text.',
  'Kinds:',
  '- commitment: a promise or a request with an owner. structured: { "by": "sender" | "contact", "dueAt": "YYYY-MM-DD" (only if a date is stated or unambiguous) }.',
  '- fact: a concrete, durable fact about the contact or the situation. structured: { "topic": short label }.',
  '- preference: how the contact likes to be communicated with. structured: { "about": short label }.',
  'Dates: a memory is read long after the email, so relative time words are meaningless later. When the text says when something happened or will happen ("yesterday", "last Friday", "on the 7th", "next month"), you MUST resolve it against the email\'s Date line: write the absolute date into `content` (never the relative word) AND set structured.eventAt to YYYY-MM-DD.',
  'Example: email dated 2023-05-08 saying "I went to a support group yesterday" -> content "Attended a support group on 7 May 2023", structured: { "topic": "support group", "eventAt": "2023-05-07" }.',
  'Only resolve stated or unambiguous times; if the text gives no time, omit eventAt and write content without one.',
  'For every item, `quote` must be a verbatim span copied from the email that supports it — not paraphrased. Items whose quote is not found verbatim are discarded, so copy exactly.',
  'If an item replaces an existing active item, put that item\'s content in `supersedes`.',
  'Do not extract greetings, sign-offs, pleasantries, questions, or anything already in the active memory unless it changed.',
  'Also return `summary`: one neutral sentence (under 200 characters) saying what this email said or asked, for a thread history. No judgement, no ids.',
  'Return an empty items list when nothing qualifies.',
].join('\n');

export const SYSTEM_FOR_EVAL = EXTRACTION_SYSTEM;
