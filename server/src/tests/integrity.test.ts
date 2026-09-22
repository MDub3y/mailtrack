import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { connectTestDb, resetTestDb, disconnectTestDb } from './helpers/db';
import { fakeProvider } from './helpers/fakeProvider';
import { __setProviderForTests } from '../ai/providers';
import app from '../app';
import { Email } from '../models/Email';
import { Signal } from '../models/Signal';
import { Label } from '../models/Label';
import { Proposal } from '../models/Proposal';
import { FingerprintRule } from '../models/FingerprintRule';
import { ensureContact, recordSignal } from '../services/signalService';
import { classifyWith, compileRule, loadActiveRules, invalidateRuleCache, labelSignal, reclassifyOpens, syncEmailFromSignals, SEED_RULES } from '../services/classifierService';
import { computeMetrics, seedEvents } from '../ai/evals/classifier';
import { selectCandidates, investigate } from '../ai/investigate/investigator';
import { predictedEffect, uaStats } from '../ai/investigate/tools';
import { decideProposal } from '../ai/corrections';

// Signal integrity end to end: the deterministic classifier with seed
// heuristics and database rules, human labels overriding verdicts and
// rebuilding the email, the eval over labelled events, the bounded
// investigator proposing a rule with server-recomputed effect, and the
// human decision activating it and reclassifying history.

const owner = new mongoose.Types.ObjectId();
const SCANNER_UA = 'Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0';
const PROXY_UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36 (via ggpht.com GoogleImageProxy)';
const HUMAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1';
const NEW_SCANNER_UA = 'Mozilla/5.0 (compatible; MailGuardBot/3.1; +https://mailguard.example)';
let server: http.Server;
let base: string;

function token(id: mongoose.Types.ObjectId): string {
  return jwt.sign({ userId: id.toString() }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, body?: unknown, who = owner): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(who)}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  await connectTestDb();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => { await resetTestDb(); invalidateRuleCache(); process.env.AI_ENABLED = 'true'; process.env.AI_TRUST_POLICY_ENABLED = 'false'; process.env.AI_MODEL_PRIMARY = 'anthropic:claude-opus-5'; __setProviderForTests(null); });
after(async () => { __setProviderForTests(null); await new Promise<void>((r) => server.close(() => r())); await disconnectTestDb(); });

async function emailWithOpens(opens: Array<{ ua: string; ms: number }>, to = 'p@x.com') {
  const contact = await ensureContact(owner, to);
  const createdAt = new Date(Date.now() - 3 * 86_400_000);
  const email = await Email.create({ senderId: owner, contactId: contact._id, from: 'me', to, subject: 'S', htmlBody: '', textBody: '', trackingToken: `t-${Math.random()}`, status: 'delivered', events: [{ type: 'sent', timestamp: createdAt }], createdAt });
  const signals = [];
  for (const o of opens) {
    const at = new Date(createdAt.getTime() + o.ms);
    const verdict = classifyWith(await loadActiveRules(), { userAgent: o.ua, ip: '1.2.3.4', msSinceCreated: o.ms });
    email.events.push({ type: 'opened', timestamp: at, userAgent: o.ua, ip: '1.2.3.4', automated: verdict.automated });
    const eventIndex = email.events.length - 1;
    const { signal } = await recordSignal({ ownerId: owner, contactId: contact._id, emailId: email._id, type: 'open', at, payload: { userAgent: o.ua, ip: '1.2.3.4', msSinceCreated: o.ms, eventIndex, matchedBy: verdict.matchedBy }, verdict: verdict.automated ? 'automated' : 'human', ruleId: verdict.ruleId, source: 'pixel', dedupeKey: `open:${email._id}:${eventIndex}` });
    signals.push(signal);
  }
  await email.save();
  await syncEmailFromSignals(email._id);
  return { contact, email: (await Email.findById(email._id))!, signals };
}

