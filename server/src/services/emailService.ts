import * as cheerio from 'cheerio';

export interface OutgoingAttachment { name: string; shareUrl: string }

// Renders attachment links into the outgoing HTML. Each link carries
// ?via=<trackingToken> so a document view can be attributed to this email
// and its recipient (doc/02-ai-architecture.md §1.8). Never mutates the
// stored htmlBody — only the in-memory copy handed to the provider.
export function renderAttachmentLinks(html: string, attachments: OutgoingAttachment[], trackingToken: string): string {
  if (!attachments.length) return html;
  const $ = cheerio.load(html && html.trim() ? html : '<div></div>');
  const items = attachments.map((a) => {
    const url = new URL(a.shareUrl);
    url.searchParams.set('via', trackingToken);
    const safeName = a.name.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));
    return `<li style="margin:4px 0"><a href="${url.toString()}" style="color:#0f172a">${safeName}</a></li>`;
  }).join('');
  const block = `<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e2e8f0;font-family:system-ui,sans-serif;font-size:13px;color:#475569"><div>Attached document${attachments.length > 1 ? 's' : ''}:</div><ul style="padding-left:18px;margin:6px 0 0">${items}</ul></div>`;
  if ($('body').length) $('body').append(block); else $.root().append(block);
  return $.html();
}

export function renderAttachmentText(text: string, attachments: OutgoingAttachment[], trackingToken: string): string {
  if (!attachments.length) return text;
  const lines = attachments.map((a) => {
    const url = new URL(a.shareUrl);
    url.searchParams.set('via', trackingToken);
    return `- ${a.name}: ${url.toString()}`;
  });
  return `${text}\n\nAttached document${attachments.length > 1 ? 's' : ''}:\n${lines.join('\n')}`;
}

// Appends a 1x1 tracking pixel to the outgoing HTML body. Never mutates the
// stored htmlBody — this is only run on the in-memory copy handed to Gmail.
export function injectTrackingPixel(html: string, pixelUrl: string): string {
  const $ = cheerio.load(html && html.trim() ? html : '<div></div>');
  const img = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none !important;" />`;
  if ($('body').length) {
    $('body').append(img);
  } else {
    $.root().append(img);
  }
  return $.html();
}

// Rewrites every http(s) link in the outgoing HTML through the click
// redirect, so a click becomes a signal with a verdict (doc/05, Elevation
// 1). Attachment share links already carry ?via=<token> and are left
// alone, as are mailto:, tel:, anchors and the pixel. Never mutates the
// stored htmlBody: the caller stores the returned link table on the email.
export interface TrackedLinkOut { linkId: string; originalUrl: string }

export function rewriteLinks(html: string, trackingToken: string, baseUrl: string): { html: string; links: TrackedLinkOut[] } {
  if (!html || !html.trim()) return { html, links: [] };
  const $ = cheerio.load(html);
  const links: TrackedLinkOut[] = [];
  const byUrl = new Map<string, string>();
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!/^https?:\/\//i.test(href)) return;
    if (/[?&]via=/.test(href) || href.includes('/api/track/')) return;
    let linkId = byUrl.get(href);
    if (!linkId) {
      linkId = `l${links.length + 1}`;
      byUrl.set(href, linkId);
      links.push({ linkId, originalUrl: href });
    }
    $(el).attr('href', `${baseUrl.replace(/\/$/, '')}/api/track/${trackingToken}/l/${linkId}`);
  });
  return { html: links.length ? $.html() : html, links };
}
