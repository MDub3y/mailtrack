import { useEffect, useRef } from 'react';
import type { Email } from '../types';
import { StatusBadge } from './StatusBadge';
import { emailsApi } from '../api';
import { useAuth } from '../context/AuthContext';

interface Props {
  email: Email;
  onClose: () => void;
  onOpened?: (id: string) => void;
}

const eventLabel: Record<string, { icon: string; label: string; color: string }> = {
  sent:      { icon: '📤', label: 'Sent',                color: '#64748b' },
  delivered: { icon: '✅', label: 'Delivered',           color: '#16a34a' },
  opened:    { icon: '👁️', label: 'Opened by recipient', color: '#2563eb' },
};

export const EmailDetail = ({ email, onClose, onOpened }: Props) => {
  const { user } = useAuth();
  const overlayRef = useRef<HTMLDivElement>(null);

  // If the current user is the RECIPIENT and the email hasn't been marked
  // opened yet — mark it now. This is what triggers the sender's status update.
  useEffect(() => {
    if (user && email.recipientId === user._id && email.status !== 'opened') {
      emailsApi.markOpened(email._id).then((res) => {
        onOpened?.(res.data._id);
      }).catch(() => {/* ignore */});
    }
  }, [email._id, email.recipientId, email.status, user, onOpened]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isReceived = user?._id === email.recipientId;

  return (
    <div ref={overlayRef} style={s.overlay} onClick={(e) => e.target === overlayRef.current && onClose()}>
      <div style={s.panel}>
        {/* Header */}
        <div style={s.header}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={s.subject}>{email.subject || '(no subject)'}</div>
            <div style={s.meta}>
              <span>{isReceived ? `From: ${email.from}` : `To: ${email.to}`}</span>
              <span style={s.dot}>·</span>
              <span>{new Date(email.createdAt).toLocaleString()}</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {!isReceived && <StatusBadge status={email.status} />}
            <button style={s.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        <div style={s.body}>
          {/* Email body */}
          <div style={s.bodyContent}>
            {email.htmlBody ? (
              <div dangerouslySetInnerHTML={{ __html: email.htmlBody }} />
            ) : (
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: '#374151' }}>
                {email.textBody || '(empty)'}
              </pre>
            )}
          </div>

          {/* Attachments */}
          {email.attachments && email.attachments.length > 0 && (
            <div style={{ padding: '14px 20px', borderTop: '1px solid #f1f5f9' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                Attachments
              </div>
              {email.attachments.map((a, i) => (
                <a key={i} href={a.shareUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, textDecoration: 'none', color: '#1e293b', fontSize: '0.85rem', marginRight: 8, marginBottom: 8 }}>
                  📄 {a.name}
                </a>
              ))}
            </div>
          )}

          {/* Timeline — only show to sender */}
          {!isReceived && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Delivery Timeline</div>
              <div style={s.timeline}>
                {email.events.map((evt, i) => {
                  const m = eventLabel[evt.type] ?? { icon: '•', label: evt.type, color: '#64748b' };
                  return (
                    <div key={i} style={s.timelineRow}>
                      <div style={{ ...s.dot2, background: m.color }} />
                      <div>
                        <div style={{ fontSize: '0.88rem', fontWeight: 600, color: m.color }}>
                          {m.icon} {m.label}
                        </div>
                        <div style={s.timelineTime}>{new Date(evt.timestamp).toLocaleString()}</div>
                      </div>
                    </div>
                  );
                })}

                {/* Pending opened indicator */}
                {email.status !== 'opened' && (
                  <div style={s.timelineRow}>
                    <div style={{ ...s.dot2, background: '#e2e8f0' }} />
                    <div style={{ fontSize: '0.85rem', color: '#cbd5e1', fontStyle: 'italic' }}>
                      Waiting for recipient to open…
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', justifyContent: 'flex-end', zIndex: 400 },
  panel: { background: '#fff', width: '100%', maxWidth: 560, height: '100%', display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 40px rgba(0,0,0,0.15)' },
  header: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 20px 16px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 },
  subject: { fontSize: '1rem', fontWeight: 700, color: '#0f172a', marginBottom: 4 },
  meta: { fontSize: '0.78rem', color: '#94a3b8', display: 'flex', gap: 4, flexWrap: 'wrap' },
  dot: { opacity: 0.4 },
  closeBtn: { background: 'none', border: 'none', color: '#94a3b8', fontSize: '1rem', padding: '4px 6px', borderRadius: 6, cursor: 'pointer' },
  body: { flex: 1, overflowY: 'auto' },
  bodyContent: { padding: '20px', borderBottom: '1px solid #f8fafc', fontSize: '0.95rem', lineHeight: 1.7, color: '#1e293b' },
  section: { padding: '16px 20px' },
  sectionTitle: { fontSize: '0.7rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 },
  timeline: { display: 'flex', flexDirection: 'column', gap: 16 },
  timelineRow: { display: 'flex', gap: 12, alignItems: 'flex-start' },
  dot2: { width: 8, height: 8, borderRadius: '50%', marginTop: 5, flexShrink: 0 },
  timelineTime: { fontSize: '0.75rem', color: '#94a3b8', marginTop: 2 },
};