test('seed heuristics: the scanner fingerprint at any delay, and the 3 s floor; a fast real open is kept', () => {
  const none: Parameters<typeof classifyWith>[0] = [];
  assert.equal(classifyWith(none, { userAgent: SCANNER_UA, ip: '', msSinceCreated: 40_000 }).automated, true);
  assert.equal(classifyWith(none, { userAgent: PROXY_UA, ip: '', msSinceCreated: 2_100 }).automated, true);
  assert.equal(classifyWith(none, { userAgent: PROXY_UA, ip: '', msSinceCreated: 5_200 }).automated, false);
  assert.equal(classifyWith(none, { userAgent: HUMAN_UA, ip: '', msSinceCreated: 184_000 }).automated, false);
  assert.match(classifyWith(none, { userAgent: SCANNER_UA, ip: '', msSinceCreated: 40_000 }).matchedBy!, /seed ua_regex/);
});

test('database rules: ua_regex, ip_cidr, a human allow-list winning over automated, invalid patterns skipped', async () => {
  const bot = compileRule({ patternType: 'ua_regex', pattern: 'MailGuardBot', verdict: 'automated', signalType: 'open' })!;
  const cidr = compileRule({ patternType: 'ip_cidr', pattern: '10.20.0.0/16', verdict: 'automated', signalType: 'open' })!;
  const allow = compileRule({ patternType: 'ua_regex', pattern: 'GoogleImageProxy', verdict: 'human', signalType: 'open' })!;
  assert.equal(compileRule({ patternType: 'ua_regex', pattern: '(', verdict: 'automated', signalType: 'open' }), null);
  assert.equal(compileRule({ patternType: 'ip_cidr', pattern: 'not-an-ip/8', verdict: 'automated', signalType: 'open' }), null);
  assert.equal(compileRule({ patternType: 'timing_floor_ms', pattern: 'abc', verdict: 'automated', signalType: 'open' }), null);

  assert.equal(classifyWith([bot], { userAgent: NEW_SCANNER_UA, ip: '', msSinceCreated: 90_000 }).automated, true);
  assert.equal(classifyWith([cidr], { userAgent: HUMAN_UA, ip: '10.20.33.4', msSinceCreated: 90_000 }).automated, true);
  assert.equal(classifyWith([cidr], { userAgent: HUMAN_UA, ip: '10.21.0.1', msSinceCreated: 90_000 }).automated, false);
  // The allow-list keeps a proxy hit under the floor as human: explicit human rules win.
  assert.equal(classifyWith([allow], { userAgent: PROXY_UA, ip: '', msSinceCreated: 1_000 }).automated, false);

  await FingerprintRule.create({ patternType: 'ua_regex', pattern: 'MailGuardBot', verdict: 'automated', signalType: 'open', status: 'active', origin: 'user' });
  await FingerprintRule.create({ patternType: 'ua_regex', pattern: 'Retired', verdict: 'automated', signalType: 'open', status: 'retired', origin: 'user' });
  const rules = await loadActiveRules(true);
  assert.equal(rules.length, 1);
  assert.equal(classifyWith(rules, { userAgent: NEW_SCANNER_UA, ip: '', msSinceCreated: 90_000 }).ruleId!.toString(), rules[0].id.toString());
});

test('the pixel route records the rule that decided, and a database rule takes effect without restart', async () => {
  const contact = await ensureContact(owner, 'p@x.com');
  const email = await Email.create({ senderId: owner, contactId: contact._id, from: 'me', to: 'p@x.com', subject: 'S', htmlBody: '', textBody: '', trackingToken: 'tok-int', status: 'delivered', events: [], createdAt: new Date(Date.now() - 60_000) });
  await fetch(`${base}/api/track/${email.trackingToken}/pixel.png`, { headers: { 'User-Agent': NEW_SCANNER_UA } });
  await new Promise((r) => setTimeout(r, 120));
  let s = await Signal.findOne({ emailId: email._id, type: 'open' }).lean();
  assert.equal(s!.integrity.verdict, 'human'); // no rule yet

  await FingerprintRule.create({ patternType: 'ua_regex', pattern: 'MailGuardBot', verdict: 'automated', signalType: 'open', status: 'active', origin: 'user' });
  invalidateRuleCache();
  await fetch(`${base}/api/track/${email.trackingToken}/pixel.png`, { headers: { 'User-Agent': NEW_SCANNER_UA } });
  await new Promise((r) => setTimeout(r, 120));
  s = await Signal.findOne({ emailId: email._id, type: 'open', 'integrity.verdict': 'automated' }).lean();
  assert.ok(s);
  assert.ok(s!.integrity.ruleId);
  assert.match((s!.payload as { matchedBy: string }).matchedBy, /ua_regex:MailGuardBot/);
  const e = await Email.findById(email._id).lean();
  assert.equal(e!.openCount, 1);
});

