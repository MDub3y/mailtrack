import { useCallback, useEffect, useState } from 'react';
import { contactsApi, organizationsApi } from '../api';
import type { SharedContactView, SharingStatus } from '../types';

// What colleagues know about this address (F9). Opt-in and reciprocal:
// the toggle here shares your own contact memory with members of your
// organisation who also share, and shows theirs. Every item says whose it is.

const btn = 'px-2.5 py-1 rounded-md border border-[#eaedf1] bg-[#ffffff] text-[11px] font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';
const errorOf = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
const KIND_LABEL: Record<string, string> = { commitment: 'commitment', preference: 'preference', fact: 'fact' };

export const ColleaguesSection = ({ contactId }: { contactId: string }) => {
  const [status, setStatus] = useState<SharingStatus | null>(null);
  const [view, setView] = useState<SharedContactView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const st = (await organizationsApi.sharing()).data;
      setStatus(st);
      if (st.inOrganization) setView((await contactsApi.shared(contactId)).data);
    } catch (err) { setMsg(errorOf(err, 'Could not load shared memory.')); }
  }, [contactId]);
  useEffect(() => { load(); }, [load]);

  if (!status?.inOrganization) return null;

  const toggle = async () => {
    setBusy(true); setMsg('');
    try { await organizationsApi.setSharing(!status.sharing); await load(); }
    catch (err) { setMsg(errorOf(err, 'Could not change sharing.')); }
    finally { setBusy(false); }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-[#0f172a]">From colleagues</h2>
        <div className="flex items-center gap-2">
          {msg && <span className="text-[11px] text-[#991b1b]">{msg}</span>}
          <span className="text-[10px] text-[#94a3b8]">{status.membersSharing} of {status.members} members share</span>
          <button className={btn} disabled={busy} onClick={toggle}>{status.sharing ? 'Stop sharing my memory' : 'Share my memory with colleagues'}</button>
        </div>
      </div>
      {!status.sharing ? (
        <div className="text-xs text-[#94a3b8]">Sharing is off. Turn it on to see what colleagues who also share know about this address, and to let them see yours. Only active items, briefs and activity cross; nothing proposed or rejected, and never an email body.</div>
      ) : !view || view.colleagues.length === 0 ? (
        <div className="text-xs text-[#94a3b8]">No sharing colleague knows this address yet.</div>
      ) : (
        <div className="space-y-3">
          {view.colleagues.map((c) => (
            <div key={c.member._id} className="rounded-lg border border-[#eaedf1] bg-[#ffffff] p-3">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium text-[#0f172a]">{c.member.name}</span>
                <span className="text-[10px] text-[#64748b]">{c.contact.stats.sent} sent · {c.contact.stats.replied} replies{c.contact.lastSignalAt ? ` · last activity ${new Date(c.contact.lastSignalAt).toLocaleDateString()}` : ''}</span>
              </div>
              {c.brief && <p className="mt-1 text-xs text-[#0f172a]">{c.brief.text}</p>}
              {c.memory.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {c.memory.map((m) => (
                    <li key={m._id} className="text-[11px] text-[#0f172a]">
                      <span className="text-[#64748b]">{KIND_LABEL[m.kind] ?? m.kind}</span> · {m.content}
                      {m.expiresAt && <span className="text-[#94a3b8]"> · due {m.expiresAt.slice(0, 10)}</span>}
                      {m.evidence[0]?.quote && <span className="text-[#94a3b8]" title={m.evidence[0].quote}> · from {c.member.name}'s email</span>}
                    </li>
                  ))}
                </ul>
              )}
              {c.recentSignals.length > 0 && <div className="mt-1 text-[10px] text-[#94a3b8]">{c.recentSignals.slice(0, 5).map((s) => `${s.type.replace('_', ' ')} ${new Date(s.at).toLocaleDateString()}`).join(' · ')}</div>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
