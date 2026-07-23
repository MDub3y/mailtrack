# MailTrack

Send a real email to anyone, and know when they open it.

MailTrack dispatches actual email — through a user's own connected Gmail account, or through a company's own SendGrid account for enterprise customers — and tracks opens with an invisible pixel embedded in the message. The sender's dashboard updates within a few seconds of the recipient opening it, no refresh needed.

---

## Features

### Send from your own Gmail account

Connect your Google account once (standard "Allow access" screen, same as any "Sign in with Google" button). From then on, emails you send through MailTrack are dispatched through the Gmail API using your own token — so they're genuinely from your address, land in your own Gmail Sent folder, and pass DKIM/SPF/DMARC properly. No SMTP setup, no app passwords.

### Open tracking

A unique 1×1 tracking pixel is embedded in every outgoing email. When the recipient opens it and their mail client loads images, the pixel fires and MailTrack records the first-open time, open count, and (best-effort) the recipient's IP/user-agent. The status on your Sent page flips from `sent` → `delivered` → `opened` automatically.

### Enterprise tier

Companies that already own a domain and a SendGrid account can onboard once — provide the SendGrid API key and a domain-authenticated From address — and every employee sends through that shared, properly-authenticated identity. No per-employee Gmail connection, no OAuth consent screens for staff, just join the organization and start sending.

### Bulk email

Send to a list of recipients in one go. A background queue (Redis + BullMQ) processes each recipient with automatic retries, so a large send doesn't block the app or die on one bad address. A live progress bar shows sent/failed counts as it works.

### PDF sharing

Upload a PDF, attach it to an email, and generate a share link — optionally password-protected and/or time-limited. Recipients open it in a built-in viewer, no account needed. View counts are tracked per document.

---

## How sending works

```
User composes an email
        │
        ▼
Does the sender belong to an Enterprise org?
        │                         │
       yes                        no
        │                         │
        ▼                         ▼
Send via the org's          Does the sender have
SendGrid account            Gmail connected?
(their own domain,                │
already authenticated)           yes → Send via Gmail API
                                   │    (genuinely from their
                                  no    own gmail.com address)
                                   │
                          Rejected — connect
                          Gmail or join an org
```

Either way, a tracking pixel is injected into the HTML before the message goes out, pointing back at MailTrack's own server. Nothing about tracking depends on which path sent the email.

---

## Engineering challenge: emails marked "opened" that were never opened

### The problem

During testing, the sender's dashboard was flipping to `opened` on emails that had not been touched by the recipient — sometimes within seconds of being sent. This is the failure mode that matters most for a product built entirely around trustworthy read receipts: an inaccurate "opened" is worse than a missing one, because it actively misleads the sender.

### Discovery and verification

Rather than assume the tracking pixel itself was broken, the actual event data was pulled from MongoDB for the affected messages and checked against the raw HTTP request log (IP, User-Agent, and elapsed time between delivery and the pixel hit). Two things stood out immediately:

- Every false "open" fired within roughly 3–40 seconds of the message being delivered — far too fast for a human to have noticed a notification, opened a mail client, and rendered the message.
- Some of those hits carried a `User-Agent` of `Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0` — a string that claims to be three different browsers at once. No real browser sends that; it's a synthetic fingerprint.

Cross-referencing this against how mail providers actually work confirmed the cause: Gmail (and every major provider) automatically prefetches and scans images embedded in new mail as part of its own phishing/malware defenses, *before* a human ever opens anything. That prescan is proxied through the same infrastructure (`ggpht.com` / `GoogleImageProxy`) that a genuine, human-triggered image load uses — so at the network level, a security scan and a real open are indistinguishable by design. Google intentionally masks which one triggered the request, for its own users' privacy.

This isn't a bug specific to this codebase. Every pixel-based tracking product — Mailtrack, HubSpot, Yesware — has some rate of exactly this false positive, for exactly this reason, and none of them can eliminate it. The honest engineering goal isn't "100% accurate," which isn't achievable by anyone building on this mechanism; it's minimizing false positives using the one signal the scanner can't hide.

### The fix

Since IP and proxy origin can't distinguish a scan from a real open, timing is the signal that's left. `routes/track.ts` now classifies each pixel hit before deciding whether it counts:

```typescript
const AUTOMATED_SCAN_GRACE_MS = 60_000;
const SCANNER_UA_PATTERN = /Edge\/12\.246/i;

function isLikelyAutomatedScan(userAgent: string, msSinceCreated: number): boolean {
  if (SCANNER_UA_PATTERN.test(userAgent)) return true;
  return msSinceCreated < AUTOMATED_SCAN_GRACE_MS;
}
```

A hit matching the known scanner fingerprint, or arriving within 60 seconds of delivery, is still recorded on the email's event timeline (for transparency and debugging) but does **not** advance `status`, `openCount`, or `firstOpenedAt`. Only what's left after that filter is surfaced to the sender as a real "Opened." The 60-second threshold came directly from the observed data — every confirmed false positive landed well under it — rather than an arbitrary guess.

Existing test data that had already been mismarked was reclassified with the same logic, and `EmailDetail.tsx` now shows a small note in the delivery timeline when scans were filtered out, instead of silently discarding them.

