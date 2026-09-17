import { useEffect, useState } from 'react';
import { aiApi } from '../api';
import type { AgentRun, RunStatus } from '../types';

// The run log: every model call, what it was shown (the receipt), what it did
// (steps), what it produced, and what it cost. A draft is not magic; it is a
// run you can open.

const STATUS_STYLES: Record<RunStatus, string> = {
  running:   'bg-[#fef3c7] text-[#92400e] border-[#fde68a]',
  succeeded: 'bg-[#dcfce7] text-[#166534] border-[#bbf7d0]',
  failed:    'bg-[#fee2e2] text-[#991b1b] border-[#fecaca]',
  refused:   'bg-[#f1f5f9] text-[#475569] border-[#e2e8f0]',
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(4)}`;
}

const RunDetail = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setRun(null);
    setError('');
    aiApi.getRun(id)
      .then((res) => setRun(res.data))
      .catch(() => setError('Could not load this run.'));
  }, [id]);

  return (
    <div className="w-[480px] shrink-0 border-l border-[#eaedf1] bg-[#f8fafc] overflow-auto">
      <div className="flex items-center justify-between px-5 py-4 border-b border-[#eaedf1] bg-[#ffffff]">
        <div className="text-sm font-semibold text-[#0f172a]">Run detail</div>
        <button onClick={onClose} className="text-xs text-[#64748b] hover:text-[#0f172a]">Close</button>
      </div>

      {error && <div className="p-5 text-xs text-[#991b1b]">{error}</div>}
      {!run && !error && <div className="p-5 text-xs text-[#64748b]">Loading…</div>}

      {run && (
        <div className="p-5 space-y-5 text-xs">
          <section className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold text-[#0f172a]">{run.kind}</span>
              <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${STATUS_STYLES[run.status]}`}>{run.status}</span>
            </div>
            <div className="text-[#64748b]">{run.modelId}{run.effort ? ` · effort ${run.effort}` : ''}{run.keySource ? ` · ${run.keySource} key` : ''} · {formatWhen(run.startedAt)}</div>
            {run.degraded && run.degraded.length > 0 && (
              <div className="mt-1 text-[#92400e]">This model could not use: {run.degraded.join(', ')}. The run fell back to prompt instructions.</div>
            )}
            {run.error && <div className="mt-1 text-[#991b1b] break-words">{run.error}</div>}
          </section>

          <section>
            <div className="font-semibold text-[#0f172a] mb-2">What the model was shown</div>
            <div className="rounded-lg border border-[#eaedf1] bg-[#ffffff] divide-y divide-[#eaedf1]">
              {run.receipt.sections.map((s) => (
                <div key={s.name} className="px-3 py-2 flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[#0f172a]">
                      {s.name}
                      {s.cacheBoundary && <span className="ml-2 text-[10px] text-[#F17463]">cache boundary ↓</span>}
                    </div>
                    {s.itemIds.length > 0 && (
                      <div className="text-[#64748b] mt-0.5">used: {s.itemIds.join(', ')}</div>
                    )}
                    {s.droppedItemIds.length > 0 && (
                      <div className="text-[#92400e] mt-0.5">dropped for budget: {s.droppedItemIds.join(', ')}</div>
                    )}
                  </div>
                  <div className="font-mono text-[#64748b] whitespace-nowrap">{s.tokens} tok</div>
                </div>
              ))}
              <div className="px-3 py-2 flex justify-between text-[#64748b]">
                <span>total input ({run.receipt.exact ? 'exact' : 'estimate'})</span>
                <span className="font-mono">{run.receipt.totalInputTokens} tok</span>
              </div>
            </div>
          </section>

          {run.steps && run.steps.length > 0 && (
            <section>
              <div className="font-semibold text-[#0f172a] mb-2">Tool steps</div>
              <ol className="space-y-2">
                {run.steps.map((step, i) => (
                  <li key={i} className={`rounded-lg border p-3 bg-[#ffffff] ${step.isError ? 'border-[#fecaca]' : 'border-[#eaedf1]'}`}>
                    <div className="flex justify-between">
                      <span className="font-mono text-[#0f172a]">{i + 1}. {step.tool}</span>
                      <span className="text-[#64748b]">{step.ms} ms</span>
                    </div>
                    <pre className="mt-1 text-[10px] text-[#64748b] whitespace-pre-wrap break-words">{JSON.stringify(step.input)}</pre>
                    <div className="mt-1 text-[#0f172a] whitespace-pre-wrap break-words">{step.outputSummary}</div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {run.output !== undefined && (
            <section>
              <div className="font-semibold text-[#0f172a] mb-2">Output</div>
              <pre className="rounded-lg border border-[#eaedf1] bg-[#ffffff] p-3 text-[10px] whitespace-pre-wrap break-words">{JSON.stringify(run.output, null, 2)}</pre>
            </section>
          )}

          <section>
            <div className="font-semibold text-[#0f172a] mb-2">Usage and cost</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                ['input', run.usage.input],
                ['output', run.usage.output],
                ['cache read', run.usage.cacheRead],
                ['cache write', run.usage.cacheWrite],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-[#eaedf1] bg-[#ffffff] px-3 py-2">
                  <div className="text-[#64748b]">{label}</div>
                  <div className="font-mono text-[#0f172a]">{value}</div>
                </div>
              ))}
              <div className="col-span-2 rounded-lg border border-[#eaedf1] bg-[#ffffff] px-3 py-2 flex justify-between">
                <span className="text-[#64748b]">
                  {run.costSource === 'provider' ? 'cost (reported by provider)' : run.costSource === 'unknown' ? 'cost (no price known for this model)' : 'estimated cost'}
                </span>
                <span className="font-mono text-[#0f172a]">{run.costSource === 'unknown' ? '—' : formatCost(run.costUsd)}</span>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

export const Runs = () => {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([aiApi.status(), aiApi.listRuns()])
      .then(([status, list]) => {
        setEnabled(status.data.enabled);
        setRuns(list.data);
      })
      .catch(() => setEnabled(false))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex flex-1 min-h-0">
      <div className="flex-1 min-w-0 overflow-auto">
        <div className="px-8 py-6 border-b border-[#eaedf1]">
          <h1 className="text-lg font-semibold text-[#0f172a]">Runs</h1>
          <p className="text-xs text-[#64748b] mt-1">
            Every model call, with what it was shown and what it cost.
            {enabled === false && <span className="ml-2 text-[#92400e]">AI features are currently disabled on the server.</span>}
          </p>
        </div>

        {loading ? (
          <div className="p-8 text-xs text-[#64748b]">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="p-8 text-xs text-[#64748b]">No runs yet.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-[#64748b] border-b border-[#eaedf1]">
              <tr>
                <th className="px-8 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium text-right">Input</th>
                <th className="px-3 py-2 font-medium text-right">Cached</th>
                <th className="px-3 py-2 font-medium text-right">Output</th>
                <th className="px-8 py-2 font-medium text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run._id}
                  onClick={() => setSelected(run._id)}
                  className={`border-b border-[#eaedf1] cursor-pointer hover:bg-[#f8fafc] ${selected === run._id ? 'bg-[#f8fafc]' : ''}`}
                >
                  <td className="px-8 py-2.5 text-[#64748b] whitespace-nowrap">{formatWhen(run.startedAt)}</td>
                  <td className="px-3 py-2.5 font-mono text-[#0f172a]">{run.kind}</td>
                  <td className="px-3 py-2.5">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${STATUS_STYLES[run.status]}`}>{run.status}</span>
                  </td>
                  <td className="px-3 py-2.5 text-[#64748b]">{run.modelId}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{run.usage.input}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{run.usage.cacheRead}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{run.usage.output}</td>
                  <td className="px-8 py-2.5 text-right font-mono">{formatCost(run.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && <RunDetail id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
};
