import { IUser, User } from '../models/User';

const GOOGLE_AUTH_URL   = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GMAIL_SEND_URL    = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv('GOOGLE_CLIENT_ID'),
    redirect_uri: requireEnv('GOOGLE_REDIRECT_URI'),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

// Exchanges an OAuth authorization code for tokens. Shared by the send
// grant (here) and the read grant (inboxService), each with its own
// redirect URI so the two consents stay separate.
export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    code,
    client_id: requireEnv('GOOGLE_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${await tokenRes.text()}`);
  }
  const tokens = (await tokenRes.json()) as GoogleTokenResponse;
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token — revoke prior access at https://myaccount.google.com/permissions and try connecting again.');
  }
  return tokens;
}

export async function refreshGoogleToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    client_id: requireEnv('GOOGLE_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`Failed to refresh Google access token: ${await res.text()}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

// Best effort: tells Google the token is no longer wanted. A failure here
// never blocks removing the grant on our side.
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

// Exchanges the code, fetches the connected Gmail address, and stores
// everything on the platform User document (the send grant).
export async function connectGmailAccount(userId: string, code: string): Promise<string> {
  const tokens = await exchangeGoogleCode(code, requireEnv('GOOGLE_REDIRECT_URI'));

  const profileRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) {
    throw new Error(`Failed to fetch Google userinfo: ${await profileRes.text()}`);
  }
  const profile = (await profileRes.json()) as { email: string };

  await User.findByIdAndUpdate(userId, {
    googleAccessToken: tokens.access_token,
    googleRefreshToken: tokens.refresh_token,
    googleTokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
    gmailAddress: profile.email,
  });

  return profile.email;
}

async function refreshAccessToken(user: IUser): Promise<string> {
  const tokens = await refreshGoogleToken(user.googleRefreshToken!);
  user.googleAccessToken = tokens.access_token;
  user.googleTokenExpiry = new Date(Date.now() + tokens.expires_in * 1000);
  await user.save();
  return tokens.access_token;
}

async function getValidAccessToken(userId: string): Promise<{ accessToken: string; fromAddress: string }> {
  const user = await User.findById(userId).select('+googleAccessToken +googleRefreshToken +googleTokenExpiry');
  if (!user || !user.googleRefreshToken || !user.gmailAddress) {
    throw new Error('Gmail is not connected for this account. Connect Gmail before sending.');
  }

  const isExpired = !user.googleTokenExpiry || user.googleTokenExpiry.getTime() < Date.now() + 60_000;
  const accessToken = isExpired ? await refreshAccessToken(user) : user.googleAccessToken!;

  return { accessToken, fromAddress: user.gmailAddress };
}

function encodeHeaderWord(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf-8').toString('base64')}?=`;
}

// RFC 2045 §6.8 requires base64 body content to be wrapped at 76 characters
// per line. An unwrapped single-line body is non-conformant and a plausible
// spam-filter signal even from a genuinely authenticated Gmail sender.
function wrapBase64Body(base64: string): string {
  return base64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Defense in depth: a raw From/To header is interpolated directly below —
// if either contained a CR/LF, an attacker could inject extra headers
// (e.g. a hidden Bcc) into the outgoing message. Callers already validate
// recipient addresses, but this is the actual dangerous sink, so it's
// checked again here regardless of what the caller did.
function assertNoHeaderInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid ${field}: contains a line break`);
  }
}

// The Message-ID we set carries the tracking token, so a reply's In-Reply-To
// or References header identifies the tracked email with no API call.
export function rfcMessageIdFor(trackingToken: string, fromAddress: string): string {
  const domain = fromAddress.split('@')[1] || 'mailtrack.local';
  return `<mt-${trackingToken}@${domain}>`;
}

export function buildMimeMessage(params: { from: string; to: string; subject: string; html: string; text: string; trackingToken?: string }): string {
  assertNoHeaderInjection(params.from, 'from');
  assertNoHeaderInjection(params.to, 'to');

  const boundary = `mtb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const lines = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${encodeHeaderWord(params.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    ...(params.trackingToken ? [`Message-ID: ${rfcMessageIdFor(params.trackingToken, params.from)}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64Body(Buffer.from(params.text || '', 'utf-8').toString('base64')),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64Body(Buffer.from(params.html || '', 'utf-8').toString('base64')),
    '',
    `--${boundary}--`,
  ];
  return lines.join('\r\n');
}

export interface SendViaGmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
  trackingToken?: string;
}

export interface SendViaGmailResult {
  providerMessageId?: string;
  providerThreadId?: string;   // Gmail threadId: replies land in the same thread
  rfcMessageId?: string;       // the Message-ID header we set
}

// Sends a real email through the sending user's own Gmail account via the
// Gmail API — the message is genuinely from their gmail.com address, so it
// passes SPF/DKIM/DMARC alignment (unlike relaying through a third-party ESP).
export async function sendViaGmail(userId: string, params: SendViaGmailParams): Promise<SendViaGmailResult> {
  const { accessToken, fromAddress } = await getValidAccessToken(userId);

  const raw = base64UrlEncode(buildMimeMessage({
    from: fromAddress,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    trackingToken: params.trackingToken,
  }));

  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) {
    throw new Error(`Gmail send failed: ${await res.text()}`);
  }

  const result = (await res.json()) as { id?: string; threadId?: string };
  return {
    providerMessageId: result.id,
    providerThreadId: result.threadId,
    rfcMessageId: params.trackingToken ? rfcMessageIdFor(params.trackingToken, fromAddress) : undefined,
  };
}
