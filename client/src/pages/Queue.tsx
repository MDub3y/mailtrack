import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { queueApi } from '../api';
import type { QueueItem, QueueRule } from '../types';

// Who needs follow-through and why. The reasons are the rules; nothing here
// is scored or recommended by a model. "Draft follow-up" arrives in Phase 2.

const RULE_LABEL: Record<QueueRule, string> = {
  unopened: 'Not opened',
  opened_no_reply: 'Opened, no reply',
  document_interest: 'Read the document',
  your_commitment_due: 'You promised',
  their_commitment_due: 'They promised',
  renewed_interest: 'Back after a quiet spell',
};

const RULE_STYLE: Record<QueueRule, string> = {
  unopened: 'bg-[#f1f5f9] text-[#475569] border-[#e2e8f0]',
  opened_no_reply: 'bg-[#dbeafe] text-[#1e40af] border-[#bfdbfe]',
  document_interest: 'bg-[#ede9fe] text-[#5b21b6] border-[#ddd6fe]',
  your_commitment_due: 'bg-[#fee2e2] text-[#991b1b] border-[#fecaca]',
  their_commitment_due: 'bg-[#fef3c7] text-[#92400e] border-[#fde68a]',
  renewed_interest: 'bg-[#dcfce7] text-[#166534] border-[#bbf7d0]',
};

const btn = 'px-2.5 py-1 rounded-md border border-[#eaedf1] bg-[#ffffff] text-[11px] font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';

export const Queue = () => {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems((await queueApi.list()).data.items); }
    catch { /* leave empty */ }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const keyOf = (i: QueueItem) => `${i.rule}:${i.email?._id ?? ''}:${i.memoryId ?? ''}`;
  const act = async (i: QueueItem, action: 'snooze' | 'dismiss') => {
    setBusy(keyOf(i));
    try {
      const ref = i.memoryId ? { memoryId: i.memoryId } : { emailId: i.email?._id };
      if (action === 'snooze') await queueApi.snooze(i.rule, ref, 3); else await queueApi.dismiss(i.rule, ref);
      setItems((prev) => prev.filter((x) => keyOf(x) !== keyOf(i)));
    } finally { setBusy(null); }
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-8 py-6 border-b border-[#eaedf1]">
        <h1 className="text-lg font-semibold text-[#0f172a]">Follow-through</h1>
        <p className="text-xs text-[#64748b] mt-1">Who needs a nudge and why. Each line is a rule over what happened, not a score.</p>
      </div>

      {loading ? (
        <div className="p-8 text-xs text-[#64748b]">Loading…</div>
      ) : items.length === 0 ? (
        <div className="p-8 text-xs text-[#64748b]">Nothing waiting. Items appear when an email goes unopened, gets read repeatedly with no reply, a document is read carefully, or a promise comes due.</div>
      ) : (
        <ul className="px-8 py-4 space-y-3 max-w-4xl">
          {items.map((i) => (
            <li key={keyOf(i)} className="rounded-lg border border-[#eaedf1] bg-[#ffffff] p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${RULE_STYLE[i.rule]}`}>{RULE_LABEL[i.rule]}</span>
                    <Link to={`/contacts/${i.contact._id}`} className="text-sm font-medium text-[#0f172a] hover:underline">{i.contact.displayName ?? i.contact.address}</Link>
                    {i.contact.displayName && <span className="text-[11px] text-[#64748b]">{i.contact.address}</span>}
                  </div>
                  <div className="mt-1 text-xs text-[#0f172a]">{i.reason}</div>
                  {i.email && (
                    <div className="mt-1 text-[11px] text-[#64748b]">
                      Re: <Link to={`/sent?email=${i.email._id}`} className="underline">{i.email.subject}</Link>
                    </div>
                  )}
                  {i.contact.brief && <div className="mt-2 text-[11px] text-[#475569] line-clamp-2">{i.contact.brief}</div>}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button className={btn} disabled title="Drafting arrives in Phase 2">Draft follow-up</button>
                  <button className={btn} disabled={busy === keyOf(i)} onClick={() => act(i, 'snooze')}>Snooze 3d</button>
                  <button className={btn} disabled={busy === keyOf(i)} onClick={() => act(i, 'dismiss')}>Dismiss</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
