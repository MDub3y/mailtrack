import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { digestApi } from '../api';
import type { DigestView } from '../types';

// The landing page: what changed since you last looked. Every line is a
// query (signals from people, queue changes, what was remembered on its
// own, what is due, which rules went live). The headline is the one model
// call, on request, and only when there is something to say.

const TYPE_LABEL: Record<string, string> = {
  sent: 'sent', delivered: 'delivered', failed: 'failed to send', open: 'opened', link_click: 'clicked a link', doc_view: 'read a document',
  page_dwell: 'spent time on a document', reply: 'replied', bounce: 'bounced', external: 'external event',
};
const btn = 'px-2.5 py-1 rounded-md border border-[#eaedf1] bg-[#ffffff] text-[11px] font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';
const errorOf = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
const who = (c: { address: string; displayName?: string }) => c.displayName || c.address;
const day = (iso: string) => iso.slice(0, 10);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-6">
    <h2 className="text-xs font-semibold text-[#0f172a] mb-2">{title}</h2>
    {children}
  </section>
);

export const Digest = () => {
  const [view, setView] = useState<DigestView | null>(null);
  const [error, setError] = useState('');
  const [headline, setHeadline] = useState<string | null>(null);
  const [busy, setBusy] = useState<'headline' | 'email' | 'seen' | string | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try { setView((await digestApi.get()).data); setError(''); }
    catch (err) { setError(errorOf(err, 'Could not load the digest.')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const writeHeadline = async () => {
    setBusy('headline'); setNote('');
    try { const r = (await digestApi.headline(view?.since)).data; setHeadline(r.headline); if (!r.headline) setNote(r.message ?? 'Nothing to summarise.'); }
    catch (err) { setNote(errorOf(err, 'Could not write a headline.')); }
    finally { setBusy(null); }
  };
  const email = async () => {
    setBusy('email'); setNote('');
    try { const r = (await digestApi.email({ since: view?.since, headline: headline ?? undefined })).data; setNote(`Sent to ${r.to}.`); }
    catch (err) { setNote(errorOf(err, 'Could not send.')); }
    finally { setBusy(null); }
  };
  const seen = async () => {
    setBusy('seen'); setNote('');
    try { await digestApi.seen(); setHeadline(null); await load(); setNote('Window moved. The next digest starts now.'); }
    catch (err) { setNote(errorOf(err, 'Could not mark as seen.')); }
    finally { setBusy(null); }
  };
  const revert = async (proposalId: string) => {
    setBusy(proposalId);
    try { await digestApi.revert(proposalId); await load(); }
    catch (err) { setNote(errorOf(err, 'Could not revert.')); }
    finally { setBusy(null); }
  };

  if (error) return <div className="p-8 text-xs text-[#991b1b]">{error}</div>;
  if (!view) return <div className="p-8 text-xs text-[#64748b]">Loading…</div>;

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-8 py-6 border-b border-[#eaedf1]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-[#0f172a]">What changed</h1>
            <p className="text-xs text-[#64748b] mt-1">Since {when(view.since)}{view.firstLook ? ' (your first look: the last 24 hours)' : ''}. Automated opens are left out. Every line is a query, not a judgement.</p>
          </div>
          <div className="flex items-center gap-2">
            {view.aiEnabled && view.hasSomething && <button className={btn} disabled={busy !== null} onClick={writeHeadline}>{busy === 'headline' ? 'Writing…' : 'Write a headline'}</button>}
            <button className={btn} disabled={busy !== null} onClick={email}>{busy === 'email' ? 'Sending…' : 'Email this to me'}</button>
            <button className={btn} disabled={busy !== null} onClick={seen}>Mark as seen</button>
          </div>
        </div>
        {headline && <p className="mt-3 text-sm text-[#0f172a]">{headline}</p>}
        {note && <div className="mt-2 text-xs text-[#64748b]">{note}</div>}
      </div>

      <div className="px-8 py-6 max-w-3xl">
        {!view.hasSomething && <div className="text-xs text-[#64748b]">Nothing new. No signals from people, no queue changes, nothing accepted on its own, nothing due.</div>}

        {view.commitmentsDue.length > 0 && (
          <Section title="Commitments due">
            <ul className="space-y-1.5">
              {view.commitmentsDue.map((c) => (
                <li key={c.memoryId} className="text-xs text-[#0f172a] flex items-start gap-2">
                  <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] ${c.overdue ? 'bg-[#fee2e2] text-[#991b1b] border-[#fecaca]' : 'bg-[#fef3c7] text-[#92400e] border-[#fde68a]'}`}>{c.overdue ? 'overdue' : `due ${day(c.dueAt)}`}</span>
                  <span><span className="text-[#64748b]">{c.by === 'sender' ? 'you promised' : c.by === 'contact' ? 'they promised' : 'promised'}:</span> {c.content} <Link to={`/contacts/${c.contact._id}`} className="underline text-[#64748b]">{who(c.contact)}</Link></span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {view.contacts.length > 0 && (
          <Section title="Activity">
            <ul className="space-y-1.5">
              {view.contacts.map((l) => (
                <li key={l.contact._id} className="text-xs text-[#0f172a]">
                  <Link to={`/contacts/${l.contact._id}`} className="font-medium hover:underline">{who(l.contact)}</Link>
                  <span className="text-[#64748b]">: {l.signals.map((s) => `${TYPE_LABEL[s.type] ?? s.type}${s.count > 1 ? ` ×${s.count}` : ''}${s.detail ? ` (${s.detail})` : ''}`).join(', ')}</span>
                  <span className="text-[#94a3b8]"> · {when(l.signals[0].last)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {(view.queue.appeared.length > 0 || view.queue.resolved.length > 0) && (
          <Section title={`Follow-through (${view.queue.current} open)`}>
            <ul className="space-y-1.5">
              {view.queue.appeared.map((i) => (
                <li key={`${i.rule}:${i.email?._id ?? ''}:${i.memoryId ?? ''}`} className="text-xs text-[#0f172a]"><span className="text-[#166534]">new</span> · <Link to={`/contacts/${i.contact._id}`} className="hover:underline">{who(i.contact)}</Link>: {i.reason}</li>
              ))}
              {view.queue.resolved.map((r) => (
                <li key={r.key} className="text-xs text-[#64748b]"><span className="text-[#475569]">resolved</span> · {r.rule.replace(/_/g, ' ')}</li>
              ))}
            </ul>
            <Link to="/queue" className="text-[11px] text-[#64748b] underline mt-2 inline-block">Open the queue</Link>
          </Section>
        )}

        {view.autoAccepted.length > 0 && (
          <Section title="Remembered without asking">
            <p className="text-[11px] text-[#64748b] mb-2">The policy accepted these on its own because it has earned that for this kind. Each can be reverted.</p>
            <ul className="space-y-1.5">
              {view.autoAccepted.map((a) => (
                <li key={a.proposalId} className="text-xs text-[#0f172a] flex items-center gap-2">
                  <span className="flex-1">{a.content}{a.contact && <> · <Link to={`/contacts/${a.contact._id}`} className="underline text-[#64748b]">{who(a.contact)}</Link></>}</span>
                  <button className={btn} disabled={busy !== null} onClick={() => revert(a.proposalId)}>{busy === a.proposalId ? 'Reverting…' : 'Revert'}</button>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {(view.integrity.rulesAccepted.length > 0 || view.integrity.corrections > 0) && (
          <Section title="Signal integrity">
            <ul className="space-y-1.5">
              {view.integrity.rulesAccepted.map((r) => <li key={r.ruleId} className="text-xs text-[#0f172a]">rule live: <code className="font-mono">{r.patternType} {r.pattern}</code> → {r.verdict}</li>)}
              {view.integrity.corrections > 0 && <li className="text-xs text-[#0f172a]">corrections you made: {view.integrity.corrections}</li>}
            </ul>
            <Link to="/integrity" className="text-[11px] text-[#64748b] underline mt-2 inline-block">Open Integrity</Link>
          </Section>
        )}
      </div>
    </div>
  );
};
