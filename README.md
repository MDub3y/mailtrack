# MailTrack

An internal email platform with delivery tracking, open receipts, PDF document sharing, and bulk sending. When a recipient opens an email, the sender's UI updates automatically — no refresh, no polling workaround, no external service.

---

## The Alpha

Every email client (Gmail, Outlook) can tell you an email was *delivered* to a server. None of them tell the sender when the recipient actually *read* it — at least not natively, not in real time, and not without the recipient's email provider stripping the signal.

MailTrack owns the full stack — sender, delivery, inbox, and the read event — so it closes that loop precisely:

- **`sent`** — message written to the database
- **`delivered`** — confirmed immediately (no SMTP hop, no bounce risk)
- **`opened`** — fires the instant the recipient clicks the email in their inbox

The status change on the sender's screen happens within 4 seconds of the recipient opening the message, with no action required from either party.

---

## Features

### Email Tracking

When the recipient opens an email in their inbox, the `EmailDetail` component mounts and immediately calls `PATCH /api/emails/:id/open`. The backend marks the email `opened` and appends an event with a timestamp. The sender's Sent page polls every 4 seconds and picks up the change. The status badge updates without any user interaction.

```
Recipient opens email
  → EmailDetail mounts
  → PATCH /api/emails/:id/open  (only the authenticated recipient can call this)
  → Email.status = "opened", event pushed
  → Sender's 4s poll catches the change
  → Badge: delivered → opened
```

The `PATCH` endpoint is guarded: it checks that `req.userId === email.recipientId`. A sender cannot mark their own email as opened.

The Sent page runs two mechanisms in parallel:

1. `setInterval` every 4 seconds — silent background fetch, compares previous status map, fires a toast if any email upgraded
2. `visibilitychange` listener — fires an immediate fetch when the user switches back to the tab (Chrome throttles `setInterval` to ~60s in background tabs)

### Mass Emailing

Send to multiple recipients in a single operation. The backend uses a **Redis + BullMQ** queue so large sends process in a background worker without blocking the HTTP server.

```
POST /api/emails/send-bulk  → { jobId }
GET  /api/emails/bulk-status/:jobId → { state, progress, result: { sent, failed, errors } }
```

The UI shows a live progress bar while the worker processes each recipient. Results include a per-address breakdown of successes and failures.

### PDF Document Tracking

Upload PDF files to the platform (up to 20 MB). Each document tracks how many times it has been viewed and by whom.

- Documents are stored on the server with UUID filenames (original names preserved in metadata)
- View counts and per-view records (timestamp, IP) are stored in MongoDB
- Documents can be attached to emails directly from the compose window

```
POST /api/documents/upload   → upload PDF, get documentId
GET  /api/documents          → list own documents with view counts
```

### Secure Document Sharing

Each document can have one or more share links. Share links support:

- **Password protection** — bcrypt-hashed, validated server-side before a view token is issued
- **Expiry** — share links expire at a set time; expired links return 410
- **Revocation** — any share link can be deleted without affecting the document

```
POST /api/documents/:id/share  → { shareUrl, token, requiresPassword, expiresAt }
GET  /api/share/:token         → { documentName, requiresPassword, expiresAt, accessCount }
POST /api/share/:token/access  → validate password → return { viewToken }
GET  /api/share/:token/file?vt=<viewToken>  → stream PDF
```

The share URL (`/share/:token`) is a public page — no account required. After password validation, the server issues a short-lived JWT (2-hour expiry) scoped to that specific share. The PDF is rendered in-browser using a canvas-based pdf.js viewer with page navigation and zoom controls.

---

## Architecture

```
email/
├── docker-compose.yml           MongoDB 7 + Redis 7 (local dev)
├── server/                      Express + TypeScript
│   ├── uploads/                 PDF storage (UUID filenames)
│   └── src/
│       ├── models/
│       │   ├── User.ts          name, email (login), password, emailAddress
│       │   ├── Email.ts         senderId, recipientId, status, events[], attachments[]
│       │   ├── Document.ts      ownerId, originalName, storedName, viewCount, views[]
│       │   └── ShareToken.ts    token, documentId, passwordHash, expiresAt, accessCount
│       ├── queues/
│       │   └── emailQueue.ts    BullMQ queue + worker for bulk sending
│       ├── routes/
│       │   ├── auth.ts          POST /register, POST /login, GET /me
│       │   ├── emails.ts        POST /send, GET /sent, GET /inbox, GET /:id, PATCH /:id/open
│       │   │                    POST /send-bulk, GET /bulk-status/:jobId
│       │   │                    GET /users/search?q=
│       │   ├── documents.ts     POST /upload, GET /, POST /:id/share, GET /:id/shares
│       │   │                    DELETE /:id/shares/:tokenId, DELETE /:id
│       │   └── share.ts         GET /:token, POST /:token/access, GET /:token/file
│       └── middleware/
│           └── auth.ts          JWT verify, attaches req.userId
│
└── client/                      React + Vite + TypeScript
    └── src/
        ├── context/
        │   └── AuthContext.tsx  JWT storage, rehydrate on refresh
        ├── pages/
        │   ├── Sent.tsx         outbox + 4s polling + visibilitychange + toast
        │   ├── Inbox.tsx        inbox + 4s polling
        │   ├── Documents.tsx    PDF list, upload, share management
        │   ├── BulkCompose.tsx  mass email with live progress
        │   └── ShareView.tsx    public share page — password gate + PDF viewer
        └── components/
            ├── EmailCompose.tsx  compose with autocomplete + PDF attachment
            ├── EmailDetail.tsx   email body, attachment cards, delivery timeline
            ├── PdfViewer.tsx     canvas-based pdf.js viewer (page nav, zoom)
            └── StatusBadge.tsx   sent / delivered / opened
```

