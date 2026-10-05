import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { inboxApi, authApi } from '../api';
import type { InboundMessageView, CategoryView, InboxStatusView, TriageStatus, CategoryPolicy } from '../types';

// The inbox, sorted before any model reads it. Every row says which
// category it landed in, which tier decided (free header rules, the cheap
// classifier, or a person), and whether the expensive step ran, is waiting
// for a click, or was skipped by the category's policy.

const BACKEND_LABEL: Record<string, string> = {
  headers: 'header rule',
  embeddings: 'embeddings',
  llm: 'cheap model',
  local: 'local model',
  human: 'you',
};

const STATUS_LABEL: Record<TriageStatus, string> = {
  unclassified: 'not yet sorted',
  classified: 'queued',
  awaiting_approval: 'waiting for you',
  processed: 'read and remembered',
  skipped: 'skipped',
  failed: 'failed',
};

const STATUS_STYLE: Record<TriageStatus, string> = {
  unclassified: 'bg-[#f1f5f9] text-[#475569] border-[#e2e8f0]',
  classified: 'bg-[#dbeafe] text-[#1e40af] border-[#bfdbfe]',
  awaiting_approval: 'bg-[#fef3c7] text-[#92400e] border-[#fde68a]',
  processed: 'bg-[#dcfce7] text-[#166534] border-[#bbf7d0]',
  skipped: 'bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]',
  failed: 'bg-[#fee2e2] text-[#991b1b] border-[#fecaca]',
};

const POLICY_LABEL: Record<CategoryPolicy, string> = { never: 'never', ask: 'ask', auto: 'auto' };

const btn = 'px-2.5 py-1 rounded-md border border-[#eaedf1] bg-[#ffffff] text-[11px] font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';
const errorOf = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

const ago = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const numInput = 'w-16 px-1.5 py-1 rounded-md border border-[#eaedf1] bg-[#ffffff] text-[11px] text-[#0f172a] text-right';

