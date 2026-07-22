import { useEffect, useState, useCallback } from 'react';
import { emailsApi } from '../api';
import type { Email } from '../types';
import { EmailDetail } from '../components/EmailDetail';

export const Inbox = () => {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Email | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try { const res = await emailsApi.getInbox(); setEmails(res.data); }
    finally { if (!silent) setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const id = setInterval(() => load(true), 5000); return () => clearInterval(id); }, [load]);

  const handleSelect = async (email: Email) => {
    const res = await emailsApi.getById(email._id);
    setSelected(res.data);
  };

  return (
    <div style={s.page}>
      <div style={s.toolbar}>
        <div>
          <div style={s.pageTitle}>Inbox</div>
          <div style={s.pageSubtitle}>{emails.length} message{emails.length !== 1 ? 's' : ''} · auto-updating every 5s</div>
        </div>
      </div>

      {loading ? (
        <div style={s.spinner}>Loading…</div>
      ) : emails.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyIcon}>📥</div>
          <div style={s.emptyTitle}>Inbox is empty</div>
          <div style={s.emptySub}>Emails sent to your inbound address will appear here.<br/>Requires SendGrid Inbound Parse + MX record setup.</div>
        </div>
      ) : (
        <div style={s.list}>
          {emails.map((email) => (
            <InboxRow key={email._id} email={email} onClick={() => handleSelect(email)} />
          ))}
        </div>
      )}

      {selected && <EmailDetail email={selected} onClose={() => setSelected(null)} />}
    </div>
  );
};

const InboxRow = ({ email, onClick }: { email: Email; onClick: () => void }) => {
  const [hovered, setHovered] = useState(false);
  return (
    <div style={{ ...s.row, background: hovered ? '#f8fafc' : '#fff' }}
      onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div style={{ ...s.avatar, background: '#f0fdf4', color: '#16a34a' }}>
        {email.from.charAt(0).toUpperCase()}
      </div>
      <div style={s.rowBody}>
        <div style={s.rowTop}>
          <span style={s.rowFrom}>{email.from}</span>
          <span style={s.rowDate}>{formatDate(email.createdAt)}</span>
        </div>
        <div style={s.rowSubject}>{email.subject || '(no subject)'}</div>
      </div>
    </div>
  );
};

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
  spinner: { padding: 40, textAlign: 'center', color: '#94a3b8' },
  list: { flex: 1, display: 'flex', flexDirection: 'column' },
  row: { display: 'flex', alignItems: 'center', padding: '14px 24px', borderBottom: '1px solid #f8fafc', cursor: 'pointer', transition: 'background 0.1s', gap: 12 },
  avatar: { width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.85rem', flexShrink: 0 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTop: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  rowFrom: { fontSize: '0.85rem', fontWeight: 600, color: '#0f172a' },
  rowDate: { fontSize: '0.72rem', color: '#94a3b8', flexShrink: 0 },
  rowSubject: { fontSize: '0.82rem', color: '#64748b', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, color: '#94a3b8' },
  emptyIcon: { fontSize: '2.5rem', marginBottom: 12, opacity: 0.3 },
  emptyTitle: { fontSize: '1rem', fontWeight: 600, color: '#64748b', marginBottom: 6 },
  emptySub: { fontSize: '0.85rem', textAlign: 'center', lineHeight: 1.6 },
};
