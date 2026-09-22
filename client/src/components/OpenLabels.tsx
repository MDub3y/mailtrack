import { useCallback, useEffect, useState } from 'react';
import { integrityApi } from '../api';
import type { OpenSignalRow } from '../types';

// Every open event on one email, with the classifier's verdict and why, and
// two buttons to say what actually happened. A label overrides the verdict,
// rebuilds the email's open count, and becomes ground truth for the
// classifier eval and the investigator.

const btn = 'px-2 py-0.5 rounded border border-[#eaedf1] bg-[#ffffff] text-[10px] font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';

function elapsed(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}

export const OpenLabels = ({ emailId, onChanged }: { emailId: string; onChanged?: () => void }) => {
  const [rows, setRows] = useState<OpenSignalRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRows((await integrityApi.opensForEmail(emailId)).data); } catch { setRows([]); }
  }, [emailId]);
  useEffect(() => { load(); }, [load]);

  const label = async (id: string, value: 'human' | 'automated') => {
    setBusy(id);
    try { await integrityApi.label(id, value); await load(); onChanged?.(); }
    finally { setBusy(null); }
  };

  if (!rows || rows.length === 0) return null;
  const automated = rows.filter((r) => r.verdict === 'automated').length;

  return (
    <div className="pt-3 space-y-2">
      <span className="text-[10px] font-mono font-bold uppercase text-[#94a3b8] tracking-wider block">
        Open events · {rows.length - automated} counted, {automated} filtered as automated
      </span>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r._id} className={`rounded-md border px-2.5 py-1.5 text-[10px] ${r.verdict === 'automated' ? 'border-[#eaedf1] bg-[#f8fafc] text-[#64748b]' : 'border-[#bbf7d0] bg-[#f0fdf4] text-[#0f172a]'}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="font-semibold">{r.verdict === 'automated' ? 'Automated' : 'Open'}</span>
                <span className="font-mono ml-2">{new Date(r.at).toLocaleString()}</span>
                {r.msSinceCreated !== undefined && <span className="ml-2">{elapsed(r.msSinceCreated)} after delivery</span>}
                {r.label && <span className="ml-2 px-1 rounded bg-[#fef3c7] text-[#92400e]">labelled {r.label}</span>}
                {r.matchedBy && <span className="ml-2 text-[#94a3b8]">via {r.matchedBy.replace(/^seed /, 'seed rule ')}</span>}
              </div>
              <div className="flex gap-1 shrink-0">
                {r.verdict === 'automated'
                  ? <button className={btn} disabled={busy === r._id} onClick={() => label(r._id, 'human')} title="This was a real open">Real open</button>
                  : <button className={btn} disabled={busy === r._id} onClick={() => label(r._id, 'automated')} title="This was a scanner or proxy, not a person">Not a person</button>}
              </div>
            </div>
            {r.userAgent && <div className="mt-0.5 font-mono text-[#94a3b8] truncate" title={r.userAgent}>{r.userAgent}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
};
