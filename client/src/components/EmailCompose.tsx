import { useState, useRef, useEffect } from 'react';
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
  const { register, handleSubmit, setValue, watch, formState: { errors, isSubmitting }, reset } = useForm<FormData>();
  const [suggestions, setSuggestions] = useState<PlatformUser[]>([]);
  const [sendError, setSendError] = useState('');
  const [attachments, setAttachments] = useState<DocumentAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const toValue = watch('to', '');
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Search platform users as the user types in the To field
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (toValue.length < 2) { setSuggestions([]); return; }

    searchTimeout.current = setTimeout(async () => {
      try {
        const res = await emailsApi.searchUsers(toValue);
        setSuggestions(res.data);
      } catch { setSuggestions([]); }
    }, 300);
  }, [toValue]);

  const pickSuggestion = (u: PlatformUser) => {
    setValue('to', u.emailAddress);
    setSuggestions([]);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so the same file can be re-selected
    e.target.value = '';
    setUploading(true);
    setSendError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await documentsApi.upload(formData);
      const doc = uploadRes.data;
      // Auto-create share with no password and no expiry
      const shareRes = await documentsApi.createShare(doc._id, {});
      setAttachments(prev => [...prev, {
        documentId: doc._id,
        name: doc.originalName,
        shareUrl: shareRes.data.shareUrl,
      }]);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? 'Failed to attach file.';
      setSendError(msg);
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
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
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? 'Failed to send email.';
      setSendError(msg);
    }
  };

  return (
    <div style={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        <div style={s.header}>
          <span style={s.headerTitle}>New Message</span>
          <button style={s.iconBtn} onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)}>
          {/* To field with autocomplete */}
          <div style={s.fieldRow}>
            <label style={s.fieldLabel}>To</label>
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                style={{ ...s.fieldInput, ...(errors.to ? { borderBottom: '2px solid #ef4444' } : {}) }}
                type="text"
                placeholder="name@platform or start typing…"
                autoComplete="off"
                {...register('to', { required: true })}
              />
              {suggestions.length > 0 && (
                <div style={s.dropdown}>
                  {suggestions.map((u) => (
                    <div key={u._id} style={s.dropdownItem} onClick={() => pickSuggestion(u)}>
                      <div style={s.suggestionAvatar}>{u.name.charAt(0).toUpperCase()}</div>
                      <div>
                        <div style={s.suggestionName}>{u.name}</div>
                        <div style={s.suggestionEmail}>{u.emailAddress}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div style={s.divider} />

          <div style={s.fieldRow}>
            <label style={s.fieldLabel}>Subject</label>
            <input
              style={{ ...s.fieldInput, ...(errors.subject ? { borderBottom: '2px solid #ef4444' } : {}) }}
              type="text" placeholder="Subject"
              {...register('subject', { required: true })}
            />
          </div>
          <div style={s.divider} />

          <textarea style={s.body} placeholder="Write your message…" {...register('body', { required: true })} />

          {/* Attachment chips */}
          {attachments.length > 0 && (
            <div style={s.attachmentList}>
              {attachments.map((a, i) => (
                <div key={i} style={s.chip}>
                  <span style={{ fontSize: '0.75rem' }}>📄</span>
                  <span style={{ fontSize: '0.8rem', color: '#1e293b', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <button type="button" onClick={() => removeAttachment(i)} style={s.chipRemove}>✕</button>
                </div>
              ))}
            </div>
          )}

          {sendError && <div style={s.errorBanner}>{sendError}</div>}

          {/* Hidden file input */}
          <input
            type="file"
            accept=".pdf"
            style={{ display: 'none' }}
            ref={fileInputRef}
            onChange={handleFileChange}
          />

          <div style={s.footer}>
            <button type="submit" disabled={isSubmitting || uploading} style={s.sendBtn}>
              {isSubmitting ? 'Sending…' : '✈ Send'}
            </button>
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              style={s.attachBtn}
            >
              {uploading ? 'Uploading…' : '📎 Attach PDF'}
            </button>
            <button type="button" onClick={onClose} style={s.discardBtn}>Discard</button>
          </div>
        </form>
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 24, zIndex: 500 },
  modal: { background: '#fff', borderRadius: 12, width: 520, boxShadow: '0 24px 80px rgba(0,0,0,0.25)', overflow: 'visible', display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#1e293b', borderRadius: '12px 12px 0 0' },
  headerTitle: { color: '#f1f5f9', fontWeight: 600, fontSize: '0.9rem' },
  iconBtn: { background: 'none', border: 'none', color: '#94a3b8', fontSize: '1rem', padding: 4, lineHeight: 1, cursor: 'pointer' },
  fieldRow: { display: 'flex', alignItems: 'flex-start', padding: '0 16px', minHeight: 46 },
  fieldLabel: { width: 56, fontSize: '0.8rem', color: '#94a3b8', fontWeight: 500, flexShrink: 0, paddingTop: 14 },
  fieldInput: { flex: 1, border: 'none', outline: 'none', fontSize: '0.9rem', padding: '12px 0', color: '#0f172a', background: 'transparent', width: '100%' },
  divider: { height: 1, background: '#f1f5f9', margin: '0 16px' },
  body: { width: '100%', minHeight: 200, border: 'none', outline: 'none', resize: 'vertical', padding: '14px 16px', fontSize: '0.92rem', lineHeight: 1.6, color: '#0f172a', fontFamily: 'inherit', boxSizing: 'border-box' },
  attachmentList: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 16px 0' },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 20 },
  chipRemove: { background: 'none', border: 'none', color: '#94a3b8', fontSize: '0.7rem', padding: '0 0 0 2px', cursor: 'pointer', lineHeight: 1 },
  footer: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderTop: '1px solid #f1f5f9' },
  sendBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '9px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 600, fontSize: '0.88rem', cursor: 'pointer' },
  attachBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#374151', fontSize: '0.85rem', cursor: 'pointer' },
  discardBtn: { marginLeft: 'auto', padding: '9px 14px', borderRadius: 8, border: 'none', background: 'none', color: '#94a3b8', fontSize: '0.85rem', cursor: 'pointer' },
  errorBanner: { margin: '0 16px 8px', padding: '10px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#dc2626', fontSize: '0.83rem' },
  dropdown: { position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 100, overflow: 'hidden' },
  dropdownItem: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' },
  suggestionAvatar: { width: 32, height: 32, borderRadius: '50%', background: '#dbeafe', color: '#1d4ed8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.85rem', flexShrink: 0 },
  suggestionName: { fontSize: '0.88rem', fontWeight: 600, color: '#0f172a' },
  suggestionEmail: { fontSize: '0.75rem', color: '#94a3b8' },
};
