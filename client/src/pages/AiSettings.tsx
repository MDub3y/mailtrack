import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { aiApi } from '../api';
import type { AiSettingsView, AiConnectionTest, ProviderName } from '../types';

// Bring your own key. Keys are write-only here: the server stores them
// encrypted and only ever reports "configured" plus the last four characters.
// Any model works — pick a provider, then name the model as the provider
// names it. Free OpenRouter models and a local Ollama both count.

const PROVIDERS: Array<{ name: ProviderName; label: string; hint: string; placeholder: string; example: string }> = [
  { name: 'anthropic', label: 'Anthropic', hint: 'Native API. Exact token counts, explicit prompt caching, structured outputs.', placeholder: 'sk-ant-…', example: 'anthropic:claude-sonnet-4-6' },
  { name: 'openai', label: 'OpenAI', hint: 'Chat Completions API with JSON-schema outputs and automatic prefix caching.', placeholder: 'sk-…', example: 'openai:gpt-5-mini' },
  { name: 'openrouter', label: 'OpenRouter', hint: 'Hundreds of models behind one key, including free ones. Reports exact cost per call.', placeholder: 'sk-or-v1-…', example: 'openrouter:meta-llama/llama-3.3-70b-instruct:free' },
  { name: 'custom', label: 'Custom endpoint', hint: 'Any OpenAI-compatible URL: Ollama, LM Studio, Groq, Together, a company gateway. Key optional.', placeholder: 'key, if the endpoint needs one', example: 'custom:llama3.2' },
];

const inputCls = 'w-full rounded-lg border border-[#eaedf1] bg-[#ffffff] px-3 py-2 text-xs text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:border-[#F17463]';
const btnCls = 'px-3 py-1.5 rounded-lg border border-[#eaedf1] bg-[#ffffff] text-xs font-medium text-[#0f172a] hover:bg-[#f1f5f9] disabled:opacity-50';

