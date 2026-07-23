const SENDGRID_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';

export interface SendViaSendGridParams {
  apiKey: string;
  fromEmail: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendViaSendGridResult {
  providerMessageId?: string;
}

// Dispatches a real email through an enterprise's own SendGrid account (they
// authenticate their own domain — SPF/DKIM — at onboarding, so this doesn't
// hit the DMARC wall that relaying "as" a personal gmail.com address does).
// Uses a plain REST call with a per-request Authorization header rather than
// the @sendgrid/mail SDK, which manages the API key as shared global state —
// unsafe once multiple organizations with different keys send concurrently.
export async function sendViaSendGrid(params: SendViaSendGridParams): Promise<SendViaSendGridResult> {
  const res = await fetch(SENDGRID_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: params.to }] }],
      from: { email: params.fromEmail },
      subject: params.subject,
      content: [
        { type: 'text/plain', value: params.text || '' },
        { type: 'text/html', value: params.html },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`SendGrid send failed: ${await res.text()}`);
  }

  return { providerMessageId: res.headers.get('x-message-id') || undefined };
}