const ConsentBanner = ({ status, onChanged }: { status: InboxStatusView; onChanged: () => Promise<void> }) => {
  const [params] = useSearchParams();
  const result = params.get('gmailRead');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // The pull window is the owner's choice (clamped server-side); the status
  // payload carries the effective values and the allowed bounds.
  const [days, setDays] = useState(String(status.initial.days));
  const [max, setMax] = useState(String(status.initial.max));
  useEffect(() => { setDays(String(status.initial.days)); setMax(String(status.initial.max)); }, [status.initial.days, status.initial.max]);

  const saveInitial = async (): Promise<void> => {
    const d = Number(days), m = Number(max);
    try {
      const r = (await inboxApi.setInitial({ days: Number.isFinite(d) && days !== '' ? d : undefined, max: Number.isFinite(m) && max !== '' ? m : undefined })).data;
      setDays(String(r.days)); setMax(String(r.max));
    } catch (err) { setMsg(errorOf(err, 'Could not save the pull window.')); }
  };
  const pull = async () => {
    setBusy(true); setMsg('');
    try {
      await saveInitial();
      const r = (await inboxApi.backfill({ days: Number(days), max: Number(max) })).data;
      const created = r.sync?.created ?? 0;
      setMsg(`${created} new message${created === 1 ? '' : 's'}${r.classify ? `, ${r.classify.classified} sorted, ${r.classify.awaiting} waiting for you` : ''}${r.sync?.capped ? ' (window capped; pull again or raise the cap)' : ''}.`);
      await onChanged();
    } catch (err) { setMsg(errorOf(err, 'Could not pull.')); }
    finally { setBusy(false); }
  };

  const windowInputs = (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      last <input className={numInput} type="number" min={status.initial.bounds.days.min} max={status.initial.bounds.days.max} value={days} onChange={(e) => setDays(e.target.value)} onBlur={saveInitial} aria-label="days to pull" /> days,
      up to <input className={numInput} type="number" min={status.initial.bounds.max.min} max={status.initial.bounds.max.max} value={max} onChange={(e) => setMax(e.target.value)} onBlur={saveInitial} aria-label="maximum messages" /> messages
    </span>
  );

  const revoke = async () => {
    if (!confirm('Stop reading your inbox? Messages that were never read by the model are deleted; those already in a contact\'s history stay.')) return;
    setBusy(true);
    try { const r = (await inboxApi.revoke()).data; setMsg(`Access revoked. ${r.deletedMessages} message${r.deletedMessages === 1 ? '' : 's'} deleted.`); await onChanged(); }
    catch (err) { setMsg(errorOf(err, 'Could not revoke.')); }
    finally { setBusy(false); }
  };
  const toggle = async () => {
    setBusy(true);
    try { await inboxApi.setSyncEnabled(!status.syncEnabled); await onChanged(); }
    catch (err) { setMsg(errorOf(err, 'Could not change polling.')); }
    finally { setBusy(false); }
  };

  if (!status.connected) {
    return (
      <div className="px-8 py-3 bg-amber-50 border-b border-amber-100 text-xs text-amber-800 space-y-1.5">
        {result === 'denied' && <div className="font-medium">Access was not granted. Nothing was read.</div>}
        {result === 'mismatch' && <div className="font-medium">That Google account is not the Gmail address you send from. Grant access from the same account.</div>}
        {result === 'error' && <div className="font-medium">Google returned an error. Try again.</div>}
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">Let MailTrack read your inbox to sort it and catch replies.</div>
            <div className="text-amber-700 mt-0.5">
              A separate, read-only Google permission. What is read: INBOX mail only (never spam, trash, drafts or sent) — the {windowInputs} at first, then new mail every few minutes. What is stored: sender, subject, and a short excerpt. What the model sees: only categories you allow, and only as untrusted text. Revoke here at any time.
            </div>
            {msg && <div className="mt-1">{msg}</div>}
          </div>
          <a href={authApi.googleReadConnectUrl()} className="px-3 py-1.5 rounded-lg bg-amber-800 hover:bg-amber-900 text-white text-[11px] font-semibold shrink-0 transition">Allow inbox reading</a>
        </div>
      </div>
    );
  }
  return (
    <div className="px-8 py-2.5 bg-[#f8fafc] border-b border-[#eaedf1] flex items-center gap-3 text-xs text-[#64748b]">
      <span className={`size-1.5 rounded-full shrink-0 ${status.syncEnabled ? 'bg-emerald-500' : 'bg-[#94a3b8]'}`} />
      <span>Reading <span className="font-mono text-[#0f172a]">{status.address}</span>{status.syncEnabled ? '' : ' (paused)'}{status.lastSyncAt ? ` · last checked ${ago(status.lastSyncAt)}` : ' · first sync pending'}{!status.initialSyncDone && status.lastSyncAt ? ' · initial sync' : ''}</span>
      {status.lastSyncError && <span className="text-[#991b1b]" title={status.lastSyncError}>· last sync failed</span>}
      <span className="flex-1" />
      {msg && <span>{msg}</span>}
      <span className="text-[#64748b]">{windowInputs}</span>
      <button className={btn} disabled={busy || !status.syncEnabled} onClick={pull} title="Pull mail in this window now; already-stored messages are skipped">{busy ? 'Pulling…' : 'Pull'}</button>
      <button className={btn} disabled={busy} onClick={toggle}>{status.syncEnabled ? 'Pause' : 'Resume'}</button>
      <button className={btn} disabled={busy} onClick={revoke}>Revoke access</button>
    </div>
  );
};

