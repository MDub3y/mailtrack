# Proofbox

[![CI](https://github.com/MDub3y/proofbox/actions/workflows/ci.yml/badge.svg)](https://github.com/MDub3y/proofbox/actions/workflows/ci.yml)

**An outbox that remembers — and proves what it remembers.**

You send real email through your own Gmail (or your org's SendGrid). Proofbox tracks what happens honestly — opens, clicks, replies, document views — and builds a memory of every contact where **every fact cites the exact email and quote it came from**: commitments with due dates, facts, preferences. The AI only proposes; you approve; nothing is stored it can't prove. Built for anyone whose work lives in email relationships — sales, recruiting, fundraising, client work — where a dropped promise or a wrong fact costs real money.

**What that means day to day:**

1. **Nothing promised gets dropped** — the follow-through queue is rules with reasons (promise due, opened-but-no-reply, went quiet), not a black-box score.
2. **Every "opened" is trustworthy** — scanner prefetches are classified out and disclosed, not counted.
3. **Context survives time and handoffs** — a brief per contact, every claim clickable back to its source email.
4. **Drafts come pre-grounded** in the real history, in your voice — and you always send them yourself.

## Demo

<!-- demo-video: full product walkthrough -->
https://github.com/user-attachments/assets/5fd8e10d-a6af-4c9a-b232-187eed54c941

<img width="851" height="585" alt="Proofbox dashboard" src="https://github.com/user-attachments/assets/26b522a6-9e74-4c68-a81e-dea61213e9ed" />

## Stack

**TypeScript end to end** · React 19 + Vite · Node + Express · MongoDB/Mongoose · Redis + BullMQ · Google OAuth 2.0 + JWT · Gmail API / SendGrid · Zod-validated structured output · read-only MCP server (`@modelcontextprotocol/sdk`) · Docker local infra · GitHub Actions CI — **174 server tests**, including crash-recovery chaos tests.

## Engineering highlights

- **Exactly-once sending under crashes.** A queue retry used to be able to double-send. Now a durable outbox claim precedes every provider call; a clean provider error clears it (retries stay legal), a crash leaves it, and redelivery resolves it as a visible "outcome unknown" instead of guessing. Proven in CI by killing the worker at **8 labelled points** — 0 duplicates. <details><summary>more</summary>Bulk sends are resumable too: each recipient is keyed by (job, index), so a retried job continues where it crashed instead of re-sending everyone already delivered. `server/src/tests/sendChaos.test.ts`.</details>

- **The false-"opened" investigation.** Emails flipped to `opened` seconds after sending, untouched by any human. Raw request forensics found the tell: hits 3–40s after delivery, one carrying a User-Agent claiming to be three browsers at once — Gmail's security prescan, proxied through the same infrastructure as a real open, indistinguishable by design. <details><summary>more</summary>The classifier uses the synthetic UA fingerprint plus a 3-second floor. The first fix was a 60-second window — it killed the false positives but swallowed real fast opens, a worse failure for a read-receipt product. The window shrank to only what no human reaction explains; the remaining residual (clean-UA prescan past the floor) is disclosed in the UI, not hidden — every pixel product shares it, few admit it. Measured: 0 real opens wrongly suppressed on the labelled set.</details>

- **Two-scope OAuth by design.** Sending (`gmail.send`) and inbox reading (`gmail.readonly`) are separate consents — reading is opt-in later, revocable from the page that shows exactly what was read, with a user-chosen pull window. Tokens AES-encrypted at rest, `select: false`, never returned by any API.

- **A verified AI memory layer.** Every model call goes through one wrapper (budget → context receipt → schema → citation check → run log); every extracted fact passes three gates — the cited email was in context, the quote is verbatim in it, and a judge confirms the quote *entails* the claim, fail-closed. Measured: **24%** of verbatim-quoted items were cited-but-unsupported and dropped; injection red-team **0/60** forbidden state changes; inbox classification **38/38**. <details><summary>more</summary>Deterministic before generative: the queue, digest, open verdicts, and header-stage triage are plain code. Bring-your-own-key, any OpenAI-compatible provider, free models included; capabilities a model lacks degrade and are recorded, never fatal. Every human correction is a label; autonomy is earned per kind from measured acceptance. Runs replay under variant prompts/models, diffed against recorded decisions. Evals: `eval:extraction`, `eval:injection`, `eval:classifier`, `eval:classification`, `eval:draft`, `eval:locomo`.</details>

## Architecture

![Proofbox architecture](assets/architecture.svg)

One signal's journey: you send (pixel injected, links rewritten, `sent` signal recorded) → their client fetches the pixel (classified human/automated *before* it counts) → they reply (matched by thread id / Message-ID; category policy decides if a model may read it) → the extractor proposes items as untrusted text, each quote-verified and entailment-checked → you accept → active memory with a source → the brief cites it, and next week's draft carries a receipt of exactly what the model saw.

The three load-bearing invariants, all test-enforced: **the model is never on a hot path** (an import-boundary test fails the build) · **nothing a model produces changes state by itself** (everything is a proposal; every decision a label) · **text from other people is data, not instructions** (delimited untrusted blocks; extractions from them are never auto-active).

## Benchmarks

Memory quality is benchmarked externally — [LoCoMo](https://github.com/snap-research/locomo): three published runs including regressions (headline: a shipped extraction fix moved temporal recall 5% → 22–24%, isolated from the answering model; total cost $0.47). Where no email-native benchmark exists, we're building one: **[ThreadMem](https://github.com/MDub3y/threadmem)** — pre-registered taxonomy, non-self baselines, falsified predictions reported. <details><summary>LoCoMo table</summary>

| run | extractor / memory | answerer | overall | single-hop | multi-hop | temporal | open-dom. | adversarial |
|---|---|---|---|---|---|---|---|---|
| 1 | nemotron (free), no date resolution | nemotron | **40.2%** | 53% | 28% | 5% | 38% | 57% |
| 2 | gpt-oss-120b, dates resolved | gpt-oss-120b | 34.7% | 44% | 34% | **24%** | 15% | 34% |
| 3 | gpt-oss-120b, dates resolved | nemotron | 32.7% | 46% | 25% | **22%** | 15% | 32% |

Deterministic token-F1 scoring — stricter than the LLM-judge numbers most systems publish; compare shapes, not absolutes. 419 turns replayed as email, 199 questions answered from stored memory only.</details>

## Running locally

**Prerequisites:** Node 18+, Docker, a Google Cloud OAuth client with the Gmail API enabled, and a public HTTPS tunnel (e.g. `ngrok http 5000`) so the tracking pixel is reachable.

```bash
docker compose up -d                 # MongoDB :27018, Redis :6380
cd server && cp .env.example .env    # fill in Google OAuth client + tunnel URL
npm install && npm run dev           # API on :5000
cd ../client && npm install && npm run dev   # app on :5173
npm test                             # 174 tests (in server/)
npm run seed:demo                    # five demo contacts with a week of activity
```

The AI layer is off until `AI_ENABLED=true`; users add their own provider keys in-app (encrypted at rest). While the Google OAuth client is in "Testing" status only listed test users can connect ([ONBOARDING.md](ONBOARDING.md)); enterprise orgs skip Google entirely with their own SendGrid key. The full system contract — every requirement mapped to the mechanism that enforces it and the test that measures it — is in [spec.md](spec.md).

## Security

- Gmail tokens and SendGrid keys stored `select: false`, never returned by any API; BYOK provider keys AES-GCM encrypted at rest
- Share-link passwords bcrypt-hashed; PDFs behind short-lived view tokens; UUID filenames with path-traversal checks; regex input escaped against ReDoS
- The pixel endpoint always returns a valid image — a broken one would reveal the tracking