export const AiSettings = () => {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [error, setError] = useState('');
  const [keyDrafts, setKeyDrafts] = useState<Partial<Record<ProviderName, string>>>({});
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [primary, setPrimary] = useState('');
  const [extractor, setExtractor] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, AiConnectionTest>>({});

  const load = async () => {
    try {
      const res = await aiApi.getSettings();
      setView(res.data);
      setCustomBaseUrl(res.data.customBaseUrl ?? '');
      setPrimary(res.data.models.primary ?? '');
      setExtractor(res.data.models.extractor ?? '');
    } catch {
      setError('Could not load AI settings.');
    }
  };
  useEffect(() => { load(); }, []);

  const errMsg = (err: unknown, fallback: string) =>
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

  const saveKey = async (p: ProviderName) => {
    const value = keyDrafts[p]?.trim();
    if (!value) return;
    setSaving(p); setError('');
    try {
      const res = await aiApi.updateSettings({ keys: { [p]: value }, ...(p === 'custom' && customBaseUrl ? { customBaseUrl } : {}) });
      setView(res.data);
      setKeyDrafts((d) => ({ ...d, [p]: '' }));
    } catch (err) { setError(errMsg(err, 'Could not save key.')); }
    finally { setSaving(null); }
  };

  const removeKey = async (p: ProviderName) => {
    setSaving(p); setError('');
    try { setView((await aiApi.updateSettings({ keys: { [p]: null } })).data); }
    catch (err) { setError(errMsg(err, 'Could not remove key.')); }
    finally { setSaving(null); }
  };

  const saveCustomUrl = async () => {
    setSaving('customUrl'); setError('');
    try { setView((await aiApi.updateSettings({ customBaseUrl: customBaseUrl || null })).data); }
    catch (err) { setError(errMsg(err, 'Could not save endpoint URL.')); }
    finally { setSaving(null); }
  };

  const saveModels = async () => {
    setSaving('models'); setError('');
    try { setView((await aiApi.updateSettings({ models: { primary: primary || null, extractor: extractor || null } })).data); }
    catch (err) { setError(errMsg(err, 'Could not save model choices.')); }
    finally { setSaving(null); }
  };

  const test = async (label: string, model?: string) => {
    setTesting(label);
    try {
      const res = await aiApi.testConnection(model);
      setTestResult((r) => ({ ...r, [label]: res.data }));
    } catch (err) {
      const data = (err as { response?: { data?: AiConnectionTest } })?.response?.data;
      setTestResult((r) => ({ ...r, [label]: data ?? { ok: false, message: 'Request failed' } }));
    } finally { setTesting(null); }
  };

  const TestBadge = ({ label }: { label: string }) => {
    const t = testResult[label];
    if (!t) return null;
    return (
      <div className={`mt-2 text-[11px] ${t.ok ? 'text-[#166534]' : 'text-[#991b1b]'}`}>
        {t.ok
          ? <>Connected via {t.provider} · {t.model} · {t.usage?.input ?? 0} in / {t.usage?.output ?? 0} out · {t.costUsd ? `$${t.costUsd.toFixed(5)}` : 'cost unknown'}{t.degraded?.length ? ` · without ${t.degraded.join(', ')}` : ''}{t.runId && <> · <Link className="underline" to="/runs">see run</Link></>}</>
          : <>{t.message}{t.runId && <> · <Link className="underline" to="/runs">see run</Link></>}</>}
      </div>
    );
  };

  if (!view) return <div className="p-8 text-xs text-[#64748b]">{error || 'Loading…'}</div>;

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-8 py-6 border-b border-[#eaedf1]">
        <h1 className="text-lg font-semibold text-[#0f172a]">AI settings</h1>
        <p className="text-xs text-[#64748b] mt-1">
          Bring your own key. Calls are made on your account, with your model choice. Keys are stored encrypted and never shown again.
          {view.serverKeysAllowed && <span className="ml-2 text-[#92400e]">This server also allows its own keys as a fallback (development mode).</span>}
        </p>
        {error && <div className="mt-2 text-xs text-[#991b1b]">{error}</div>}
      </div>

      <div className="px-8 py-6 max-w-3xl space-y-8">
        <section>
          <h2 className="text-sm font-semibold text-[#0f172a] mb-3">Providers</h2>
          <div className="space-y-3">
            {PROVIDERS.map((p) => {
              const state = view.providers[p.name];
              return (
                <div key={p.name} className="rounded-lg border border-[#eaedf1] bg-[#f8fafc] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-[#0f172a]">{p.label}</div>
                      <div className="text-[11px] text-[#64748b]">{p.hint}</div>
                    </div>
                    <div className="text-[11px] whitespace-nowrap">
                      {state.configured
                        ? <span className="px-1.5 py-0.5 rounded border bg-[#dcfce7] text-[#166534] border-[#bbf7d0]">key ····{state.last4}</span>
                        : <span className="px-1.5 py-0.5 rounded border bg-[#f1f5f9] text-[#475569] border-[#e2e8f0]">not configured</span>}
                    </div>
                  </div>

                  {p.name === 'custom' && (
                    <div className="mt-3 flex gap-2">
                      <input className={inputCls} placeholder="https://your-endpoint/v1 (e.g. http://localhost:11434/v1 for Ollama)" value={customBaseUrl} onChange={(e) => setCustomBaseUrl(e.target.value)} />
                      <button className={btnCls} disabled={saving === 'customUrl'} onClick={saveCustomUrl}>Save URL</button>
                    </div>
                  )}

                  <div className="mt-3 flex gap-2">
                    <input
                      type="password"
                      autoComplete="off"
                      className={inputCls}
                      placeholder={state.configured ? 'paste a new key to replace' : p.placeholder}
                      value={keyDrafts[p.name] ?? ''}
                      onChange={(e) => setKeyDrafts((d) => ({ ...d, [p.name]: e.target.value }))}
                    />
                    <button className={btnCls} disabled={saving === p.name || !keyDrafts[p.name]?.trim()} onClick={() => saveKey(p.name)}>Save key</button>
                    {state.configured && <button className={btnCls} disabled={saving === p.name} onClick={() => removeKey(p.name)}>Remove</button>}
                  </div>

                  <div className="mt-2 flex items-center gap-2 text-[11px] text-[#64748b]">
                    <span>Example model: <code className="font-mono">{p.example}</code></span>
                    <button className={btnCls} disabled={testing === p.name} onClick={() => test(p.name, p.example)}>Test with example</button>
                  </div>
                  <TestBadge label={p.name} />
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-[#0f172a] mb-1">Models per task</h2>
          <p className="text-[11px] text-[#64748b] mb-3">
            Written as <code className="font-mono">provider:model</code>. Leave blank to use the server default. Features a model lacks (structured output, tools) are dropped automatically and shown on the run.
          </p>
          <div className="space-y-3">
            <label className="block">
              <div className="text-xs text-[#0f172a] mb-1">Primary <span className="text-[#64748b]">(drafting, briefs, investigation)</span></div>
              <input className={inputCls} placeholder={view.defaults.primary} value={primary} onChange={(e) => setPrimary(e.target.value)} />
            </label>
            <label className="block">
              <div className="text-xs text-[#0f172a] mb-1">Extractor <span className="text-[#64748b]">(memory extraction on every sent email; cheap and frequent)</span></div>
              <input className={inputCls} placeholder={view.defaults.extractor} value={extractor} onChange={(e) => setExtractor(e.target.value)} />
            </label>
            <div className="flex gap-2">
              <button className={btnCls} disabled={saving === 'models'} onClick={saveModels}>Save models</button>
              <button className={btnCls} disabled={testing === 'primary'} onClick={() => test('primary', 'primary')}>Test primary</button>
              <button className={btnCls} disabled={testing === 'extractor'} onClick={() => test('extractor', 'extractor')}>Test extractor</button>
            </div>
            <TestBadge label="primary" />
            <TestBadge label="extractor" />
          </div>
        </section>
      </div>
    </div>
  );
};
