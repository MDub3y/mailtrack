// The anchors a reply can carry back to a tracked email: our Message-ID
// (<mt-<token>@domain>, set at send time) quoted in In-Reply-To/References,
// or the pixel URL quoted in the body. Shared by the inbox service (no ai/
// imports allowed there) and the classifier's header stage.

const TOKEN_IN_MESSAGE_ID = /<?mt-([0-9a-f-]{36})@[^>\s]+>?/gi;
const TOKEN_IN_PIXEL_URL = /\/api\/track\/([0-9a-f-]{36})\/pixel\.png/gi;

export function tokensInMessageIds(ids: string[]): string[] {
  const out = new Set<string>();
  for (const src of ids) for (const m of (src || '').matchAll(TOKEN_IN_MESSAGE_ID)) out.add(m[1].toLowerCase());
  return [...out];
}

export function tokensInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text || '').matchAll(TOKEN_IN_PIXEL_URL)) out.add(m[1].toLowerCase());
  return [...out];
}

export function trackingTokensIn(h: { inReplyTo?: string; references?: string[] }, text: string): string[] {
  return [...new Set([...tokensInMessageIds([h.inReplyTo ?? '', ...(h.references ?? [])]), ...tokensInText(text)])];
}
