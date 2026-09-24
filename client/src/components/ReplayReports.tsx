import { useCallback, useEffect, useState } from 'react';
import { aiApi } from '../api';
import type { ReplayReportView, ReplayCheckSummary } from '../types';

// Replay reports (doc/05, Elevation 4): stored runs re-executed under the
// current prompt (drift) or a variant (from the CLI), compared with what was
// produced at the time. Numbers, not impressions.

const btn = 'px-2.5 py-1 rounded-md border border-[#eaedf1] bg-[#ffffff] text-[11px] font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';
const errorOf = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
const pct = (x: number | undefined) => (x === undefined ? '' : `${Math.round(100 * x)}%`);

const Check = ({ name, c }: { name: string; c: ReplayCheckSummary }) => (
  <span className="inline-flex items-center gap-1 text-[10px] text-[#64748b]" title={name}>
    <span className="text-[#0f172a]">{name.replace('judge.', '')}</span>
    {name.endsWith('Delta') ? `mean ${c.mean?.toFixed(0)}` : c.mean !== undefined ? pct(c.mean) : `${c.pass}/${c.of}`}
  </span>
);

export const ReplayReports = () => {
  const [reports, setReports] = useState<ReplayReportView[]>([]);
  const [open, setOpen] = useState<ReplayReportView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try { setReports((await aiApi.listReplays()).data); } catch { /* stays empty */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const drift = async () => {
    setBusy(true); setNote('');
    try {
      const r = (await aiApi.runReplay({ drift: true, sinceDays: 7, limit: 3 })).data;
      const n = Array.isArray(r) ? r.length : 1;
      setNote(n ? `${n} report${n === 1 ? '' : 's'} written.` : 'Nothing to replay: no runs with a stored prompt in the last 7 days.');
      await load();
    } catch (err) { setNote(errorOf(err, 'Could not replay.')); }
    finally { setBusy(false); }
  };
  const show = async (id: string) => {
    try { setOpen((await aiApi.getReplay(id)).data); } catch { /* ignore */ }
  };

  return (
    <section className="px-8 py-4 border-b border-[#eaedf1]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[#0f172a]">Replays</h2>
          <p className="text-[11px] text-[#64748b]">Stored runs re-executed under the current prompt and compared with what they produced at the time. Prompt variants replay from the CLI (<code className="font-mono">npm run replay</code>).</p>
        </div>
        <button className={btn} disabled={busy} onClick={drift}>{busy ? 'Replaying…' : 'Drift check (last 7 days)'}</button>
      </div>
      {note && <div className="mt-2 text-[11px] text-[#64748b]">{note}</div>}
      {reports.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {reports.map((r) => (
            <li key={r._id} className="text-xs text-[#0f172a] flex items-center gap-3 flex-wrap">
              <button className="hover:underline font-mono text-[11px]" onClick={() => show(r._id)}>{r.kind}</button>
              <span className="text-[10px] text-[#94a3b8]">{r.trigger}{r.params.variantSource ? ` · ${r.params.variantSource}` : ''}{r.params.model ? ` · ${r.params.model}` : ''} · {new Date(r.createdAt).toLocaleString()}</span>
              <span className="text-[11px]">{r.summary.ok}/{r.summary.n} ok{r.summary.meanAgreement !== undefined ? ` · agreement ${pct(r.summary.meanAgreement)}` : ''}</span>
              {Object.entries(r.summary.checks).map(([k, c]) => <Check key={k} name={k} c={c as ReplayCheckSummary} />)}
              <span className="text-[10px] text-[#94a3b8]">${r.summary.costUsd.replay.toFixed(4)}</span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="mt-3 rounded-lg border border-[#eaedf1] bg-[#f8fafc] p-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-[#0f172a]">{open.kind} · {open.rows?.length ?? 0} runs</div>
            <button className={btn} onClick={() => setOpen(null)}>Close</button>
          </div>
          <ul className="mt-2 space-y-1">
            {(open.rows ?? []).map((row) => (
              <li key={row.runId} className="text-[11px] text-[#0f172a]">
                <span className="font-mono text-[#64748b]">{row.runId.slice(-6)}</span> {row.status}{row.agreement !== undefined ? ` · agree ${pct(row.agreement)}` : ''}{row.replay ? ` · ${row.replay.tokens} tok · ${row.replay.ms} ms` : ''}{row.error ? ` · ${row.error}` : ''}
                <span className="text-[#64748b]">{Object.entries(row.checks).filter(([k]) => k !== 'judgeCostUsd').map(([k, c]) => ` · ${k.replace('judge.', '')} ${typeof c.value === 'boolean' ? (c.value ? 'Y' : 'N') : k.endsWith('Delta') ? c.value : pct(c.value as number)}`).join('')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};
