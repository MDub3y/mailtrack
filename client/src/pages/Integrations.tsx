import { useCallback, useEffect, useState } from 'react';
import { integrationsApi, contactsApi, downloadBlob } from '../api';
import type { IntegrationsView, ApiTokenView, WebhookDeliveryView } from '../types';

// The doors: signals in (a webhook any system can post to), decisions out
// (signed deliveries to your endpoints), memory for other agents (a
// read-only MCP server), and memory that can leave (markdown export).

const btn = 'px-2.5 py-1 rounded-md border border-[#eaedf1] bg-[#ffffff] text-[11px] font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';
const input = 'w-full rounded-lg border border-[#eaedf1] bg-[#ffffff] px-3 py-1.5 text-xs text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:border-[#F17463]';
const code = 'block w-full rounded-lg border border-[#eaedf1] bg-[#f8fafc] px-3 py-2 font-mono text-[11px] text-[#0f172a] whitespace-pre-wrap break-all';
const errorOf = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

const Section = ({ title, blurb, children }: { title: string; blurb: string; children: React.ReactNode }) => (
  <section>
    <h2 className="text-sm font-semibold text-[#0f172a] mb-1">{title}</h2>
    <p className="text-[11px] text-[#64748b] mb-3">{blurb}</p>
    {children}
  </section>
);