const Row = ({ m, cats, onChanged }: { m: InboundMessageView; cats: CategoryView[]; onChanged: () => Promise<void> }) => {
  const [busy, setBusy] = useState<'correct' | 'process' | 'skip' | null>(null);
  const [msg, setMsg] = useState('');
  const c = m.classification;
  const cat = cats.find((x) => x.key === c?.categoryKey);
  const canProcess = ['awaiting_approval', 'skipped', 'failed', 'unclassified'].includes(m.triage.status);

  const correct = async (key: string) => {
    if (!key || key === c?.categoryKey) return;
    setBusy('correct'); setMsg('');
    try { await inboxApi.correct(m._id, key); await onChanged(); }
    catch (err) { setMsg(errorOf(err, 'Could not change the category.')); }
    finally { setBusy(null); }
  };
  const process = async () => {
    setBusy('process'); setMsg('');
    try {
      const r = (await inboxApi.process(m._id)).data;
      setMsg(r.queued ? 'Queued.' : r.status === 'processed' ? `Read. ${r.extracted ?? 0} item${r.extracted === 1 ? '' : 's'} proposed.` : r.error ?? r.status ?? '');
      await onChanged();
    } catch (err) { setMsg(errorOf(err, 'Could not run the memory step.')); }
    finally { setBusy(null); }
  };
  const skip = async () => {
    setBusy('skip'); setMsg('');
    try { await inboxApi.skip(m._id); await onChanged(); }
    catch (err) { setMsg(errorOf(err, 'Could not skip.')); }
    finally { setBusy(null); }
  };

  return (
    <li className="px-8 py-3 border-b border-[#eaedf1] hover:bg-[#f8fafc]">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-[#0f172a] truncate">{m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address}</span>
            <span className="text-[#94a3b8] shrink-0">{ago(m.internalDate)}</span>
            {m.headers?.hasAttachments && <span className="text-[10px] text-[#64748b]">attachment</span>}
            {m.matchedEmailId && <Link to={`/sent`} className="text-[10px] text-[#1e40af] underline shrink-0" title={`Reply to a tracked email (matched by ${m.matchedBy})`}>reply to tracked</Link>}
          </div>
          <div className="text-xs text-[#0f172a] truncate">{m.subject || '(no subject)'}</div>
          <div className="text-[11px] text-[#64748b] truncate">{m.snippet}</div>
          <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-[#64748b]">
            {c ? (
              <>
                <span>sorted by <span className="text-[#0f172a]">{BACKEND_LABEL[c.backend] ?? c.backend}</span>{c.backend !== 'headers' && c.backend !== 'human' ? ` at ${Math.round(c.confidence * 100)}%` : ''}</span>
                {c.correctedFrom && <span>· was {c.correctedFrom}</span>}
                {c.reason && <span className="truncate" title={c.reason}>· {c.reason}</span>}
                {c.runId && <Link className="underline" to="/runs">· run</Link>}
              </>
            ) : m.triage.error ? <span className="text-[#991b1b]" title={m.triage.error}>{m.triage.error}</span> : <span>not yet sorted</span>}
            {m.triage.error && m.triage.status === 'failed' && <span className="text-[#991b1b]" title={m.triage.error}>· {m.triage.error}</span>}
            {m.emailId && m.contactId && <Link className="underline" to={`/contacts/${m.contactId}`}>· contact</Link>}
            {msg && <span className="text-[#0f172a]">· {msg}</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div className="flex items-center gap-1.5">
            <select
              className="rounded-md border border-[#eaedf1] bg-[#ffffff] px-2 py-1 text-[11px] text-[#0f172a] max-w-[180px]"
              value={c?.categoryKey ?? ''}
              disabled={busy !== null}
              onChange={(e) => correct(e.target.value)}
              title="Change the category. Your correction teaches the classifier."
            >
              {!c && <option value="">choose…</option>}
              {cats.map((x) => <option key={x.key} value={x.key}>{x.name} ({POLICY_LABEL[x.policy]})</option>)}
            </select>
            <span className={`px-2 py-0.5 rounded-md border text-[10px] font-medium ${STATUS_STYLE[m.triage.status]}`} title={m.triage.policyAtDecision ? `category policy at the time: ${m.triage.policyAtDecision}` : undefined}>{STATUS_LABEL[m.triage.status]}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {canProcess && <button className={btn} disabled={busy !== null} onClick={process}>{busy === 'process' ? 'Reading…' : m.triage.status === 'failed' ? 'Retry memory step' : 'Run memory step'}</button>}
            {m.triage.status === 'awaiting_approval' && <button className={btn} disabled={busy !== null} onClick={skip}>Skip</button>}
          </div>
          {cat && m.triage.status === 'awaiting_approval' && <span className="text-[10px] text-[#94a3b8]">"{cat.name}" asks first</span>}
        </div>
      </div>
    </li>
  );
};

export const Triage = () => {
  const [status, setStatus] = useState<InboxStatusView | null>(null);
  const [cats, setCats] = useState<CategoryView[]>([]);
  const [messages, setMessages] = useState<InboundMessageView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<TriageStatus | ''>('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState('');

  const loadHead = useCallback(async () => {
    const [s, c] = await Promise.all([inboxApi.status(), inboxApi.categories()]);
    setStatus(s.data); setCats(c.data);
  }, []);
  const loadList = useCallback(async (before?: string) => {
    const r = (await inboxApi.listMessages({ category: category || undefined, status: statusFilter || undefined, limit: 50, before })).data;
    setMessages((prev) => (before ? [...prev, ...r.messages] : r.messages));
    setNextBefore(r.nextBefore);
  }, [category, statusFilter]);
  const reload = useCallback(async () => {
    try { await Promise.all([loadHead(), loadList()]); setNote(''); }
    catch (err) { setNote(errorOf(err, 'Could not load the inbox.')); }
    finally { setLoading(false); }
  }, [loadHead, loadList]);
  useEffect(() => { reload(); }, [reload]);

  const syncNow = async () => {
    setSyncing(true); setNote('');
    try {
      const r = (await inboxApi.syncNow()).data;
      if (r.queued) setNote('Sync queued; this page refreshes in a moment.');
      else if (r.sync?.skipped) setNote(`Sync skipped: ${r.sync.skipped.replace('_', ' ')}.`);
      else if (r.sync?.error) setNote(`Sync failed: ${r.sync.error}`);
      else setNote(`${r.sync?.created ?? 0} new message${r.sync?.created === 1 ? '' : 's'}${r.classify ? `, ${r.classify.classified} sorted, ${r.classify.awaiting} waiting for you` : ''}${r.sync?.capped ? ' (more remain; sync again)' : ''}.`);
      if (r.queued) setTimeout(reload, 4000); else await reload();
    } catch (err) { setNote(errorOf(err, 'Could not sync.')); }
    finally { setSyncing(false); }
  };

  const tabCls = (active: boolean) => `px-2.5 py-1 rounded-md text-[11px] font-medium border ${active ? 'bg-[#0f172a] text-white border-[#0f172a]' : 'bg-[#ffffff] text-[#64748b] border-[#eaedf1] hover:text-[#0f172a]'}`;

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-8 py-6 border-b border-[#eaedf1]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-[#0f172a]">Triage</h1>
            <p className="text-xs text-[#64748b] mt-1">Your inbox, sorted before the model reads any of it. Header rules first, then a cheap classifier on your key; each category decides whether the memory step runs. Categories and their policies live in <Link className="underline" to="/ai-settings">AI settings</Link>.</p>
          </div>
          {status?.connected && <button className={btn} disabled={syncing} onClick={syncNow}>{syncing ? 'Syncing…' : 'Sync now'}</button>}
        </div>
        {note && <div className="mt-2 text-xs text-[#64748b]">{note}</div>}
        {status && !status.aiEnabled && <div className="mt-2 text-xs text-[#92400e]">AI features are off on this server; mail is fetched and sorted by header rules only.</div>}
      </div>

      {status && <ConsentBanner status={status} onChanged={reload} />}

      {status?.connected && (
        <div className="px-8 py-3 border-b border-[#eaedf1] flex items-center gap-2 flex-wrap">
          <button className={tabCls(category === '')} onClick={() => setCategory('')}>All ({status.counts.total})</button>
          {cats.map((c) => <button key={c.key} className={tabCls(category === c.key)} onClick={() => setCategory(c.key)} title={c.description}>{c.name} ({c.counts.total}{c.counts.awaiting ? `, ${c.counts.awaiting} waiting` : ''})</button>)}
          <span className="flex-1" />
          <select className="rounded-md border border-[#eaedf1] bg-[#ffffff] px-2 py-1 text-[11px] text-[#0f172a]" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TriageStatus | '')}>
            <option value="">any state</option>
            {(Object.keys(STATUS_LABEL) as TriageStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
      )}

      {loading ? (
        <div className="p-8 text-xs text-[#64748b]">Loading…</div>
      ) : !status?.connected ? (
        <div className="p-8 text-xs text-[#64748b]">Nothing is read until you allow it above. Replies to your tracked mail are the first thing this catches; everything else is sorted so you can decide what the model may read.</div>
      ) : messages.length === 0 ? (
        <div className="p-8 text-xs text-[#64748b]">No messages here yet. {status.initialSyncDone ? 'New mail appears within a few minutes.' : 'The first sync reads the last 30 days of your INBOX; press "Sync now" to start it.'}</div>
      ) : (
        <>
          <ul>
            {messages.map((m) => <Row key={m._id} m={m} cats={cats} onChanged={reload} />)}
          </ul>
          {nextBefore && <div className="px-8 py-4"><button className={btn} onClick={() => loadList(nextBefore)}>Load older</button></div>}
        </>
      )}
    </div>
  );
};
