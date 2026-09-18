import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { contactsApi, memoryApi } from '../api';
import type { ContactDetailView, MemoryItem, MemoryKind } from '../types';

// One contact: the brief, every memory item with where it came from, the
// emails sent, and the human-verdict timeline. Items can be accepted,
// rejected, edited, or added; every decision becomes a label server-side.

const KIND_ORDER: MemoryKind[] = ['commitment', 'engagement', 'preference', 'fact'];
const KIND_LABEL: Record<string, string> = { commitment: 'Commitments', engagement: 'Engagement', preference: 'Preferences', fact: 'Facts' };

const btn = 'px-2.5 py-1 rounded-md border border-[#eaedf1] bg-[#ffffff] text-[11px] font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';
const input = 'w-full rounded-lg border border-[#eaedf1] bg-[#ffffff] px-3 py-2 text-xs text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:border-[#F17463]';

function fmt(iso?: string): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}

const MemoryRow = ({ item, onChanged }: { item: MemoryItem; onChanged: () => void }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.content);
  const [busy, setBusy] = useState(false);
  const s = (item.structured ?? {}) as { by?: string; fulfilledByEmailId?: string };

  const decide = async (decision: 'accept' | 'reject' | 'edit') => {
    setBusy(true);
    try {
      await memoryApi.decide(item._id, decision === 'edit' ? { decision, content: text } : { decision });
      setEditing(false);
      onChanged();
    } finally { setBusy(false); }
  };

  return (
    <li className={`rounded-lg border p-3 bg-[#ffffff] ${item.status === 'proposed' ? 'border-[#fde68a]' : item.status === 'superseded' ? 'border-[#eaedf1] opacity-60' : 'border-[#eaedf1]'}`}>
      {editing ? (
        <div className="space-y-2">
          <input className={input} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-2">
            <button className={btn} disabled={busy} onClick={() => decide('edit')}>Save and accept</button>
            <button className={btn} onClick={() => { setEditing(false); setText(item.content); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="text-xs text-[#0f172a]">{item.content}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#64748b]">
            {item.status === 'proposed' && <span className="px-1.5 py-0.5 rounded border bg-[#fef3c7] text-[#92400e] border-[#fde68a]">proposed · review</span>}
            {item.status === 'superseded' && <span className="px-1.5 py-0.5 rounded border bg-[#f1f5f9] text-[#475569] border-[#e2e8f0]">superseded</span>}
            {item.kind === 'commitment' && s.by && <span>by {s.by === 'sender' ? 'you' : 'them'}</span>}
            {item.expiresAt && <span>due {fmt(item.expiresAt)}</span>}
            {s.fulfilledByEmailId && <span>fulfilled</span>}
            <span>{item.source === 'user' ? 'added by you' : item.source === 'system' ? 'computed' : `confidence ${Math.round(item.confidence * 100)}%`}</span>
            {item.evidence.filter((e) => e.emailId).map((e, i) => (
              <Link key={i} to={`/sent?email=${e.emailId}`} className="underline" title={e.quote ? `"${e.quote}"` : undefined}>
                source email{e.quote ? ': "' + (e.quote.length > 48 ? e.quote.slice(0, 48) + '…' : e.quote) + '"' : ''}
              </Link>
            ))}
            {item.createdByRunId && <Link to="/runs" className="underline">run</Link>}
          </div>
          {item.status !== 'superseded' && item.source !== 'system' && (
            <div className="mt-2 flex gap-2">
              {item.status === 'proposed' && <button className={btn} disabled={busy} onClick={() => decide('accept')}>Accept</button>}
              <button className={btn} disabled={busy} onClick={() => setEditing(true)}>Edit</button>
              <button className={btn} disabled={busy} onClick={() => decide('reject')}>{item.status === 'proposed' ? 'Reject' : 'Remove'}</button>
            </div>
          )}
        </>
      )}
    </li>
  );
};

export const ContactDetail = () => {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<ContactDetailView | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState<'fact' | 'commitment' | 'preference'>('fact');
  const [newText, setNewText] = useState('');
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefMsg, setBriefMsg] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    try { setView((await contactsApi.get(id)).data); }
    catch { setError('Could not load this contact.'); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!id || newText.trim().length < 3) return;
    setAdding(true);
    try { await contactsApi.addMemory(id, { kind: newKind, content: newText.trim() }); setNewText(''); await load(); }
    finally { setAdding(false); }
  };

  const regenerate = async () => {
    if (!id) return;
    setBriefBusy(true); setBriefMsg('');
    try {
      const res = await contactsApi.regenerateBrief(id);
      setBriefMsg(res.data.generated ? 'Brief updated.' : (res.data.message ?? 'Nothing to say yet.'));
      await load();
    } catch (err) {
      setBriefMsg((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Could not generate a brief.');
    } finally { setBriefBusy(false); }
  };

  if (error) return <div className="p-8 text-xs text-[#991b1b]">{error}</div>;
  if (!view) return <div className="p-8 text-xs text-[#64748b]">Loading…</div>;

  const { contact, memory, emails, signals } = view;
  const grouped = KIND_ORDER.map((k) => [k, memory.filter((m) => m.kind === k)] as const).filter(([, items]) => items.length);
  const proposedCount = memory.filter((m) => m.status === 'proposed').length;

  return (
    <div className="flex flex-1 min-h-0">
      <div className="flex-1 min-w-0 overflow-auto">
        <div className="px-8 py-6 border-b border-[#eaedf1]">
          <Link to="/contacts" className="text-[11px] text-[#64748b] hover:text-[#0f172a]">← Contacts</Link>
          <h1 className="text-lg font-semibold text-[#0f172a] mt-1">{contact.displayName ?? contact.address}</h1>
          {contact.displayName && <div className="text-xs text-[#64748b]">{contact.address}</div>}
          <div className="mt-2 flex gap-4 text-[11px] text-[#64748b]">
            <span>{contact.stats.sent} sent</span><span>{contact.stats.opened} opens</span><span>{contact.stats.replied} replies</span><span>{contact.stats.docViews} document views</span>
          </div>
        </div>

        <div className="px-8 py-6 space-y-8 max-w-3xl">
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-[#0f172a]">Brief</h2>
              <div className="flex items-center gap-2">
                {briefMsg && <span className="text-[11px] text-[#64748b]">{briefMsg}</span>}
                <button className={btn} disabled={briefBusy} onClick={regenerate}>{briefBusy ? 'Writing…' : 'Regenerate brief'}</button>
              </div>
            </div>
            {contact.brief ? (
              <div className="rounded-lg border border-[#eaedf1] bg-[#f8fafc] p-4">
                <p className="text-sm text-[#0f172a] leading-relaxed">{contact.brief.text}</p>
                <div className="mt-2 text-[10px] text-[#64748b]">
                  Written {fmt(contact.brief.generatedAt)} from {contact.brief.citedMemoryIds.length} memory item{contact.brief.citedMemoryIds.length === 1 ? '' : 's'} and {contact.brief.basedOnSignalCount} signals · <Link to="/runs" className="underline">run</Link>
                </div>
              </div>
            ) : (
              <div className="text-xs text-[#94a3b8]">No brief yet. One is written automatically after meaningful activity once a provider key is configured, or press Regenerate.</div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-[#0f172a]">Memory {proposedCount > 0 && <span className="ml-2 text-[11px] font-normal text-[#92400e]">{proposedCount} to review</span>}</h2>
            </div>
            {grouped.length === 0 && <div className="text-xs text-[#94a3b8]">Nothing remembered yet.</div>}
            <div className="space-y-4">
              {grouped.map(([kind, items]) => (
                <div key={kind}>
                  <div className="text-[11px] font-medium text-[#64748b] mb-1.5">{KIND_LABEL[kind]}</div>
                  <ul className="space-y-2">{items.map((m) => <MemoryRow key={m._id} item={m} onChanged={load} />)}</ul>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-lg border border-dashed border-[#eaedf1] p-3">
              <div className="text-[11px] text-[#64748b] mb-2">Add something you know</div>
              <div className="flex gap-2">
                <select className="rounded-lg border border-[#eaedf1] bg-[#ffffff] px-2 text-xs" value={newKind} onChange={(e) => setNewKind(e.target.value as typeof newKind)}>
                  <option value="fact">fact</option><option value="commitment">commitment</option><option value="preference">preference</option>
                </select>
                <input className={input} placeholder="One sentence, e.g. Prefers a call for anything complex" value={newText} onChange={(e) => setNewText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
                <button className={btn} disabled={adding || newText.trim().length < 3} onClick={add}>Add</button>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-[#0f172a] mb-2">Emails</h2>
            {emails.length === 0 ? <div className="text-xs text-[#94a3b8]">None yet.</div> : (
              <ul className="divide-y divide-[#eaedf1] rounded-lg border border-[#eaedf1] bg-[#ffffff]">
                {emails.map((e) => (
                  <li key={e._id} className="px-3 py-2 flex items-center justify-between text-xs">
                    <Link to={`/sent?email=${e._id}`} className="text-[#0f172a] hover:underline truncate">{e.subject}</Link>
                    <span className="text-[#64748b] whitespace-nowrap ml-3">{fmt(e.createdAt)} · {e.status}{e.openCount ? ` · ${e.openCount} open${e.openCount === 1 ? '' : 's'}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <aside className="w-72 shrink-0 border-l border-[#eaedf1] bg-[#f8fafc] overflow-auto">
        <div className="px-4 py-4 border-b border-[#eaedf1] text-sm font-semibold text-[#0f172a]">Timeline</div>
        <ul className="p-4 space-y-2 text-[11px]">
          {signals.length === 0 && <li className="text-[#94a3b8]">No activity yet.</li>}
          {signals.map((s) => {
            const p = s.payload ?? {};
            const label =
              s.type === 'sent' ? `Sent: ${String(p.subject ?? '')}` :
              s.type === 'open' ? 'Opened' :
              s.type === 'doc_view' ? `Viewed ${String(p.documentName ?? 'document')}` :
              s.type === 'page_dwell' ? `Read ${String(p.documentName ?? 'document')} for ${String(p.totalSeconds ?? '?')}s, longest on page ${String(p.topPage ?? '?')}` :
              s.type === 'reply' ? 'Replied' : s.type;
            return (
              <li key={s._id} className="flex gap-2">
                <span className="text-[#94a3b8] whitespace-nowrap">{new Date(s.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <span className="text-[#0f172a]">{label}</span>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
};
