# Running Proofbox as an early user

Proofbox sends real email through **your own Gmail**, tracks opens honestly, and builds a memory of each contact where every fact cites the email it came from. Five minutes to running.

## What the operator does once (not you)

- Adds your Gmail address as a **test user** on the Google OAuth consent screen (Console → Google Auth Platform → Audience → Test users). Until the app passes Google verification, only listed addresses can connect.
- Gives you the app URL (a hosted instance or a tunnel to theirs).

## What you do

1. Open the app URL → **Sign up** (email + password; this is your Proofbox account, separate from Google).
2. **Sent page → Connect Gmail** → pick your Gmail → Google shows an "unverified app" warning (expected while in testing) → *Continue* → allow.
3. Send a tracked email from **Compose**. Watch it flip `sent → delivered → opened` on the Sent page.
4. Optional, and where the memory lives: **Triage → Allow inbox reading** (a second, read-only Google consent; INBOX only, excerpt-only storage, revocable on the same page). Pick how many days/messages to pull. Then run the memory step on any message you choose — nothing is read without your click.
5. Accept or reject what it proposes. Every fact shows its verbatim quote; **Runs** shows every model call and what it saw.

## What we're hoping you'll tell us

- An "opened" that was wrong (either direction) — say which mail client the recipient used.
- A memory item that was wrong, subtly off, or missing.
- The first moment the product annoyed you.

Nothing you do trains anything outside your own account; keys are yours, memory is exportable (Integrations → export), and revoking Google access deletes what was read.