### Data Model

```typescript
// One document per message — both parties query the same record
Email {
  senderId:    ObjectId   // index: { senderId, createdAt }
  recipientId: ObjectId   // index: { recipientId, createdAt }
  from, to, subject, htmlBody, textBody: string
  status:      "sent" | "delivered" | "opened"
  events:      [{ type, timestamp }]
  attachments: [{ documentId, name, shareUrl }]
  createdAt:   Date
}

Document {
  ownerId:      ObjectId
  originalName: string
  storedName:   string   // UUID-based, never exposed to users
  size:         number
  viewCount:    number
  views:        [{ viewedAt, ip }]
}

ShareToken {
  token:        string   // UUID, unique
  documentId:   ObjectId
  passwordHash: string?  // bcrypt
  expiresAt:    Date?
  accessCount:  number
}
```

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Express |
| Database | MongoDB + Mongoose |
| Queue | Redis + BullMQ |
| Auth | JWT (7-day expiry) |
| Frontend | React 19 + Vite + TypeScript |
| PDF viewer | pdfjs-dist (canvas rendering) |
| HTTP client | Axios |
| Forms | react-hook-form |
| Local infra | Docker (mongo:7, redis:7-alpine) |

No external email provider. No WebSockets.

---

## Running Locally

**Prerequisites:** Node.js 18+, Docker

```bash
# 1. Start MongoDB and Redis
docker compose up -d

# 2. Server
cd server
cp .env.example .env   # defaults work out of the box
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
PORT=5000
CLIENT_URL=http://localhost:5173
```

No external credentials required.

---

## Demo

### Email read receipts

Register two accounts. Open the app in two browser windows (use incognito for the second).

1. Sender composes → types recipient's platform address (autocomplete suggests registered users) → Send
2. Recipient's inbox shows the email within 4 seconds
3. Recipient opens the email
4. Sender's sent list flips from `delivered` → `opened` within 4 seconds

### Document sharing

1. Go to **Documents** → upload a PDF
2. Click **Share** → optionally set a password and expiry → Copy the share URL
3. Open the share URL in a private window — enter password if set → PDF renders in browser
4. Back in Documents, the view count increments

### Mass email

1. Go to **Mass Email** → paste multiple addresses (one per line)
2. Write subject and body → Send
3. Progress bar updates in real time as the background worker processes each recipient

---

## Security

- Share link passwords are bcrypt-hashed (cost 12) before storage — the plaintext is never stored
- PDF files are served via authenticated view tokens (JWT, 2-hour expiry) — direct file paths are never exposed
- File storage uses UUID filenames; path traversal is blocked server-side before any file read
- The recipient-open endpoint verifies `recipientId === req.userId` — senders cannot self-mark
- User search regex input is escaped before use in MongoDB `$regex` to prevent ReDoS
- Multer rejects non-PDF MIME types and enforces a 20 MB file size limit

## Users
All platform users (9 total):                                                                                                                             
  ┌─────────────┬──────────────────────┬─────────────────────┬─────────────┐    │    Name     │        Login         │  Platform Address   │  Password   │  
  ├─────────────┼──────────────────────┼─────────────────────┼─────────────┤
  │ Test User   │ test@test.com        │ test@yourdomain.com │ password123 │  
  ├─────────────┼──────────────────────┼─────────────────────┼─────────────┤  
  │ Bob         │ bob@test.com         │ bob@mailtrack.local │ password123 │  
  │ Recipient   │                      │                     │             │  
  ├─────────────┼──────────────────────┼─────────────────────┼─────────────┤  
  │ Alice Chen  │ alice@mailtrack.dev  │ alice@mailtrack.io  │ password123 │  
  ├─────────────┼──────────────────────┼─────────────────────┼─────────────┤  
  │ Marcus Webb │ marcus@mailtrack.dev │ marcus@mailtrack.io │ password123 │  
  ├─────────────┼──────────────────────┼─────────────────────┼─────────────┤  
  │ Priya       │ priya@mailtrack.dev  │ priya@mailtrack.io  │ password123 │  
  │ Sharma      │                      │                     │             │  
  ├─────────────┼──────────────────────┼─────────────────────┼─────────────┤  
  │ James       │ james@mailtrack.dev  │ james@mailtrack.io  │ password123 │  
  │ Okafor      │                      │                     │             │  
  ├─────────────┼──────────────────────┼─────────────────────┼─────────────┤  
  │ Sofia Reyes │ sofia@mailtrack.dev  │ sofia@mailtrack.io  │ password123 │  
  ├─────────────┼──────────────────────┼─────────────────────┼─────────────┤  
  │ Liam        │ liam@mailtrack.dev   │ liam@mailtrack.io   │ password123 │  
  │ Nakamura    │                      │                     │             │  
  ├─────────────┼──────────────────────┼─────────────────────┼─────────────┤  
  │ Anya        │ anya@mailtrack.dev   │ anya@mailtrack.io   │ password123 │  
  │ Petrova     │                      │                     │             │  
  └─────────────┴──────────────────────┴─────────────────────┴─────────────┘  
