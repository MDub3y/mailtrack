import { useCallback, useEffect, useState } from 'react';
import { inboxApi } from '../api';
import type { CategoryView, CategoryPolicy } from '../types';

// The user's own words for what their mail is, and what the expensive step
// may do with each kind. Built-ins are editable but not deletable; examples
// are what the cheap classifier learns from (corrections land here too).

const POLICY_LABEL: Record<CategoryPolicy, string> = {
  never: 'never read by the model',
  ask: 'ask me first',
  auto: 'read automatically',
};

const btn = 'px-2.5 py-1 rounded-md border border-[#eaedf1] bg-[#ffffff] text-[11px] font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';
const input = 'w-full rounded-lg border border-[#eaedf1] bg-[#ffffff] px-3 py-1.5 text-xs text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:border-[#F17463]';
const errorOf = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

const CategoryRow = ({ cat, onChanged }: { cat: CategoryView; onChanged: () => Promise<void> }) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(cat.name);
  const [description, setDescription] = useState(cat.description);
  const [example, setExample] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg('');
    try { await fn(); await onChanged(); if (ok) setMsg(ok); }
    catch (err) { setMsg(errorOf(err, 'Could not save.')); }
    finally { setBusy(false); }
  };

  return (
    <li className="rounded-lg border border-[#eaedf1] bg-[#ffffff]">
      <div className="flex items-center gap-3 px-3 py-2">
        <button className="text-left flex-1 min-w-0" onClick={() => setOpen((o) => !o)}>
          <span className="text-xs font-medium text-[#0f172a]">{cat.name}</span>
          <span className="ml-2 font-mono text-[10px] text-[#94a3b8]">{cat.key}</span>
          {cat.builtin && <span className="ml-2 text-[10px] text-[#64748b] border border-[#eaedf1] rounded px-1">built-in</span>}
          <span className="ml-2 text-[10px] text-[#64748b]">{cat.counts.total} message{cat.counts.total === 1 ? '' : 's'}{cat.counts.awaiting ? `, ${cat.counts.awaiting} waiting` : ''}</span>
        </button>
        <select
          className="rounded-md border border-[#eaedf1] bg-[#ffffff] px-2 py-1 text-[11px] text-[#0f172a]"
          value={cat.policy}
          disabled={busy}
          onChange={(e) => run(() => inboxApi.updateCategory(cat.key, { policy: e.target.value as CategoryPolicy }))}
          title="What the model may do with mail in this category"
        >
          {(Object.keys(POLICY_LABEL) as CategoryPolicy[]).map((p) => <option key={p} value={p}>{POLICY_LABEL[p]}</option>)}
        </select>
        {!cat.builtin && (
          <button className={btn} disabled={busy} onClick={() => { if (confirm(`Delete "${cat.name}"? Its messages move to "Personal or other".`)) run(() => inboxApi.deleteCategory(cat.key)); }}>Delete</button>
        )}
      </div>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-[#eaedf1] pt-2">
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
          <textarea className={`${input} h-16 resize-none`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe this kind of mail in a sentence. The classifier reads this." />
          <div className="flex items-center gap-2">
            <button className={btn} disabled={busy || !name.trim() || !description.trim()} onClick={() => run(() => inboxApi.updateCategory(cat.key, { name: name.trim(), description: description.trim() }), 'Saved.')}>Save</button>
            {msg && <span className="text-[11px] text-[#64748b]">{msg}</span>}
          </div>
          <div className="text-[11px] text-[#64748b] mt-1">Examples <span className="text-[#94a3b8]">(your corrections on the Triage page are added here automatically)</span></div>
          <ul className="space-y-1">
            {cat.examples.map((e, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-[#0f172a]">
                <span className={`shrink-0 font-mono text-[9px] mt-0.5 ${e.source === 'correction' ? 'text-[#5b21b6]' : 'text-[#94a3b8]'}`}>{e.source}</span>
                <span className="flex-1 min-w-0 truncate" title={e.text}>{e.text}</span>
                <button className="text-[#94a3b8] hover:text-[#991b1b]" disabled={busy} onClick={() => run(() => inboxApi.removeExample(cat.key, i))} title="Remove">×</button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input className={input} value={example} onChange={(e) => setExample(e.target.value)} placeholder="Add an example subject or first line" />
            <button className={btn} disabled={busy || example.trim().length < 3} onClick={() => run(async () => { await inboxApi.addExample(cat.key, example.trim()); setExample(''); })}>Add</button>
          </div>
        </div>
      )}
    </li>
  );
};

export const CategoriesSettings = () => {
  const [cats, setCats] = useState<CategoryView[] | null>(null);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [reclass, setReclass] = useState<string>('');

  const load = useCallback(async () => {
    try { setCats((await inboxApi.categories()).data); setError(''); }
    catch (err) { setError(errorOf(err, 'Could not load categories.')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setCreating(true); setError('');
    try { await inboxApi.createCategory({ name: newName.trim(), description: newDesc.trim() }); setNewName(''); setNewDesc(''); await load(); }
    catch (err) { setError(errorOf(err, 'Could not create the category.')); }
    finally { setCreating(false); }
  };

  const reclassify = async () => {
    setReclass('Reclassifying…');
    try {
      const r = (await inboxApi.reclassify({ sinceDays: 30 })).data;
      setReclass(r.queued ? `${r.queued} messages queued for reclassification.` : `${r.classified ?? 0} of ${r.selected} reclassified.`);
      await load();
    } catch (err) { setReclass(errorOf(err, 'Could not reclassify.')); }
  };

  return (
    <section>
      <h2 className="text-sm font-semibold text-[#0f172a] mb-1">Inbox categories</h2>
      <p className="text-[11px] text-[#64748b] mb-3">
        Incoming mail is sorted into these before any model reads it, using header rules and a cheap classifier on your own key. Each category says what the model may do with it: nothing, ask first, or read it and remember what it says. Replies to your tracked mail are read automatically by default; everything else asks.
      </p>
      {error && <div className="text-[11px] text-[#991b1b] mb-2">{error}</div>}
      {cats === null ? (
        <div className="text-[11px] text-[#64748b]">Loading…</div>
      ) : (
        <ul className="space-y-2">
          {cats.map((c) => <CategoryRow key={c.key} cat={c} onChanged={load} />)}
        </ul>
      )}
      <div className="mt-3 rounded-lg border border-dashed border-[#eaedf1] p-3 space-y-2">
        <div className="text-[11px] text-[#64748b]">New category, in your words</div>
        <input className={input} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Investor updates" />
        <input className={input} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="e.g. Mail from or about our investors: board decks, fund updates, intros." />
        <div className="flex items-center gap-2">
          <button className={btn} disabled={creating || newName.trim().length < 2 || newDesc.trim().length < 5} onClick={create}>Add category</button>
          <button className={btn} onClick={reclassify}>Reclassify the last 30 days</button>
          {reclass && <span className="text-[11px] text-[#64748b]">{reclass}</span>}
        </div>
      </div>
    </section>
  );
};
