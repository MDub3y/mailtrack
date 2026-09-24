import React, { useState, useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { emailsApi, documentsApi, aiApi } from '../api';
import type { Email, PlatformUser, DocumentAttachment, DraftResult } from '../types';

interface FormData {
  to: string;
  subject: string;
  body: string;
}

// When opened from "Draft follow-up", the window is prefilled and shows a
// receipt of exactly what the model used. Sending is the ordinary send;
// the draft's proposal id rides along so the edit becomes a label.
export interface ComposeInitial {
  to: string;
  subject?: string;
  body?: string;
  draft?: DraftResult;
}

interface Props {
  onSent: (email: Email) => void;
  onClose: () => void;
  initial?: ComposeInitial;
}

export const EmailCompose = ({ onSent, onClose, initial }: Props) => {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { isSubmitting },
    reset,
  } = useForm<FormData>({ defaultValues: { to: initial?.to ?? '', subject: initial?.subject ?? '', body: initial?.body ?? '' } });
  // "Include this and redraft" (doc/05, Elevation 5): the user becomes the
  // context engineer for the item that matters; the draft is regenerated
  // with that item forced into context and the receipt replaced.
  const [draft, setDraft] = useState<DraftResult | undefined>(initial?.draft);
  const [redrafting, setRedrafting] = useState(false);
  const [redraftMsg, setRedraftMsg] = useState('');
  const draftReq = draft?.request;
  const redraft = async (memoryId: string) => {
    if (!draftReq) return;
    setRedrafting(true); setRedraftMsg('');
    try {
      const res = await aiApi.draft({ ...draftReq, includeMemoryIds: [...new Set([...(draftReq.includeMemoryIds ?? []), memoryId])] });
      setDraft(res.data);
      setValue('subject', res.data.draft.subject);
      setValue('body', res.data.draft.body);
    } catch (err) {
      setRedraftMsg((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Could not redraft.');
    } finally { setRedrafting(false); }
  };
  const [showReceipt, setShowReceipt] = useState(true);
  const [suggestions, setSuggestions] = useState<PlatformUser[]>([]);
  const [sendError, setSendError] = useState('');
  const [attachments, setAttachments] = useState<DocumentAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const toValue = watch('to', '');
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (toValue.length < 2) {
      setSuggestions([]);
      return;
    }

    searchTimeout.current = setTimeout(async () => {
      try {
        const res = await emailsApi.searchUsers(toValue);
        setSuggestions(res.data);
      } catch {
        setSuggestions([]);
      }
    }, 300);
  }, [toValue]);

  const pickSuggestion = (u: PlatformUser) => {
    setValue('to', u.emailAddress);
    setSuggestions([]);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploading(true);
    setSendError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await documentsApi.upload(formData);
      const doc = uploadRes.data;
      const shareRes = await documentsApi.createShare(doc._id, {});
      setAttachments((prev) => [
        ...prev,
        {
          documentId: doc._id,
          name: doc.originalName,
          shareUrl: shareRes.data.shareUrl,
        },
      ]);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string; }; }; })?.response?.data?.message ??
        'Failed to attach file.';
      setSendError(msg);
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const onSubmit = async (data: FormData) => {
    setSendError('');
    try {
      const res = await emailsApi.send({
        to: data.to,
        subject: data.subject,
        htmlBody: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.7;color:#1e293b">${data.body.replace(/\n/g, '<br/>')}</div>`,
        textBody: data.body,
        attachments,
        draftProposalId: initial?.draft?.proposalId,
      });
      onSent(res.data);
      reset();
      setAttachments([]);
      onClose();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string; }; }; })?.response?.data?.message ??
        'Failed to send email.';
      setSendError(msg);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-[#0f172a]/20 backdrop-blur-xs flex items-end justify-end p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg bg-[#ffffff] border border-[#eaedf1] rounded-2xl shadow-2xl overflow-hidden flex flex-col text-left">
        <div className="px-5 py-3.5 border-b border-[#eaedf1] bg-[#f8fafc] flex items-center justify-between">
          <span className="text-xs font-semibold text-[#0f172a]">{initial?.draft ? 'Drafted follow-up · edit before sending' : 'New Tracked Message'}</span>
          <button onClick={onClose} className="text-xs text-[#94a3b8] hover:text-[#0f172a] cursor-pointer">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="p-5 space-y-3">
          <div className="relative">
            <label className="text-[11px] font-semibold text-[#64748b] uppercase tracking-wider block mb-1">
              To
            </label>
            <input
              type="text"
              placeholder="recipient@domain.com"
              autoComplete="off"
              {...register('to', { required: true })}
              className="w-full px-3 py-2 rounded-lg border border-[#eaedf1] text-xs text-[#0f172a] outline-none focus:border-[#0f172a]"
            />
            {suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-[#ffffff] border border-[#eaedf1] rounded-xl shadow-lg max-h-40 overflow-y-auto">
                {suggestions.map((u) => (
                  <div
                    key={u._id}
                    onClick={() => pickSuggestion(u)}
                    className="p-2.5 hover:bg-[#f8fafc] cursor-pointer flex items-center gap-3 border-b border-[#eaedf1] last:border-b-0"
                  >
                    <div className="size-7 rounded-full bg-[#f1f5f9] text-[#0f172a] text-xs font-bold flex items-center justify-center">
                      {u.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-[#0f172a]">{u.name}</div>
                      <div className="text-[11px] text-[#64748b]">{u.emailAddress}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-[11px] font-semibold text-[#64748b] uppercase tracking-wider block mb-1">
              Subject
            </label>
            <input
              type="text"
              placeholder="Subject line"
              {...register('subject', { required: true })}
              className="w-full px-3 py-2 rounded-lg border border-[#eaedf1] text-xs text-[#0f172a] outline-none focus:border-[#0f172a]"
            />
          </div>

          {draft && (
            <div className="rounded-lg border border-[#eaedf1] bg-[#f8fafc] text-[11px]">
              <button type="button" onClick={() => setShowReceipt((v) => !v)} className="w-full px-3 py-2 flex items-center justify-between text-left">
                <span className="font-semibold text-[#0f172a]">What the model used</span>
                <span className="text-[#64748b]">
                  {draft.model}
                  {draft.receipt.cacheReadTokens > 0 && ` · ${draft.receipt.cacheReadTokens} tok cached`}
                  {draft.degraded.length > 0 && ` · without ${draft.degraded.join(', ')}`}
                  {' '}{showReceipt ? '▾' : '▸'}
                </span>
              </button>
              {showReceipt && (
                <div className="px-3 pb-3 space-y-2">
                  <div>
                    <div className="text-[#64748b] mb-1">Memory relied on</div>
                    {draft.usedMemory.length === 0
                      ? <div className="text-[#94a3b8]">None. The draft is general.</div>
                      : <ul className="space-y-0.5">{draft.usedMemory.map((m) => <li key={m.id} className="text-[#0f172a]">{m.text.replace(/^\[[a-f0-9]{24}\]\s*/i, '')}</li>)}</ul>}
                  </div>
                  <div>
                    <div className="text-[#64748b] mb-1">Emails relied on</div>
                    {draft.usedEmails.length === 0
                      ? <div className="text-[#94a3b8]">None.</div>
                      : <ul className="space-y-0.5">{draft.usedEmails.map((e) => <li key={e.id}><Link to={`/sent?email=${e.id}`} className="underline text-[#0f172a]">{e.date} {e.subject}</Link></li>)}</ul>}
                  </div>
                  {draft.gaps.length > 0 && (
                    <div>
                      <div className="text-[#92400e] mb-1">Before you send</div>
                      <ul className="space-y-0.5">{draft.gaps.map((g, i) => <li key={i} className="text-[#0f172a]">{g}</li>)}</ul>
                    </div>
                  )}
                  {(() => {
                    const dropped = draft.receipt.sections.flatMap((s) => s.dropped ?? s.droppedItemIds.map((id) => ({ id, reason: 'budget' as const })));
                    if (dropped.length === 0) return null;
                    const REASON: Record<string, string> = { budget: 'left out for space', proposed_not_accepted: 'proposed, not yet accepted', kind_cap: 'over the per-kind cap', low_confidence: 'low confidence', superseded: 'superseded' };
                    return (
                      <div>
                        <div className="text-[#64748b] mb-1">Left out</div>
                        <ul className="space-y-0.5">
                          {dropped.slice(0, 12).map((d) => (
                            <li key={d.id} className="flex items-center gap-2 text-[#0f172a]">
                              <span className="flex-1 min-w-0 truncate">{d.label ?? d.id} <span className="text-[#94a3b8]">· {REASON[d.reason] ?? d.reason}</span></span>
                              {/^[a-f0-9]{24}$/i.test(d.id) && draftReq && <button type="button" className="text-[10px] underline text-[#0f172a] shrink-0" disabled={redrafting} onClick={() => redraft(d.id)}>include and redraft</button>}
                            </li>
                          ))}
                        </ul>
                        {redraftMsg && <div className="text-[#991b1b] mt-1">{redraftMsg}</div>}
                      </div>
                    );
                  })()}
                  <div className="text-[#64748b]">
                    {draft.receipt.totalInputTokens} input tokens{draft.receipt.exact ? '' : ' (estimate)'} · <Link to="/runs" className="underline">open run</Link>
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <textarea
              placeholder="Write your email content…"
              {...register('body', { required: true })}
              className="w-full h-40 p-3 rounded-lg border border-[#eaedf1] text-xs text-[#0f172a] outline-none focus:border-[#0f172a] resize-none leading-relaxed"
            />
          </div>

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {attachments.map((a, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-xs text-blue-800"
                >
                  <span className="truncate max-w-[150px]">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    className="text-xs text-blue-500 hover:text-blue-900 cursor-pointer"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {sendError && (
            <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-600">
              {sendError}
            </div>
          )}

          <input
            type="file"
            accept=".pdf"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileChange}
          />

          <div className="flex items-center justify-between pt-2 border-t border-[#eaedf1]">
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={isSubmitting || uploading}
                className="px-4 py-2 rounded-xl bg-[#171717] hover:bg-[#000000] text-white text-xs font-semibold cursor-pointer"
              >
                {isSubmitting ? 'Sending…' : 'Send Email'}
              </button>
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-2 rounded-xl border border-[#eaedf1] bg-[#ffffff] hover:bg-[#f8fafc] text-xs font-medium text-[#0f172a] cursor-pointer"
              >
                {uploading ? 'Uploading…' : 'Attach PDF'}
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-[#94a3b8] hover:text-[#0f172a] cursor-pointer"
            >
              Discard
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};