export const Integrations = () => {
  const [view, setView] = useState<IntegrationsView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<{ signal: boolean; queue: boolean }>({ signal: true, queue: true });
  const [newSecret, setNewSecret] = useState<{ id: string; secret: string } | null>(null);
  const [mcpToken, setMcpToken] = useState<string | null>(null);
  const [tokens, setTokens] = useState<ApiTokenView[]>([]);
  const [tokenName, setTokenName] = useState('');
  const [deliveries, setDeliveries] = useState<{ id: string; rows: WebhookDeliveryView[] } | null>(null);

  const load = useCallback(async () => {
    try { setView((await integrationsApi.get()).data); setTokens((await integrationsApi.listTokens()).data); setError(''); }
    catch (err) { setError(errorOf(err, 'Could not load integrations.')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(key); setNote('');
    try { await fn(); await load(); if (ok) setNote(ok); }
    catch (err) { setNote(errorOf(err, 'That did not work.')); }
    finally { setBusy(null); }
  };

  if (error) return <div className="p-8 text-xs text-[#991b1b]">{error}</div>;
  if (!view) return <div className="p-8 text-xs text-[#64748b]">Loading…</div>;

  const mcpConfig = `claude mcp add --transport http proofbox ${view.mcp.url} --header "Authorization: Bearer ${mcpToken ?? '<token>'}"`;

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-8 py-6 border-b border-[#eaedf1]">
        <h1 className="text-lg font-semibold text-[#0f172a]">Integrations</h1>
        <p className="text-xs text-[#64748b] mt-1">Signals in, decisions out, memory for other agents, and memory that can leave. Nothing here can send email or change what is remembered.</p>
        {note && <div className="mt-2 text-xs text-[#64748b]">{note}</div>}
      </div>

      <div className="px-8 py-6 max-w-3xl space-y-8">
        <Section title="Signals in" blurb="Any system that knows a contact's email address can add to their timeline: a calendar tool, a form, a support desk, a billing event. The secret is in the URL; rotate it if it leaks. Payloads are stored as sent and shown to a model only as untrusted text.">
          <code className={code}>{view.inbound.url}</code>
          <code className={`${code} mt-2`}>{`POST ${view.inbound.url}\nContent-Type: application/json\n\n{ "contactEmail": "priya@example.com", "id": "evt-123", "at": "2026-09-24T09:00:00Z", "payload": { "kind": "demo_booked", "summary": "Booked a demo for Thursday" } }`}</code>
          <div className="mt-2"><button className={btn} disabled={busy !== null} onClick={() => { if (confirm('Rotate the inbound secret? Systems using the old URL will get 404.')) run('rotate', async () => { await integrationsApi.rotateInbound(); }, 'Rotated.'); }}>Rotate secret</button></div>
        </Section>

        <Section title="Decisions out" blurb="Your endpoints receive a signed JSON envelope for every stored signal, with its integrity verdict attached, and for follow-through items that appear or resolve. Verify the X-Proofbox-Signature header (HMAC-SHA256 over `timestamp.body` with the secret shown once at creation). After 20 consecutive failures an endpoint pauses itself.">
          {view.outbound.length === 0 ? <div className="text-[11px] text-[#94a3b8] mb-2">No endpoints yet.</div> : (
            <ul className="space-y-2 mb-3">
              {view.outbound.map((e) => (
                <li key={e._id} className="rounded-lg border border-[#eaedf1] bg-[#ffffff] px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-[#0f172a] truncate flex-1">{e.url}</span>
                    <span className="text-[10px] text-[#64748b]">{e.events.join(', ')}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${e.enabled ? 'bg-[#dcfce7] text-[#166534] border-[#bbf7d0]' : 'bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]'}`}>{e.enabled ? 'on' : 'paused'}</span>
                    <button className={btn} disabled={busy !== null} onClick={() => run(e._id, async () => { const r = (await integrationsApi.testOutbound(e._id)).data; if (!r.ok) throw { response: { data: { message: `Ping failed: ${r.error ?? r.status}` } } }; }, 'Ping delivered.')}>Ping</button>
                    <button className={btn} disabled={busy !== null} onClick={() => run(e._id, async () => { await integrationsApi.setOutboundEnabled(e._id, !e.enabled); })}>{e.enabled ? 'Pause' : 'Resume'}</button>
                    <button className={btn} disabled={busy !== null} onClick={() => run(e._id, async () => { setDeliveries({ id: e._id, rows: (await integrationsApi.deliveries(e._id)).data }); })}>Log</button>
                    <button className={btn} disabled={busy !== null} onClick={() => run(e._id, async () => { const r = (await integrationsApi.redeliver(e._id)).data; setNote(`Redelivered ${r.ok} of ${r.attempted} failed deliveries from the last 7 days.`); })}>Redeliver failed</button>
                    <button className={btn} disabled={busy !== null} onClick={() => { if (confirm('Remove this endpoint?')) run(e._id, async () => { await integrationsApi.removeOutbound(e._id); }); }}>Remove</button>
                  </div>
                  <div className="text-[10px] text-[#94a3b8] mt-1">
                    {e.lastDeliveryAt ? `last delivery ${new Date(e.lastDeliveryAt).toLocaleString()} · ${e.lastStatus ?? 'no response'}${e.lastError ? ` · ${e.lastError}` : ''}` : 'no deliveries yet'}{e.failures ? ` · ${e.failures} consecutive failure${e.failures === 1 ? '' : 's'}` : ''}
                  </div>
                  {newSecret?.id === e._id && <div className="mt-2 text-[11px] text-[#92400e]">Signing secret (shown once): <code className="font-mono break-all">{newSecret.secret}</code></div>}
                  {deliveries?.id === e._id && (
                    <ul className="mt-2 space-y-0.5 text-[10px] text-[#64748b]">
                      {deliveries.rows.length === 0 && <li>No deliveries recorded yet.</li>}
                      {deliveries.rows.map((d) => <li key={d._id}><span className={d.status === 'ok' ? 'text-[#166534]' : 'text-[#991b1b]'}>{d.status}</span> · {d.event} · {new Date(d.lastAttemptAt).toLocaleString()} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}{d.lastError ? ` · ${d.lastError}` : ''}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/proofbox" />
            <label className="text-[11px] text-[#64748b] flex items-center gap-1"><input type="checkbox" checked={events.signal} onChange={(e) => setEvents((v) => ({ ...v, signal: e.target.checked }))} /> signals</label>
            <label className="text-[11px] text-[#64748b] flex items-center gap-1"><input type="checkbox" checked={events.queue} onChange={(e) => setEvents((v) => ({ ...v, queue: e.target.checked }))} /> queue</label>
            <button className={btn} disabled={busy !== null || !/^https?:\/\//.test(url) || (!events.signal && !events.queue)} onClick={() => run('add', async () => {
              const r = (await integrationsApi.addOutbound({ url: url.trim(), events: [...(events.signal ? ['signal' as const] : []), ...(events.queue ? ['queue' as const] : [])] })).data;
              setNewSecret({ id: r._id, secret: r.secret }); setUrl('');
            }, 'Endpoint added. Copy the signing secret now; it is not shown again.')}>Add endpoint</button>
          </div>
        </Section>

        <Section title="Memory for other agents (MCP)" blurb="A read-only MCP server with four tools: contact_brief, contact_timeline, queue, search_commitments. Any assistant you already use can ask where things stand with a contact and get an answer with provenance. It never writes, never sends, and never returns another person's email body.">
          <code className={code}>{view.mcp.url}</code>
          <div className="mt-2 flex items-center gap-2">
            <input className={input} value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="Token name, e.g. Claude Desktop on my laptop" />
            <button className={btn} disabled={busy !== null} onClick={() => run('token', async () => { const r = (await integrationsApi.createToken(tokenName.trim() || 'MCP client')).data; setMcpToken(r.token); setTokenName(''); }, 'Token created. Copy it now; it is not shown again. Revoke it below at any time.')}>Create a read token</button>
          </div>
          {tokens.length > 0 && (
            <ul className="mt-2 space-y-1">
              {tokens.map((t) => (
                <li key={t._id} className="text-[11px] text-[#0f172a] flex items-center gap-2">
                  <span className="font-mono text-[10px] text-[#64748b]">{t.prefix}…</span>
                  <span>{t.name}</span>
                  <span className="text-[10px] text-[#94a3b8]">created {new Date(t.createdAt).toLocaleDateString()}{t.lastUsedAt ? ` · last used ${new Date(t.lastUsedAt).toLocaleString()}` : ' · never used'}{t.revokedAt ? ' · revoked' : ''}</span>
                  {!t.revokedAt && <button className={btn} disabled={busy !== null} onClick={() => run(t._id, async () => { await integrationsApi.revokeToken(t._id); })}>Revoke</button>}
                </li>
              ))}
            </ul>
          )}
          <code className={`${code} mt-2`}>{mcpConfig}</code>
        </Section>

        <Section title="Export" blurb="One markdown file: every contact's brief, each remembered item with its source and date, and the timeline of what people actually did. Memory that can leave is memory you own. Single contacts export from their own page.">
          <button className={btn} disabled={busy !== null} onClick={() => run('export', async () => { const r = await contactsApi.exportAll(); downloadBlob(r.data, `proofbox-memory-${new Date().toISOString().slice(0, 10)}.md`); })}>Download all contacts (.md)</button>
        </Section>
      </div>
    </div>
  );
};
