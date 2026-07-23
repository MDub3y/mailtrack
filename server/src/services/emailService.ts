import sgMail from '@sendgrid/mail';
import * as cheerio from 'cheerio';

const apiKey = process.env.SENDGRID_API_KEY;
if (apiKey) {
  sgMail.setApiKey(apiKey);
}

export interface SendExternalEmailParams {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendExternalEmailResult {
  providerMessageId?: string;
}

// Dispatches a real email via the SendGrid Web API. Throws on failure so the
// BullMQ worker's retry/backoff handles transient send failures.
export async function sendExternalEmail(params: SendExternalEmailParams): Promise<SendExternalEmailResult> {
  if (!process.env.SENDGRID_API_KEY) {
    throw new Error('SENDGRID_API_KEY is not configured');
  }
  if (!process.env.SENDGRID_FROM_EMAIL) {
    throw new Error('SENDGRID_FROM_EMAIL is not configured');
  }

  const [response] = await sgMail.send({
    to: params.to,
    from: process.env.SENDGRID_FROM_EMAIL,
    replyTo: params.from,
    subject: params.subject,
    html: params.html,
    text: params.text || undefined,
  });

  return { providerMessageId: response.headers['x-message-id'] as string | undefined };
}

// Appends a 1x1 tracking pixel to the outgoing HTML body. Never mutates the
// stored htmlBody — this is only run on the in-memory copy handed to SendGrid.
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
