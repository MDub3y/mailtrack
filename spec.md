# Proofbox — the system contract

This file is normative: each requirement names the mechanism that enforces it and the test or eval that measures it. If a requirement has no number, it isn't done. (The project's original spec was one sentence — "know the real-time status of a message, like WhatsApp" — preserved in git history; everything below grew from running that honestly.)

## Sending

- **S1.** Email MUST go out through the user's own identity (their Gmail token, or their org's domain-authenticated SendGrid) — never a shared relay. *Enforced:* `dispatchService`. 
- **S2.** A recipient MUST NOT receive the same message twice because of a crash or retry. *Enforced:* durable `dispatching` claim before every provider call; resumable bulk keyed by (job, index). *Measured:* `sendChaos.test.ts`, 8 kill points, 0 duplicates.
- **S3.** When a crash makes the outcome unknowable, the system MUST say so (a visible failure) rather than guess in either direction. *Enforced:* the claim resolves to "outcome unknown" on redelivery.

## Tracking

- **T1.** A reported "opened" MUST mean a person. Automated prefetches are classified before the signal counts, stored, labelled, and disclosed in the UI. *Measured:* classifier eval — 0 real opens suppressed; the clean-UA post-floor residual is documented, not hidden.
- **T2.** The pixel endpoint MUST always return a valid image, token recognised or not.

## Memory

- **M1.** No fact enters memory without a source: the cited email must have been in the model's context, the quote must appear verbatim in it, and the quote must *entail* the claim. Each level fails closed. *Measured:* quote validity + cited-but-unsupported rate (`eval:extraction`; currently 24% caught and dropped).
- **M2.** Nothing a model produces changes state by itself. Every extraction, draft, rule, and classification correction is a Proposal; every human decision is a Label; autonomy is earned per kind from measured acceptance, and a draft can never earn it.
- **M3.** Text from other people is data, not instructions. It reaches models only inside delimited untrusted blocks; anything extracted from it is proposed, never active. *Measured:* `eval:injection` — 0/60 forbidden state changes.
- **M4.** The AI layer MUST NOT be importable from the send/track hot paths. *Enforced:* `importBoundary.test.ts` fails the build.
- **M5.** Every model call leaves a receipt: context shown, exact prompt, schema validation, cited-id verification, tokens, cost. Runs replay under variant prompts/models and are diffed against recorded human decisions.
- **M6.** Memory is the user's: exportable as markdown, readable by their other agents only through a read-only, revocable MCP surface that never returns another person's email body.

## Inbox

- **I1.** Reading a user's inbox requires a second, separate, revocable consent; the initial window (days/messages) is the user's choice.
- **I2.** Mail is sorted by the cheapest sufficient tier (free header rules → cheap classifier) before any model reads a body, and per-category policies (never/ask/auto) gate the expensive step. *Measured:* `eval:classification` — 38/38.

## Cost and models

- **C1.** Bring-your-own-key, any OpenAI-compatible provider, free models included; keys encrypted at rest and never returned. Missing model features degrade and are recorded on the run, never fatal.
- **C2.** Every run carries its cost; per-user daily ceilings refuse before spending.

## Benchmarks

- **B1.** Claims about memory quality are benchmarked externally (LoCoMo published, regressions included) and, where no external benchmark exists, by [ThreadMem](https://github.com/MDub3y/threadmem) — pre-registered before measurement, with non-self baselines, losses published.
