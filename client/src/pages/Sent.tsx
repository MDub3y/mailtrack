import { useEffect, useRef, useState, useCallback } from 'react';
import { emailsApi } from '../api';
import type { Email, EmailStatus } from '../types';
import { StatusBadge } from '../components/StatusBadge';
import { EmailCompose } from '../components/EmailCompose';
import { EmailDetail } from '../components/EmailDetail';
import { Toast, type ToastMessage } from '../components/Toast';

const STATUS_RANK: Record<EmailStatus, number> = { sent: 0, delivered: 1, opened: 2 };

export const Sent = () => {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [selected, setSelected] = useState<Email | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const prevStatusRef = useRef<Record<string, EmailStatus>>({});

  const addToast = useCallback((text: string, type: ToastMessage['type'] = 'success') => {
    setToasts((prev) => [...prev, { id: Date.now(), text, type }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const fetchEmails = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await emailsApi.getSent();
      const fresh = res.data;

      // Detect status upgrades and show toast
      fresh.forEach((email) => {
        const prev = prevStatusRef.current[email._id];
        if (prev && STATUS_RANK[email.status] > STATUS_RANK[prev]) {
          const labels: Record<EmailStatus, string> = {
            sent: 'Sent', delivered: 'Delivered', opened: 'Opened',
          };
          addToast(`✓ "${email.subject}" — ${labels[email.status]}`, 'success');
        }
        prevStatusRef.current[email._id] = email.status;
      });

      setEmails(fresh);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [addToast]);

  // Initial load
  useEffect(() => { fetchEmails(); }, [fetchEmails]);

  // Auto-poll every 4 seconds for status updates
  useEffect(() => {
    const id = setInterval(() => fetchEmails(true), 4000);
    return () => clearInterval(id);
  }, [fetchEmails]);

  // Immediately re-fetch when the user switches back to this tab.
  // Chrome throttles setInterval to ~60s in background tabs, so without this
  // the status would appear stale after opening the preview in another tab.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchEmails(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchEmails]);

  const handleSent = (email: Email) => {
    prevStatusRef.current[email._id] = email.status;
    setEmails((prev) => [email, ...prev]);
    addToast(`📤 "${email.subject}" sent`, 'info');
  };

  const handleSelect = async (email: Email) => {
    const res = await emailsApi.getById(email._id);
    setSelected(res.data);
  };

  // When recipient opens the email, update the badge immediately in the list
  const handleOpened = (emailId: string) => {
    setEmails((prev) => prev.map((e) =>
      e._id === emailId
        ? { ...e, status: 'opened', events: [...e.events, { type: 'opened', timestamp: new Date().toISOString() }] }
        : e
    ));
    addToast('👁 Email was opened by the recipient', 'success');
  };

  return (
    <div style={s.page}>
      {/* Toolbar */}
      <div style={s.toolbar}>
        <div>
          <div style={s.pageTitle}>Sent</div>
          <div style={s.pageSubtitle}>
            {emails.length} email{emails.length !== 1 ? 's' : ''} · auto-updating every 4s
          </div>
        </div>
        <button style={s.composeBtn} onClick={() => setComposing(true)}>
          ✎ Compose
        </button>
      </div>

      {/* List */}
      {loading ? (
        <SkeletonList />
      ) : emails.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={s.list}>
          {emails.map((email) => (
            <EmailRow key={email._id} email={email} onClick={() => handleSelect(email)} />
          ))}
        </div>
      )}

      {composing && <EmailCompose onSent={handleSent} onClose={() => setComposing(false)} />}
      {selected && <EmailDetail email={selected} onClose={() => setSelected(null)} onOpened={handleOpened} />}
      <Toast toasts={toasts} onRemove={removeToast} />
    </div>
  );
};

const EmailRow = ({ email, onClick }: { email: Email; onClick: () => void }) => {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ ...s.row, background: hovered ? '#f8fafc' : '#fff' }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={s.avatar}>{email.to.charAt(0).toUpperCase()}</div>
      <div style={s.rowBody}>
        <div style={s.rowTop}>
          <span style={s.rowTo}>{email.to}</span>
          <span style={s.rowDate}>{formatDate(email.createdAt)}</span>
        </div>
        <div style={s.rowSubject}>{email.subject || '(no subject)'}</div>
      </div>
      <div style={{ marginLeft: 12, flexShrink: 0 }}>
        <StatusBadge status={email.status} size="sm" />
      </div>
    </div>
  );
};

const SkeletonList = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
    {[1, 2, 3].map((i) => (
      <div key={i} style={{ ...s.row, background: '#fff' }}>
        <div style={{ ...s.avatar, background: '#f1f5f9' }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ height: 12, width: '40%', background: '#f1f5f9', borderRadius: 4 }} />
          <div style={{ height: 10, width: '60%', background: '#f1f5f9', borderRadius: 4 }} />
        </div>
      </div>
    ))}
  </div>
);

const EmptyState = () => (
  <div style={s.empty}>
    <div style={s.emptyIcon}>✉</div>
    <div style={s.emptyTitle}>No sent emails yet</div>
    <div style={s.emptySub}>Click Compose to send your first tracked email</div>
  </div>
);

const formatDate = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const s: Record<string, React.CSSProperties> = {
  page: { flex: 1, display: 'flex', flexDirection: 'column' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: '1px solid #f1f5f9' },
  pageTitle: { fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' },
  pageSubtitle: { fontSize: '0.75rem', color: '#94a3b8', marginTop: 2 },
  composeBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 600, fontSize: '0.85rem' },
  list: { flex: 1, display: 'flex', flexDirection: 'column' },
  row: { display: 'flex', alignItems: 'center', padding: '14px 24px', borderBottom: '1px solid #f8fafc', cursor: 'pointer', transition: 'background 0.1s', gap: 12 },
  avatar: { width: 36, height: 36, borderRadius: '50%', background: '#dbeafe', color: '#1d4ed8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.85rem', flexShrink: 0 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTop: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  rowTo: { fontSize: '0.85rem', fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowDate: { fontSize: '0.72rem', color: '#94a3b8', flexShrink: 0 },
  rowSubject: { fontSize: '0.82rem', color: '#64748b', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, color: '#94a3b8' },
  emptyIcon: { fontSize: '2.5rem', marginBottom: 12, opacity: 0.3 },
  emptyTitle: { fontSize: '1rem', fontWeight: 600, color: '#64748b', marginBottom: 6 },
  emptySub: { fontSize: '0.85rem', textAlign: 'center' },
};