---

## Architecture

```
email/
├── docker-compose.yml           MongoDB 7 + Redis 7 (local dev)
├── server/                      Express + TypeScript
│   ├── uploads/                 PDF storage (UUID filenames)
│   └── src/
│       ├── models/
│       │   ├── User.ts          login/profile + Gmail OAuth tokens + organizationId
│       │   ├── Organization.ts  enterprise account: domain, SendGrid key, From address
│       │   ├── Email.ts         senderId, to, status, events[], trackingToken, openCount
│       │   ├── Document.ts      ownerId, originalName, storedName, viewCount, views[]
│       │   └── ShareToken.ts    token, documentId, passwordHash, expiresAt, accessCount
│       ├── services/
│       │   ├── gmailService.ts      OAuth flow, token refresh, Gmail API send
│       │   ├── sendgridService.ts   Enterprise SendGrid dispatch
│       │   ├── dispatchService.ts   picks Gmail vs SendGrid per sender
│       │   └── emailService.ts      tracking pixel injection
│       ├── queues/
│       │   └── emailQueue.ts    BullMQ queue + worker for single and bulk sends
│       ├── routes/
│       │   ├── auth.ts          register, login, me, Google OAuth connect/callback
│       │   ├── organizations.ts create / join / me
│       │   ├── emails.ts        send, send-bulk, sent, inbox, bulk-status
│       │   ├── track.ts         public tracking-pixel endpoint
│       │   ├── documents.ts     upload, list, share, revoke, delete
│       │   └── share.ts         public share-link access + PDF streaming
│       └── middleware/
│           └── auth.ts          JWT verify, attaches req.userId
│
└── client/                      React + Vite + TypeScript
    └── src/
        ├── context/AuthContext.tsx   JWT storage, rehydrate on refresh
        ├── pages/
        │   ├── Sent.tsx         outbox, live status, Gmail/Enterprise banner
        │   ├── Inbox.tsx        inbox for platform-to-platform mail
        │   ├── Organization.tsx enterprise onboarding / join
        │   ├── Documents.tsx    PDF list, upload, share management
        │   ├── BulkCompose.tsx  mass email with live progress
        │   └── ShareView.tsx    public share page — password gate + PDF viewer
        └── components/
            ├── EmailCompose.tsx  compose with autocomplete + PDF attachment
            ├── EmailDetail.tsx   email body, attachment cards, delivery timeline
            ├── PdfViewer.tsx     canvas-based pdf.js viewer (page nav, zoom)
            └── StatusBadge.tsx   sent / delivered / opened / failed
```

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Express |
| Database | MongoDB + Mongoose |
| Queue | Redis + BullMQ |
| Auth | JWT (7-day expiry) + Google OAuth 2.0 |
| Mail dispatch | Gmail API (personal) / SendGrid API (enterprise) |
| Frontend | React 19 + Vite + TypeScript |
| PDF viewer | pdfjs-dist (canvas rendering) |
| HTTP client | Axios |
| Forms | react-hook-form |
| Local infra | Docker (mongo:7, redis:7-alpine) |

---

## Running locally

**Prerequisites:** Node.js 18+, Docker, a Google Cloud OAuth client (Gmail API enabled), and a public HTTPS tunnel to your server (e.g. `cloudflared tunnel --url http://localhost:5000`) so the tracking pixel is reachable.

```bash
# 1. Start MongoDB and Redis
docker compose up -d

# 2. Server
cd server
cp .env.example .env   # fill in your Google OAuth client + tunnel URL
npm install
npm run dev            # http://localhost:5000

# 3. Client (new terminal)
cd client
npm install
npm run dev            # http://localhost:5173
```

### Environment (server/.env)

```
MONGODB_URI=mongodb://localhost:27017/emailservice
REDIS_URL=redis://localhost:6379
JWT_SECRET=change_this_in_production
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:5000/api/auth/google/callback
BASE_URL=https://your-tunnel-url             # public HTTPS, for the tracking pixel
PORT=5000
CLIENT_URL=http://localhost:5173
```

A note on the Google OAuth client: while it's in Google's "Testing" publishing status, only accounts you've explicitly added as test users (Google Cloud Console → OAuth consent screen → Test users) can connect. Moving to arbitrary users requires submitting the app for Google's verification review — a real external process, not a config change.

Enterprise customers don't need any of the Google setup — they just provide their own SendGrid API key and a domain-authenticated From address via the **Enterprise** page.

---

## Security

- Gmail OAuth tokens and SendGrid API keys are stored with `select: false` in MongoDB — never returned by any API response, only readable by server code that explicitly asks for them
- Share link passwords are bcrypt-hashed (cost 12) before storage
- PDF files are served via authenticated view tokens (JWT, 2-hour expiry) — direct file paths are never exposed
- File storage uses UUID filenames; path traversal is blocked server-side before any file read
- User search regex input is escaped before use in MongoDB `$regex` to prevent ReDoS
- Multer rejects non-PDF MIME types and enforces a 20 MB file size limit
- The tracking pixel endpoint always returns a valid image and never errors visibly, even if the token is unrecognized — a broken image would be a dead giveaway that tracking is happening
