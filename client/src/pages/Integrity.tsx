import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { integrityApi } from '../api';
import type { IntegrityView, FingerprintRuleView } from '../types';

// Signal integrity: how accurate the open classifier is, measured against
// labelled events; the rules it runs on; and the investigator's proposals
// waiting for a decision. The numbers here are the honest version of the
// README's "no pixel tracker is 100% accurate".

const btn = 'px-2.5 py-1 rounded-md border border-[#eaedf1] bg-[#ffffff] text-[11px] font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';
const pct = (x: number) => `${Math.round(x * 100)}%`;

const RuleRow = ({ r, pending, onDecide, busy }: { r: FingerprintRuleView; pending?: boolean; onDecide?: (id: string, d: 'accept' | 'reject') => void; busy?: boolean }) => {
  const [note, setNote] = useState('');
  const pe = r.predictedEffect;
  return (
    <li className={`rounded-lg border p-3 bg-[#ffffff] text-xs ${pending ? 'border-[#fde68a]' : 'border-[#eaedf1]'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[#0f172a]">
            {r.patternType} · <span className="break-all">{r.pattern}</span> → <span className={r.verdict === 'automated' ? 'text-[#991b1b]' : 'text-[#166534]'}>{r.verdict}</span>
          </div>
          {r.reasoning && <div className="mt-1 text-[#475569]">{r.reasoning}</div>}
          <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-[#64748b]">
            <span>{r.origin}</span>
            <span>confidence {pct(r.confidence)}</span>
            {r.evidence.length > 0 && <span>{r.evidence.length} evidence event{r.evidence.length === 1 ? '' : 's'}</span>}
            {pe && <span>would reclassify {pe.wouldReclassify} · agrees with {pe.matchesLabelled.agree} label{pe.matchesLabelled.agree === 1 ? '' : 's'}, disagrees with {pe.matchesLabelled.disagree}</span>}
            {pe?.modelDisagreed && pe.modelReported && <span className="text-[#92400e]">model claimed {pe.modelReported.wouldReclassify} / {pe.modelReported.matchesLabelled.agree} / {pe.modelReported.matchesLabelled.disagree}; server recomputed</span>}
            {r.proposedByRunId && <Link to="/runs" className="underline">run</Link>}
            {r.reviewNote && <span>note: {r.reviewNote}</span>}
          </div>
        </div>
        {pending && onDecide && r.proposalId && (
          <div className="flex flex-col gap-1 shrink-0 w-48">
            <input className="rounded border border-[#eaedf1] px-2 py-1 text-[11px]" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex gap-1">
              <button className={btn} disabled={busy} onClick={() => onDecide(r.proposalId! + '|' + note, 'accept')}>Accept</button>
              <button className={btn} disabled={busy} onClick={() => onDecide(r.proposalId! + '|' + note, 'reject')}>Reject</button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
};

export const Integrity = () => {
  const [view, setView] = useState<IntegrityView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try { setView((await integrityApi.overview()).data); } catch { setError('Could not load signal integrity.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const investigate = async () => {
    setBusy('investigate'); setMsg('');
    try {
      const r = (await integrityApi.investigate()).data;
      setMsg(r.ran ? `Investigated ${r.candidates} events: ${r.proposals?.length ?? 0} proposal${(r.proposals?.length ?? 0) === 1 ? '' : 's'}.${r.notes ? ` ${r.notes}` : ''}` : (r.message ?? 'Nothing to investigate.'));
      await load();
    } catch (err) {
      setMsg((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Investigation failed.');
    } finally { setBusy(null); }
  };

  const reclassify = async () => {
    setBusy('reclassify'); setMsg('');
    try { const r = (await integrityApi.reclassify()).data; setMsg(`Reclassified: ${r.changed} of ${r.scanned} open events changed, ${r.emailsTouched} emails updated.`); await load(); }
    catch { setMsg('Reclassification failed.'); }
    finally { setBusy(null); }
  };

  const decide = async (idAndNote: string, d: 'accept' | 'reject') => {
    const [proposalId, note] = idAndNote.split('|');
    setBusy(proposalId);
    try { await integrityApi.decideProposal(proposalId, d, note || undefined); setMsg(d === 'accept' ? 'Rule activated. History is being reclassified.' : 'Rule rejected; the note is visible to the next investigation.'); await load(); }
    catch { setMsg('Could not record the decision.'); }
    finally { setBusy(null); }
  };

  if (error) return <div className="p-8 text-xs text-[#991b1b]">{error}</div>;
  if (!view) return <div className="p-8 text-xs text-[#64748b]">Loading…</div>;
  const m = view.metrics;

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-8 py-6 border-b border-[#eaedf1] flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-[#0f172a]">Signal integrity</h1>
          <p className="text-xs text-[#64748b] mt-1">How often "opened" means a person. Measured against events you and the seed set have labelled, not asserted.</p>
          {msg && <div className="mt-2 text-xs text-[#0f172a]">{msg}</div>}
        </div>
        <div className="flex gap-2">
          <button className={btn} disabled={busy !== null} onClick={investigate}>{busy === 'investigate' ? 'Investigating…' : 'Investigate anomalies'}</button>
          <button className={btn} disabled={busy !== null} onClick={reclassify}>{busy === 'reclassify' ? 'Reclassifying…' : 'Reclassify history'}</button>
        </div>
      </div>

      <div className="px-8 py-6 max-w-4xl space-y-8">
        <section>
          <h2 className="text-sm font-semibold text-[#0f172a] mb-2">Open classifier, measured on {m.n} labelled events</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            {[
              ['Real opens kept', pct(m.humanRecall), `${m.trueNegative} of ${m.trueNegative + m.falsePositive}`, 'A real open we suppressed is the worse error.'],
              ['Scans caught', pct(m.recall), `${m.truePositive} of ${m.truePositive + m.falseNegative}`, 'Prescans that arrive through the same proxy as a real open, past the timing floor, are the known residual.'],
              ['Suppressions that were right', pct(m.precision), `${m.truePositive} of ${m.truePositive + m.falsePositive}`, ''],
              ['Opens in the last 30 days', String((view.volume30d.human ?? 0) + (view.volume30d.automated ?? 0)), `${view.volume30d.human ?? 0} counted, ${view.volume30d.automated ?? 0} filtered`, ''],
              ['Link clicks in the last 30 days', String((view.volume30dByType?.link_click?.human ?? 0) + (view.volume30dByType?.link_click?.automated ?? 0)), `${view.volume30dByType?.link_click?.human ?? 0} counted, ${view.volume30dByType?.link_click?.automated ?? 0} filtered as delivery-time scans`, 'Links in outgoing mail go through a redirect; the same rules apply per signal type.'],
            ].map(([label, big, small, note]) => (
              <div key={label} className="rounded-lg border border-[#eaedf1] bg-[#ffffff] p-3">
                <div className="text-[#64748b]">{label}</div>
                <div className="text-xl font-semibold text-[#0f172a]">{big}</div>
                <div className="text-[10px] text-[#64748b]">{small}</div>
                {note && <div className="mt-1 text-[10px] text-[#94a3b8]">{note}</div>}
              </div>
            ))}
          </div>
          {m.misses.length > 0 && (
            <details className="mt-2 text-[11px] text-[#64748b]">
              <summary className="cursor-pointer">Where the classifier is wrong right now ({m.misses.length})</summary>
              <ul className="mt-1 space-y-0.5 font-mono">
                {m.misses.map((x) => <li key={x.id}>{x.id}: labelled {x.label}, predicted {x.predicted}, {Math.round(x.msSinceCreated / 1000)} s · {x.userAgent.slice(0, 80)}</li>)}
              </ul>
            </details>
          )}
          <p className="mt-2 text-[11px] text-[#64748b]">Label any open on a sent email ("Real open" / "Not a person") to grow this set. Each label overrides the verdict for that event and feeds the next investigation.</p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-[#0f172a] mb-2">Proposed rules {view.rules.proposed.length > 0 && <span className="ml-2 text-[11px] font-normal text-[#92400e]">{view.rules.proposed.length} to review</span>}</h2>
          {view.rules.proposed.length === 0
            ? <div className="text-xs text-[#94a3b8]">Nothing waiting. Run "Investigate anomalies" to examine recent suspicious opens.</div>
            : <ul className="space-y-2">{view.rules.proposed.map((r) => <RuleRow key={r._id} r={r} pending onDecide={decide} busy={busy === r.proposalId} />)}</ul>}
        </section>

        <section>
          <h2 className="text-sm font-semibold text-[#0f172a] mb-2">Active rules</h2>
          <ul className="space-y-2">
            {view.seedHeuristics.map((s, i) => (
              <li key={`seed-${i}`} className="rounded-lg border border-[#eaedf1] p-3 bg-[#f8fafc] text-xs">
                <div className="font-mono text-[#0f172a]">{s.patternType} · {s.pattern} → {s.verdict} <span className="text-[10px] text-[#64748b]">(shipped with the code)</span></div>
                {s.reasoning && <div className="mt-1 text-[#475569]">{s.reasoning}</div>}
              </li>
            ))}
            {view.rules.active.map((r) => <RuleRow key={r._id} r={r} />)}
          </ul>
        </section>

        {view.rules.rejected.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-[#0f172a] mb-2">Rejected</h2>
            <ul className="space-y-2 opacity-70">{view.rules.rejected.map((r) => <RuleRow key={r._id} r={r} />)}</ul>
          </section>
        )}
      </div>
    </div>
  );
};
