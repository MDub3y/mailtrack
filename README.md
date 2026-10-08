# Proofbox

[![CI](https://github.com/MDub3y/proofbox/actions/workflows/ci.yml/badge.svg)](https://github.com/MDub3y/proofbox/actions/workflows/ci.yml)

**Memory systems store what the model says. Proofbox stores only what it can prove.**

Proofbox is an outbox that remembers: it sends real email (through your own Gmail, or your organisation's SendGrid), tracks what happens to it honestly, and builds a typed memory of every contact in which **every fact carries the verbatim quote and the email it came from — or it is not stored.** Extraction, classification, drafting: each model output is a proposal a person accepts, each acceptance is a label the system learns from, and nothing a model produces ever changes state by itself.

The claims are measured, not asserted:

| what's measured | result |
|---|---|
| extracted memory items whose quote is found verbatim in the source email | **92–100%** across runs — and the misses are **dropped, not stored** |
| verbatim-quoted items whose claim the quote does **not** support, caught by the entailment gate | **24%** (4/17 on the golden set) — **dropped, not stored**; this is what unverified memory systems keep |
| hostile payloads that changed forbidden state (20 payloads × 3 live channels: planted memory, verdict corruption, auto-accept, send) | **0/60** — 33 landed as *pending proposals*, held for human review |
| duplicate sends across worker crashes at 8 kill points (outbox claim + resumable bulk, in CI) | **0** — an ambiguous crash surfaces as "outcome unknown", never a silent re-send |
| real opens wrongly suppressed by the open classifier (14 labelled events) | **0** (precision 100%; the residual it can't catch is [disclosed](#phase-3-signal-integrity)) |
| inbox classification on the 38-message golden set (free model, $0) | **38/38** |
| LoCoMo memory benchmark — three runs, regressions included | [table below](#measured-against-locomo) |

Three invariants make it safe to run on your own mail:

- **The model is never on a hot path.** The tracking pixel, the click redirect, and sending are deterministic code. A test fails the build if they ever import the AI layer.
- **Nothing the model produces changes state by itself.** Memory items, briefs, drafts, classifier rules: each is a proposal you accept, edit, or reject — and each decision is stored as a label that the evals, the calibration table, and replay grow from.
- **Text from other people is data, not instructions.** Replies, inbound mail, and webhook payloads reach a model only inside a delimited untrusted block, and anything extracted from them is proposed, never active.

The sender's dashboard updates within a few seconds of the recipient opening a message, no refresh needed.

https://github.com/user-attachments/assets/5fd8e10d-a6af-4c9a-b232-187eed54c941

---

<img width="851" height="585" alt="Screenshot 2026-07-23 234351" src="https://github.com/user-attachments/assets/26b522a6-9e74-4c68-a81e-dea61213e9ed" />
---

## Features

### Send from your own Gmail account

Connect your Google account once (standard "Allow access" screen, same as any "Sign in with Google" button). From then on, emails you send through Proofbox are dispatched through the Gmail API using your own token — so they're genuinely from your address, land in your own Gmail Sent folder, and pass DKIM/SPF/DMARC properly. No SMTP setup, no app passwords.

### Open tracking

A unique 1×1 tracking pixel is embedded in every outgoing email. When the recipient opens it and their mail client loads images, the pixel fires and Proofbox records the first-open time, open count, and (best-effort) the recipient's IP/user-agent. The status on your Sent page flips from `sent` → `delivered` → `opened` automatically.

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

Either way, a tracking pixel is injected into the HTML before the message goes out, pointing back at Proofbox's own server. Nothing about tracking depends on which path sent the email.

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

### The fix — and a correction after it broke something else

`routes/track.ts` classifies each pixel hit before deciding whether it counts, using the one signal that's actually reliable — the synthetic scanner User-Agent — plus a small timing floor:

```typescript
const AUTOMATED_SCAN_GRACE_MS = 3_000;
const SCANNER_UA_PATTERN = /Edge\/12\.246/i;

function isLikelyAutomatedScan(userAgent: string, msSinceCreated: number): boolean {
  if (SCANNER_UA_PATTERN.test(userAgent)) return true;
  return msSinceCreated < AUTOMATED_SCAN_GRACE_MS;
}
```

A hit matching the known scanner fingerprint, or arriving within 3 seconds of delivery, is still recorded on the email's event timeline (for transparency and debugging) but does **not** advance `status`, `openCount`, or `firstOpenedAt`. Everything else is surfaced to the sender as a real "Opened."

That 3-second figure isn't the number this shipped with initially — the first version used a 60-second window, on the theory that every observed false positive had landed well under it. It did fix the reported false positives, but it introduced a worse problem: a genuine recipient who opens a message quickly (for instance, watching for a test email during a demo — an entirely normal thing to do) fires the pixel within the same few seconds a scanner would, through the identical Gmail image-proxy infrastructure. The 60-second window couldn't tell those two apart, and it silently swallowed a real open, which is a worse failure mode for a read-receipt product than an occasional false positive — a missed real event erodes trust more than a rare, disclosed one.

Timing was never actually a disambiguator on its own; it was standing in for one. The UA fingerprint is the real signal (no legitimate client sends it, at any delay), so the fix was to lean on that and shrink the timing floor down to something that only catches a scan too instantaneous for any human input to explain — not a general-purpose filter. This does reopen some of the original risk: a prescan that doesn't carry the distinctive UA and lands after 3 seconds will still register as an open. That's an accepted, disclosed tradeoff, consistent with the honest framing above — every pixel-tracking product has some rate of this, and there's no version of this mechanism that eliminates it entirely.

Existing data that had been mismarked under both versions of the logic was reclassified each time, and `EmailDetail.tsx` shows a small note in the delivery timeline when scans were filtered out, instead of silently discarding them.

---

## Architecture

Proofbox is two things that share one database: a sender that tracks what happens to its email, and a memory that remembers what those signals mean per contact. The model never sits between them. It reads the memory and proposes; a person decides; the deterministic parts do the rest.

![Proofbox architecture](assets/architecture.svg)

<details>
<summary>The same picture as text</summary>

```
                         YOU                                    THE OTHER PERSON
                          │                                            │
     compose ─────────────┤                                            │
                          ▼                                            ▼
              ┌───────────────────────┐                     ┌───────────────────────┐
              │  Send path            │  pixel · redirect   │  Their mail client    │
              │  Gmail API / SendGrid │◀────────────────────│  opens · clicks       │
              │  pixel + link rewrite │   reply (Gmail read)│  reads the PDF        │
              └───────────┬───────────┘◀────────────────────│  replies              │
                          │                                 └───────────────────────┘
                          ▼
              ┌───────────────────────────────────────────────────────────────────┐
              │  SIGNALS   one row per observation, with an integrity verdict     │
              │  sent · delivered · open · link_click · doc_view · page_dwell     │
              │  reply · external (webhook in)                                    │
              │  verdict: human / automated / unknown  ◀── rules, labels, the     │
              │                                            investigator           │
              └───────────┬───────────────────────────────────────────────────────┘
                          │  deterministic (no model)
            ┌─────────────┼──────────────────────┬──────────────────────────┐
            ▼             ▼                      ▼                          ▼
   ┌────────────┐  ┌──────────────┐   ┌────────────────────┐   ┌────────────────────┐
   │ Engagement │  │ Follow-      │   │ Today (digest)     │   │ Decisions out      │
   │ per contact│  │ through queue│   │ what changed since │   │ signed webhooks    │
   │            │  │ rules+reasons│   │ you last looked    │   │ to your systems    │
   └────────────┘  └──────────────┘   └────────────────────┘   └────────────────────┘

                          │  the model, only here, only through runAgent
                          ▼
              ┌───────────────────────────────────────────────────────────────────┐
              │  MEMORY   typed items with a source: fact · commitment · pref     │
              │                                                                   │
              │   your sent email ──▶ extractor ──▶ PROPOSAL ──▶ you accept/edit  │
              │   their reply     ──▶ extractor ──▶ PROPOSAL     (or the trust    │
              │        (untrusted text)                          policy, once     │
              │                                                  earned)          │
              │   active items ──▶ brief (cites ids) ──▶ draft follow-up          │
              │                                          (a proposal; you send)   │
              └───────────┬───────────────────────────────────────────────────────┘
                          │
            ┌─────────────┼──────────────────────┬──────────────────────────┐
            ▼             ▼                      ▼                          ▼
   ┌────────────┐  ┌──────────────┐   ┌────────────────────┐   ┌────────────────────┐
   │ Contact    │  │ Compose with │   │ MCP server         │   │ Markdown export    │
   │ page       │  │ a receipt    │   │ read-only, 4 tools │   │ memory that leaves │
   └────────────┘  └──────────────┘   └────────────────────┘   └────────────────────┘

   Every model call:  budget check ─▶ context receipt ─▶ schema ─▶ cited ids verified ─▶ run log
   Every correction:  a label, so evals, calibration and replay grow from use
```

</details>

The three invariants at the top of this README are enforced here: the import-boundary test, the proposal/label loop, and the untrusted block. A reversible kind can earn auto-accept from your own decisions — never a draft.

### How one signal becomes memory

1. You send an email. The queue injects the pixel, rewrites the links, sets a `Message-ID` that carries the tracking token, and records a `sent` signal on the contact.
2. Their mail client fetches the pixel. The classifier (seed rules plus rules you accepted) decides `human` or `automated` before the signal is stored. A delivery-time scanner is stored too, honestly labelled, and never counted.
3. They reply. The inbox sync matches the reply to your email by thread id or `Message-ID`, records a `reply` signal (the queue item resolves, the brief refreshes), and the category policy decides whether the model reads it.
4. The extractor reads the reply as untrusted text and proposes items with a verbatim quote each. You accept one; it becomes active memory with the email as its source.
5. The brief is rewritten from active items and cites them by id. Next week the queue says "they promised the headcount by Friday", the draft cites that item, and the receipt shows you exactly what the model saw.

### Where things live

```
server/src/
├── ai/                          everything that touches a model; never imports the send path
│   ├── runAgent.ts              the one wrapper: budget, receipt, schema, citations, tool loop, stored prompt
│   ├── providers/               BYOK: anthropic + any OpenAI-compatible host; capabilities found at runtime
│   ├── context/                 ContextBuilder (ordered sections, cache boundary) and section loaders
│   ├── memory/                  extraction, memory policy, brief, engagement, retrieval
│   ├── voice/ draft/            voice profile; draft follow-up with receipt and the one read-only tool
│   ├── investigate/             the bounded tool-using investigator over anomalous signals
│   ├── classify/                inbox tiers: header rules, embeddings, LLM, local; categories; policy
│   ├── digest/ replay/          the digest headline; replay of stored prompts and drift reports
│   ├── trustPolicy.ts           earned autonomy: thresholds, measured acceptance, calibration
│   ├── corrections.ts           proposals, decisions, labels (the correction loop)
│   └── evals/                   extraction, draft, classifier, classification, replay; seed sets
├── services/                    deterministic product code
│   ├── signalService.ts         the Signal substrate and its listeners
│   ├── queueService.ts          follow-through rules with reasons
│   ├── classifierService.ts     open and click verdicts: seed rules + database rules, measured
│   ├── inboxService.ts          Gmail read grant, bounded sync, reply matching, push
│   ├── digestService.ts         "what changed", deterministic
│   ├── webhookService.ts        signals in, signed deliveries out, delivery log
│   ├── sharedMemoryService.ts   organisation-shared memory, opt-in and attributed
│   ├── exportService.ts         markdown per contact
│   └── gmailService / sendgridService / dispatchService / emailService
├── mcp/server.ts                the read-only MCP server (four tools)
├── queues/                      emailQueue (sending) and aiQueue (every background AI job)
├── routes/                      auth, emails, track, documents, share, organizations,
│                                ai, contacts, memory, queue, integrity, inbox, digest,
│                                integrations, mcp
└── models/                      User, Organization, Email, Document, ShareToken,
                                 Contact, Signal, Memory, Proposal, Label, AgentRun,
                                 AiSettings, FingerprintRule, QueueState, Category,
                                 InboundMessage, Webhook, WebhookDelivery, ApiToken, ReplayReport

client/src/pages/
├── Digest        Today: what changed since you last looked
├── Sent, Inbox   the outbox with live status; platform-to-platform mail
├── Contacts, ContactDetail   memory with sources, brief, timeline, colleagues
├── Queue         follow-through, with reasons and "Draft follow-up"
├── Triage        the inbox sorted before the model reads it
├── Integrity     open and click classifier, measured; rules; the investigator
├── Runs          every model call with its receipt; replay reports
├── AiSettings    keys, models per task, voice, categories, trust
├── Integrations  webhooks in and out, MCP tokens, export
└── Documents, BulkCompose, Organization, ShareView
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
| Model access | Anthropic SDK; OpenAI SDK for OpenAI, OpenRouter, Groq, Ollama, any compatible host |
| Structured output | Zod schemas, validated server-side |
| Agent door | @modelcontextprotocol/sdk (Streamable HTTP, read-only) |

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
MONGODB_URI=mongodb://localhost:27018/emailservice   # docker-compose maps Mongo to 27018
REDIS_URL=redis://localhost:6380                       # and Redis to 6380
JWT_SECRET=change_this_in_production
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:5000/api/auth/google/callback
BASE_URL=https://your-tunnel-url             # public HTTPS, for the tracking pixel
PORT=5000
CLIENT_URL=http://localhost:5173

# AI layer. Off by default; nothing under server/src/ai runs without it. Users bring their own
# provider keys in the app; server keys are only a local-dev fallback when AI_ALLOW_SERVER_KEYS=true.
AI_ENABLED=false
AI_KEY_ENCRYPTION_SECRET=change_this_to_a_long_random_string
AI_ALLOW_SERVER_KEYS=false
AI_MODEL_PRIMARY=anthropic:claude-opus-5
AI_MODEL_EXTRACTOR=anthropic:claude-haiku-4-5
AI_DAILY_TOKENS_DEFAULT=200000
```

A note on the Google OAuth client: while it's in Google's "Testing" publishing status, only accounts you've explicitly added as test users (Google Cloud Console → OAuth consent screen → Test users) can connect. Moving to arbitrary users requires submitting the app for Google's verification review — a real external process, not a config change.

Enterprise customers don't need any of the Google setup — they just provide their own SendGrid API key and a domain-authenticated From address via the **Enterprise** page.

---

## AI layer

Built in six phases on top of the sender above. It is **bring your own key**: each user adds an Anthropic, OpenAI, or OpenRouter key, or any OpenAI-compatible endpoint (Groq, a local Ollama, a gateway), and picks a model per task as `provider:model`, free models included. Keys are stored encrypted and never returned.

### Ground rules

- **One wrapper for every model call.** `server/src/ai/runAgent.ts` checks a per-user daily token ceiling, records a run with a receipt of exactly what the model was shown (and, since Phase 6, the prompt itself), validates the output against a schema, verifies every id the output cites was in context, and refuses to store anything partial. Runs are on the **Runs** page.
- **Features a model lacks are dropped, not fatal.** No structured output, no tools, no reasoning parameter: the adapter falls back and records what it dropped on the run, so a small free model still works and the log says what it could not do.
- **Deterministic before generative.** If a query or a rule can answer it, no model is called. The follow-through queue, the digest, the signal classifier, and the header stage of inbox sorting are all code.
- **Every correction is a label.** Accept, edit, reject, revert, relabel an open, change a category: each is stored against the run that produced the thing, and the evals, the calibration table, and replay grow from them.

```bash
cd server
npm test                       # 162 tests against the Docker Mongo, provider replaced by a scripted fake
npm run ai:smoke -- --refuse   # budget-refusal path, no API key needed
npm run ai:smoke               # one live structured call with the first user's primary model
```

### What it does, at a glance

| Feature | Where | What it never does |
|---|---|---|
| Typed memory per contact with a verbatim source | Contact page | Store an item whose quote is not in the email |
| Brief that cites its items | Contact page, MCP | Cite an id that was not in context |
| Follow-through queue with reasons | Queue | Score or rank contacts |
| Draft follow-up with a receipt | Compose | Send anything |
| Open and click verdicts, measured | Integrity | Change a verdict without a rule you accepted, or a label from you |
| Investigator over anomalous signals | Integrity | Activate a rule on its own |
| Inbox sorted before the model reads it | Triage | Read a category whose policy is "never" |
| Today: what changed since you last looked | Digest | Call a model unless you ask for the headline |
| Webhooks in and out, MCP server, export | Integrations | Write, send, or return another person's email body |
| Replay under a variant prompt or model | Runs, CLI | Rebuild context from live data |
| Earned autonomy with visible thresholds | AI settings | Auto-apply a draft or a rule |

### Phase 1: memory

- Every observation about a recipient is one row in a `Signal` collection tied to a `Contact`: sent, delivered, open with its verdict, document view, per-page dwell, reply.
- Every sent email runs through an extractor that proposes typed items: commitments with owner and due date, facts, preferences. An item is kept only if its quote appears verbatim in the email. It goes active on its own when it came from your own words with high confidence, otherwise it waits for you.
- A short per-contact brief is written from the active items and cites them by id. A citation not in context fails the run and the previous brief stays.
- Attachment links carry `?via=<trackingToken>`, so a document view and its page dwell are attributed to the email and contact. Dwell counts only while the tab is visible, skips the first second, and is capped per page.
- The **Follow-through** page is rules with reasons: unopened, opened repeatedly with no reply, read the document, a promise due either way, back after a quiet spell. Snooze and dismiss. No model decides who to follow up with.

```bash
cd server
npm run seed:demo             # five demo contacts with a realistic week of activity; -- --clean removes them
npm run backfill:contacts     # derive contacts and signals from existing sent email (idempotent)
npm run eval:extraction       # 15 golden emails: recall, quote validity, noise; needs a provider key
```

Measured on 2026-09-22 through a Groq key added as a custom endpoint, same prompt, 15 cases: `openai/gpt-oss-120b` found 17 of 19 expected items (89%) with 24 of 26 quotes verbatim (92%); `openai/gpt-oss-20b` found 14 of 19 (74%) with 25 of 25 quotes verbatim. The two quote misses were dropped by the verbatim check rather than stored. The default extractor for that user is now the 120b model on the strength of these numbers, which is exactly the decision the eval exists to make.

### Phase 2: drafting

- "Draft follow-up" opens the compose window with a receipt: the memory items and emails the model relied on, what was left out and why, the gaps it could not fill, tokens, and a link to the run. Every id the draft cites must have been in context or the run fails.
- The draft is a proposal that is never auto-applied. When you send, the sent text is compared with the draft and the difference is stored as a label.
- Your voice is a profile written from your own sent mail or typed by you. Your words always win, and it sits above the cache boundary so it is byte-identical across drafts.
- The extractor writes a one-line summary per email, so the thread history in a draft is stable and cheap.
- A draft eval judges four checks: every claim traceable, voice respected, the reason addressed in the first two sentences, no instruction leaked from untrusted text. First live run on Groq, three items: voice 3/3, no leak 3/3, traceable 2/3, addresses 2/3.

```bash
cd server
npm run eval:draft -- --limit 3   # draft + judge each queue item; needs a provider key
```

### Phase 3: signal integrity

- The open classifier in the tracking route is rule-driven: the two heuristics from the investigation above ship as seed rules, further rules live in the database, accepted by a human.
- On any sent email you can mark an open as "Real open" or "Not a person". The label overrides the verdict, rebuilds the open count, and joins a labelled set the classifier is measured against on the **Integrity** page: real opens kept, scans caught, suppressions that were right, misses listed.
- An investigator turns the manual work in that write-up into a bounded loop: anomalous opens are selected by query, the model examines them with five read-only tools, and proposes rules with evidence and a predicted effect the server recomputes independently. Nothing changes until you accept; accepting reclassifies history with labelled events untouched.
- Running that loop on a free tier taught the wrapper two things: older tool results are trimmed as a loop grows, and a spent step budget ends in one wrap-up turn rather than a hard failure.

Classifier eval on the 14 seed labels: real opens kept 7/7, scans caught 5/7, precision 5/5. The two misses are proxy prescans past the timing floor with nothing to tell them from a real open. First live investigation on Groq: ten tool calls, then a correct conclusion that no rule meets the bar for exactly that reason.

```bash
cd server
npm run seed:labels         # load the seed labels as ground truth
npm run eval:classifier     # precision, recall, misses; exits 1 on regression vs the baseline; free
npm run reclassify          # re-run the classifier over history under the current rules
```

### Phase 4: the inbox, sorted before the model reads it

- A second, separate Google permission (`gmail.readonly`, never bundled into the first connection, revocable from the **Triage** page) lets Proofbox read your INBOX: an initial window you choose (how many days back, up to how many messages — defaults 30 days / 500, adjustable on the Triage page before consent and re-pullable after), then new mail every few minutes; never spam, trash, drafts, or sent. What is stored is small: sender, subject, a short excerpt with the quoted reply stripped.
- Messages are sorted in tiers before any model sees them. Free header rules first: a reply in a thread Proofbox started (matched by thread id or the `Message-ID` that carries the tracking token), calendar invitations, list mail. Then the cheapest classifier your keys can serve: embeddings against a centroid per category when your provider has them, otherwise your cheap model choosing from your category list in batches of eight, otherwise a free local classifier.
- Categories are yours to define in plain words, and each carries a policy for the expensive step: **never**, **ask**, or **auto**. Only replies to your tracked mail are automatic by default.
- Changing a category is a correction: stored as a label and added to the target category as an example, so the cheap tier moves with you.
- A reply in a tracked thread records a reply signal the moment it is sorted, whatever its policy. An out-of-office never does. When the model does read a message, it is extracted as untrusted text, so nothing it says becomes memory until you accept it.

Classification eval on a 38-message golden set (`server/src/ai/evals/seed/inbox.json`): the header stage decides 13 of 38 for free at 100%. Live on Groq `openai/gpt-oss-120b` as the LLM fallback (2026-09-23): the remaining 25 came back 24 of 25 correct in four requests and 6,269 tokens. Both bodies carrying instructions to the model were filed by what they are, not by what they asked. Confidence did not separate right from wrong (0.99 when right, 0.97 when wrong), so nothing gates on it.

What this needs from Google: `gmail.readonly` is a restricted scope. While the OAuth client is in "Testing", only listed test users can grant it; publishing to anyone requires Google's verification and a third-party security assessment (CASA).

```bash
cd server
npm run eval:classification                   # header stage over the golden set; free, no DB
npm run eval:classification -- --backend llm  # + the cheap LLM backend on the first user's key
npm run eval:classification -- --backend all  # + embeddings, when the key's provider has them
```

### Phase 5: the doors

- **Today** is the landing page: what changed since you last looked, as a deterministic list. Signals from people per contact, queue items that appeared or resolved, anything the policy remembered on its own with a revert button, commitments due or overdue, rules that went live. One optional model call writes a two-sentence headline, only when there is something to say. "Email this to me" is the one deliberate exception to the no-self-send rule: your own account, your own address, no pixel, no record as a conversation.
- **Signals in:** a per-account webhook URL any system that knows a contact's address can post to. Stored as an untrusted external event, idempotent, rate limited.
- **Decisions out:** your endpoints receive a signed envelope for every stored signal with its verdict, and for queue items appearing or resolving. Failures are counted, an endpoint pauses itself, and a delivery log lets you redeliver what failed.
- **Memory for other agents:** a read-only MCP server with four tools (`contact_brief`, `contact_timeline`, `queue`, `search_commitments`) any assistant you already use can call with a revocable token. Answers carry provenance and never another person's email body.
- **Memory that can leave:** one markdown file per contact, or for all of them.

```bash
claude mcp add --transport http proofbox http://localhost:5000/api/mcp --header "Authorization: Bearer <token from Integrations>"
```

### Phase 6: replay, trust, clicks, sharing

- **Replay.** Every run keeps the exact prompt it was shown, so any run replays under a different prompt, model, or effort with nothing rebuilt, and is compared with what it produced then and what you decided since: kept items found again, rejected items kept away, quotes verbatim, your classification corrections, the four-check judge on both draft versions. Variants are files in `server/prompts/`; a change to a production prompt ships with the report. A weekly drift check (opt-in) lists on the Runs page.
- **Earned autonomy, on by default.** Nothing is applied without asking until you have decided enough proposals of a reversible kind at the required rate. The thresholds, the measured state per kind, and a calibration table of confidence against your decisions are on the AI settings page.
- **Link clicks.** Outgoing links go through a redirect; a click is a signal with a verdict, and delivery-time link scanners are filtered the way image prescans are.
- **Shared memory.** Members of an organisation can opt in to see what colleagues know about the same address, attributed per person, read-only and reciprocal.
- **And the rest of the list:** a free local classifier so no message stays unsorted for lack of a key, measured precision per fingerprint rule, a nightly investigation, revocable MCP tokens, Gmail push notifications with polling as the fallback, and receipts that say why an item was left out, with "include and redraft".

```bash
cd server
npm run replay -- --kind extract_memory --since 30d --limit 5              # this month's extractions under the current prompt
npm run replay -- --kind draft_follow_up --variant draft.v2 --judge        # a variant prompt, judged on both sides
npm run replay -- --drift                                                  # this week's sample of every kind
```

### Measured against LoCoMo

The memory pipeline was run, unmodified, against conversation 0 of [LoCoMo](https://github.com/snap-research/locomo) (419 turns replayed as email: the owner's turns trusted, the contact's untrusted and proposed; a scripted accept stands in for the human). All 199 questions are then answered from stored active memory only — the model never sees the conversation — and scored with deterministic token-F1 (stricter than the LLM-judge scoring behind most published numbers, so compare shapes, not absolutes). `npm run eval:locomo`.

| run | extractor / memory | answerer | overall | single-hop | multi-hop | temporal | open-dom. | adversarial |
|---|---|---|---|---|---|---|---|---|
| 1 | nemotron (free), no date resolution | nemotron | **40.2%** | 53% | 28% | 5% | 38% | 57% |
| 2 | gpt-oss-120b, dates resolved | gpt-oss-120b | 34.7% | 44% | 34% | **24%** | 15% | 34% |
| 3 | gpt-oss-120b, dates resolved | nemotron | 32.7% | 46% | 25% | **22%** | 15% | 32% |

What the three runs isolate: teaching the extractor to resolve relative time words against the email's date ("yesterday" → "7 May 2023", in the content and as `structured.eventAt`) took temporal recall from 5% to 22–24% **independent of the answering model** — that fix shipped. The regressions between run 1 and run 3 track the *extraction* model swap, not the answerer (runs 2 vs 3, same memory, differ little): gpt-oss extracted a leaner memory (677 active items vs 758) that costs single-hop coverage and weakens abstention support. Total cost of all three runs and every failed experiment along the way: **$0.47**. Each run's predictions are checkpointed, so re-scoring is free.

### What it cannot do

- Send anything, or change what is remembered, from behind any door or by any model.
- Replay a tool-using run with its tools: it runs on the stored first turn and says so.
- Score a replay of a kind that has no labels yet beyond agreement with the original.
- Tell a proxy prescan from a real open when it arrives past the timing floor with nothing else to go on. That residual is shared by every pixel product and is reported, not hidden.
- Verify Gmail push without a Pub/Sub topic of your own, or the read consent outside Google's test-user list until the app is verified.

---

## Security

- Gmail OAuth tokens and SendGrid API keys are stored with `select: false` in MongoDB — never returned by any API response, only readable by server code that explicitly asks for them
- Share link passwords are bcrypt-hashed (cost 12) before storage
- PDF files are served via authenticated view tokens (JWT, 2-hour expiry) — direct file paths are never exposed
- File storage uses UUID filenames; path traversal is blocked server-side before any file read
- User search regex input is escaped before use in MongoDB `$regex` to prevent ReDoS
- Multer rejects non-PDF MIME types and enforces a 20 MB file size limit
- The tracking pixel endpoint always returns a valid image and never errors visibly, even if the token is unrecognized — a broken image would be a dead giveaway that tracking is happening