test('a human label overrides the verdict, rebuilds the email, and is stored as a Label', async () => {
  const { email, signals } = await emailWithOpens([{ ua: PROXY_UA, ms: 2_000 }, { ua: HUMAN_UA, ms: 400_000 }]);
  assert.equal(email.openCount, 1);
  assert.equal(email.status, 'opened');

  // The 2 s proxy hit was actually the recipient watching for the mail.
  const relabelled = await labelSignal(owner.toString(), signals[0]._id.toString(), 'human');
  assert.equal(relabelled!.integrity.label, 'human');
  assert.equal(relabelled!.integrity.verdict, 'human');
  assert.equal((relabelled!.payload as { classifierVerdict: string }).classifierVerdict, 'automated');
  let e = await Email.findById(email._id).lean();
  assert.equal(e!.openCount, 2);
  assert.equal(e!.events[1].automated, false);
  assert.equal(e!.firstOpenedAt!.getTime(), signals[0].at.getTime());

  // And the long-delay open was a proxy after all.
  await labelSignal(owner.toString(), signals[1]._id.toString(), 'automated');
  e = await Email.findById(email._id).lean();
  assert.equal(e!.openCount, 1);
  const labels = await Label.find({ runKind: 'investigate' }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(labels.map((l) => l.verdict), ['human', 'automated']);

  // Not mine, not an open → null.
  assert.equal(await labelSignal(new mongoose.Types.ObjectId().toString(), signals[0]._id.toString(), 'human'), null);
});

test('the eval over the seed labels: precision 100%, the two proxy prescans past the floor are the known misses', () => {
  const m = computeMetrics(seedEvents(), []);
  assert.equal(m.n, 14);
  assert.equal(m.falsePositive, 0);          // no real open suppressed
  assert.equal(m.precision, 1);
  assert.equal(m.falseNegative, 2);          // seed-06 (21 s) and seed-07 (48 s): proxy UA, past the floor
  assert.deepEqual(m.misses.map((x) => x.id), ['seed-06', 'seed-07']);
  assert.equal(m.humanRecall, 1);
  assert.ok(Math.abs(m.recall - 5 / 7) < 1e-9);
});

test('reclassifying history applies a new rule to unlabelled opens only and rebuilds the emails', async () => {
  const a = await emailWithOpens([{ ua: NEW_SCANNER_UA, ms: 30_000 }, { ua: HUMAN_UA, ms: 500_000 }], 'a@x.com');
  const b = await emailWithOpens([{ ua: NEW_SCANNER_UA, ms: 45_000 }], 'b@x.com');
  await labelSignal(owner.toString(), b.signals[0]._id.toString(), 'human'); // a human says this one was real
  assert.equal(a.email.openCount, 2);

  await FingerprintRule.create({ patternType: 'ua_regex', pattern: 'MailGuardBot', verdict: 'automated', signalType: 'open', status: 'active', origin: 'user' });
  const r = await reclassifyOpens({ ownerId: owner.toString() });
  assert.equal(r.scanned, 2);      // the labelled one is excluded from the scan
  assert.equal(r.changed, 1);
  assert.equal(r.emailsTouched, 1);
  assert.equal((await Email.findById(a.email._id).lean())!.openCount, 1);
  assert.equal((await Email.findById(b.email._id).lean())!.openCount, 1); // label stands
  assert.equal((await Signal.findById(b.signals[0]._id).lean())!.integrity.verdict, 'human');
});

test('candidate selection is a query: label disagreements, fast human verdicts, software-looking agents', async () => {
  const fast = await emailWithOpens([{ ua: PROXY_UA, ms: 6_000 }], 'fast@x.com');           // human verdict, 6 s
  const soft = await emailWithOpens([{ ua: NEW_SCANNER_UA, ms: 90_000 }], 'soft@x.com');   // human verdict, bot-ish UA seen once
  const fine = await emailWithOpens([{ ua: HUMAN_UA, ms: 200_000 }], 'fine@x.com');         // nothing odd
  const dis = await emailWithOpens([{ ua: SCANNER_UA, ms: 30_000 }], 'dis@x.com');          // automated verdict…
  await labelSignal(owner.toString(), dis.signals[0]._id.toString(), 'human');               // …but labelled human

  const c = await selectCandidates(owner);
  const ids = new Map(c.map((x) => [x.signalId, x.why]));
  assert.match(ids.get(dis.signals[0]._id.toString())!, /labelled human, classifier said otherwise/);
  assert.match(ids.get(fast.signals[0]._id.toString())!, /only 6000 ms/);
  assert.match(ids.get(soft.signals[0]._id.toString())!, /looks like software/);
  assert.equal(ids.has(fine.signals[0]._id.toString()), false);
});

test('tools: ua_stats and predictedEffect are computed over the corpus and respect labels', async () => {
  await emailWithOpens([{ ua: NEW_SCANNER_UA, ms: 30_000 }, { ua: NEW_SCANNER_UA, ms: 31_000 }], 'a@x.com');
  const b = await emailWithOpens([{ ua: NEW_SCANNER_UA, ms: 45_000 }, { ua: HUMAN_UA, ms: 500_000 }], 'b@x.com');
  await labelSignal(owner.toString(), b.signals[0]._id.toString(), 'human');

  const stats = await uaStats('MailGuardBot', owner) as { matches: number; currentlyAutomated: number; labelled: { human: number; automated: number }; timing: Record<string, number> };
  assert.equal(stats.matches, 3);
  assert.equal(stats.currentlyAutomated, 0);
  assert.deepEqual(stats.labelled, { human: 1, automated: 0 });
  assert.equal(stats.timing['10-60s'], 3);

  const eff = await predictedEffect({ patternType: 'ua_regex', pattern: 'MailGuardBot', verdict: 'automated' }, owner);
  assert.deepEqual(eff, { wouldReclassify: 3, matchesLabelled: { agree: 0, disagree: 1 }, invalid: false });
  assert.equal((await predictedEffect({ patternType: 'ua_regex', pattern: '(', verdict: 'automated' }, owner)).invalid, true);
});

test('the investigator: bounded tool loop, proposal stored with server-recomputed effect, human decision activates and reclassifies', async () => {
  const a = await emailWithOpens([{ ua: NEW_SCANNER_UA, ms: 30_000 }, { ua: HUMAN_UA, ms: 400_000 }], 'a@x.com');
  await emailWithOpens([{ ua: NEW_SCANNER_UA, ms: 12_000 }], 'b@x.com');
  const candidates = await selectCandidates(owner);
  assert.ok(candidates.length >= 2);

  const fake = fakeProvider([
    { toolCalls: [{ id: 't1', name: 'ua_stats', input: { pattern: 'MailGuardBot' } }, { id: 't2', name: 'list_rules', input: {} }] },
    { toolCalls: [{ id: 't3', name: 'get_event', input: { signalId: a.signals[0]._id.toString() } }] },
    { json: { proposals: [{
      patternType: 'ua_regex', pattern: 'MailGuardBot', verdict: 'automated', confidence: 0.9,
      reasoning: 'A self-identified bot User-Agent seen only within a minute of delivery, never with a human label.',
      evidence: [a.signals[0]._id.toString()],
      predictedEffect: { wouldReclassify: 5, matchesLabelled: { agree: 0, disagree: 0 } }, // wrong on purpose
    }, {
      patternType: 'ua_regex', pattern: '(', verdict: 'automated', confidence: 0.5, reasoning: 'This pattern is not valid and must be dropped by the server.', evidence: [a.signals[0]._id.toString()],
      predictedEffect: { wouldReclassify: 0, matchesLabelled: { agree: 0, disagree: 0 } },
    }] , notes: 'One clear fingerprint.' } },
  ]);
  __setProviderForTests(fake);

  const out = await investigate(owner, { candidates });
  assert.ok(out);
  assert.equal(out!.proposals.length, 1); // the invalid pattern was dropped
  assert.equal(out!.proposals[0].modelDisagreed, true);
  assert.equal(fake.requests.length, 3);
  assert.equal(fake.requests[0].effort, 'high');
  const toolResults = (fake.requests[1].messages[2] as { results: Array<{ content: string }> }).results;
  assert.match(toolResults[0].content, /"matches":2/);
  assert.match((fake.requests[0].messages[0] as { text: string }).text, /Candidate events/);

  const rule = await FingerprintRule.findById(out!.proposals[0].ruleId).lean();
  assert.equal(rule!.status, 'proposed');
  assert.equal(rule!.origin, 'investigator');
  assert.deepEqual((rule!.predictedEffect as { wouldReclassify: number; matchesLabelled: unknown; modelDisagreed: boolean }).wouldReclassify, 2);
  assert.equal((rule!.predictedEffect as { modelDisagreed: boolean }).modelDisagreed, true);
  const proposal = await Proposal.findById(out!.proposals[0].proposalId).lean();
  assert.equal(proposal!.kind, 'fingerprint_rule');
  assert.equal(proposal!.status, 'pending');

  // The human accepts: the rule goes active, and reclassification (run here
  // directly, since the queue is disabled under tests) flips the two opens.
  await decideProposal(out!.proposals[0].proposalId, owner.toString(), 'accept', { reason: 'matches what I saw in the logs' });
  const active = await FingerprintRule.findById(out!.proposals[0].ruleId).lean();
  assert.equal(active!.status, 'active');
  assert.equal(active!.reviewNote, 'matches what I saw in the logs');
  const r = await reclassifyOpens({ ownerId: owner.toString() });
  assert.equal(r.changed, 2);
  assert.equal((await Email.findById(a.email._id).lean())!.openCount, 1);

  // Rejecting records the note the next investigation can read.
  const rej = await FingerprintRule.create({ patternType: 'ua_regex', pattern: 'Chrome', verdict: 'automated', signalType: 'open', status: 'proposed', origin: 'investigator' });
  const rp = await Proposal.create({ ownerId: owner, kind: 'fingerprint_rule', payload: { ruleId: rej._id.toString() }, confidence: 0.3, runId: new mongoose.Types.ObjectId() });
  await decideProposal(rp._id.toString(), owner.toString(), 'reject', { reason: 'far too broad' });
  assert.equal((await FingerprintRule.findById(rej._id).lean())!.status, 'rejected');
});

test('HTTP: integrity overview, labelling, opens for an email, investigate with nothing to do', async () => {
  const { email, signals } = await emailWithOpens([{ ua: SCANNER_UA, ms: 5_000 }, { ua: HUMAN_UA, ms: 300_000 }]);
  const overview = await call('GET', '/api/integrity');
  assert.equal(overview.status, 200);
  assert.equal(overview.json.metrics.n, 14); // seed labels only so far
  assert.equal(overview.json.seedHeuristics.length, SEED_RULES.length);
  assert.deepEqual(overview.json.volume30d, { automated: 1, human: 1 });

  const opens = await call('GET', `/api/integrity/email/${email._id}/opens`);
  assert.equal(opens.json.length, 2);
  assert.equal(opens.json[0].verdict, 'automated');
  assert.match(opens.json[0].matchedBy ?? '', /seed/);

  assert.equal((await call('POST', `/api/integrity/signals/${signals[1]._id}/label`, { label: 'maybe' })).status, 400);
  assert.equal((await call('POST', `/api/integrity/signals/${signals[1]._id}/label`, { label: 'automated' }, new mongoose.Types.ObjectId())).status, 404);
  const lab = await call('POST', `/api/integrity/signals/${signals[1]._id}/label`, { label: 'automated' });
  assert.equal(lab.json.verdict, 'automated');
  const after = await call('GET', '/api/integrity');
  assert.equal(after.json.metrics.n, 15);
  assert.equal((await Email.findById(email._id).lean())!.openCount, 0);

  // The relabelled event disagrees with the classifier, so there is a
  // candidate; without a provider key the run is refused with a clear message.
  const inv = await call('POST', '/api/integrity/investigate', {});
  assert.equal(inv.status, 400);
  assert.match(inv.json.message, /No API key configured/);

  // With a scripted provider that finds nothing, the endpoint reports that honestly.
  __setProviderForTests(fakeProvider([{ json: { proposals: [], notes: 'Nothing distinctive; the labelled hit looks like a genuine fast open.' } }]));
  const inv2 = await call('POST', '/api/integrity/investigate', {});
  assert.equal(inv2.status, 200);
  assert.equal(inv2.json.ran, true);
  assert.deepEqual(inv2.json.proposals, []);
  assert.match(inv2.json.notes, /genuine fast open/);
});
