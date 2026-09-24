import { useCallback, useEffect, useState } from 'react';
import { aiApi } from '../api';
import type { TrustOverviewView } from '../types';

// Earned autonomy, visible: which kinds the policy may apply on its own,
// what it has measured for this account, the thresholds, and how the
// model's confidence has matched the owner's decisions so far.

const btn = 'px-2.5 py-1 rounded-md border border-[#eaedf1] bg-[#ffffff] text-[11px] font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';
const input = 'w-24 rounded-lg border border-[#eaedf1] bg-[#ffffff] px-2 py-1 text-xs text-[#0f172a] focus:outline-none focus:border-[#F17463]';
const errorOf = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
const KIND_LABEL: Record<string, string> = { memory_item: 'memory items', memory_supersede: 'memory updates', brief: 'briefs', voice_update: 'voice updates', queue_threshold: 'queue thresholds', fingerprint_rule: 'fingerprint rules', draft: 'drafts' };

export const TrustSettings = () => {
  const [view, setView] = useState<TrustOverviewView | null>(null);
  const [form, setForm] = useState<{ enabled: boolean; minSample: string; minAcceptanceRate: string; minConfidence: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const v = (await aiApi.getTrust()).data;
      setView(v);
      setForm({ enabled: v.config.enabled, minSample: String(v.config.minSample), minAcceptanceRate: String(v.config.minAcceptanceRate), minConfidence: String(v.config.minConfidence) });
    } catch (err) { setMsg(errorOf(err, 'Could not load the trust policy.')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form) return;
    setBusy(true); setMsg('');
    try {
      await aiApi.setTrust({ enabled: form.enabled, minSample: Number(form.minSample), minAcceptanceRate: Number(form.minAcceptanceRate), minConfidence: Number(form.minConfidence) });
      await load(); setMsg('Saved.');
    } catch (err) { setMsg(errorOf(err, 'Could not save.')); }
    finally { setBusy(false); }
  };

  if (!view || !form) return <section><h2 className="text-sm font-semibold text-[#0f172a] mb-1">Trust</h2><div className="text-[11px] text-[#64748b]">{msg || 'Loading…'}</div></section>;
  const serverOff = view.config.source.enabled === 'server' && !view.config.enabled;

  return (
    <section>
      <h2 className="text-sm font-semibold text-[#0f172a] mb-1">Trust</h2>
      <p className="text-[11px] text-[#64748b] mb-3">
        The policy may apply a proposal without asking only for reversible kinds, and only once your own decisions have earned it: at least the sample below decided, accepted at or above the rate, and the item's confidence at or above the cutoff. Drafts and fingerprint rules are never applied on their own. Everything applied this way appears on the Today page with a revert button, and a revert counts against the rate.
      </p>
      <div className="flex items-center gap-3 flex-wrap text-xs text-[#0f172a] mb-3">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.enabled} disabled={serverOff} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> enabled{serverOff && <span className="text-[10px] text-[#92400e]">(off server-wide)</span>}</label>
        <label className="flex items-center gap-1.5">sample <input className={input} value={form.minSample} onChange={(e) => setForm({ ...form, minSample: e.target.value })} /></label>
        <label className="flex items-center gap-1.5">acceptance ≥ <input className={input} value={form.minAcceptanceRate} onChange={(e) => setForm({ ...form, minAcceptanceRate: e.target.value })} /></label>
        <label className="flex items-center gap-1.5">confidence ≥ <input className={input} value={form.minConfidence} onChange={(e) => setForm({ ...form, minConfidence: e.target.value })} /></label>
        <button className={btn} disabled={busy} onClick={save}>Save</button>
        {msg && <span className="text-[11px] text-[#64748b]">{msg}</span>}
        <span className="text-[10px] text-[#94a3b8]">thresholds from {view.config.source.thresholds === 'owner' ? 'you' : view.config.source.thresholds === 'server' ? 'the server' : 'defaults'}</span>
      </div>
      <table className="w-full text-[11px]">
        <thead><tr className="text-left text-[#64748b]"><th className="py-1 font-medium">kind</th><th className="font-medium">decided</th><th className="font-medium">accepted</th><th className="font-medium">status</th><th className="font-medium">last 30 days</th></tr></thead>
        <tbody>
          {view.kinds.map((k) => (
            <tr key={k.kind} className="border-t border-[#eaedf1] text-[#0f172a]">
              <td className="py-1">{KIND_LABEL[k.kind] ?? k.kind}</td>
              <td>{k.sample}{k.pending ? <span className="text-[#94a3b8]"> (+{k.pending} waiting)</span> : ''}</td>
              <td>{k.sample ? `${Math.round(100 * k.acceptanceRate)}%` : '–'}</td>
              <td>{!k.reversible ? <span className="text-[#64748b]">never automatic</span> : k.earned ? <span className="text-[#166534]">earned</span> : <span className="text-[#92400e]" title={k.reason}>asks you ({k.reason})</span>}</td>
              <td className="text-[#64748b]">{k.autoAccepted30d} applied on its own{k.reverted30d ? `, ${k.reverted30d} reverted` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {Object.keys(view.calibration).length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] text-[#64748b] mb-1">Calibration: the model's confidence at proposal time against what you then decided. A suggested cutoff is the lowest bucket you accepted at the rate above, with at least five decisions.</div>
          {Object.entries(view.calibration).map(([kind, c]) => (
            <div key={kind} className="text-[11px] text-[#0f172a] flex items-center gap-2 flex-wrap">
              <span className="w-28">{KIND_LABEL[kind] ?? kind} ({c.n})</span>
              {c.buckets.map((b) => <span key={b.from} className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-[#eaedf1] bg-[#f8fafc]" title={`${b.accepted}/${b.n} accepted`}>{b.from.toFixed(1)}–{b.to.toFixed(1)}: {Math.round(100 * b.rate)}%</span>)}
              {c.suggestedMinConfidence !== undefined && <span className="text-[10px] text-[#64748b]">suggested cutoff {c.suggestedMinConfidence.toFixed(1)}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
