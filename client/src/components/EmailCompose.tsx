import React, { useState, useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { emailsApi, documentsApi } from '../api';
import type { Email, PlatformUser, DocumentAttachment } from '../types';

interface FormData {
  to: string;
  subject: string;
  body: string;
}

interface Props {
  onSent: (email: Email) => void;
  onClose: () => void;
}

export const EmailCompose = ({ onSent, onClose }: Props) => {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<FormData>();
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
          <span className="text-xs font-semibold text-[#0f172a]">New Tracked Message</span>
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