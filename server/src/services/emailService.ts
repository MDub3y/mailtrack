import * as cheerio from 'cheerio';

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
