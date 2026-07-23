import { useEffect, useRef, useState, useCallback } from 'react';
import { emailsApi } from '../api';
import type { Email, EmailStatus } from '../types';
import { StatusBadge } from '../components/StatusBadge';
import { EmailCompose } from '../components/EmailCompose';
import { EmailDetail } from '../components/EmailDetail';
import { Toast, type ToastMessage } from '../components/Toast';

const STATUS_RANK: Record<EmailStatus, number> = { sent: 0, delivered: 1, opened: 2, failed: 2 };

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

      fresh.forEach((email) => {
        const prev = prevStatusRef.current[email._id];
        if (prev && STATUS_RANK[email.status] > STATUS_RANK[prev]) {
          const labels: Record<EmailStatus, string> = {
            sent: 'Sent', delivered: 'Delivered', opened: 'Opened', failed: 'Failed',
          };
          addToast(`"${email.subject}" — ${labels[email.status]}`, email.status === 'failed' ? 'error' : 'success');
        }
        prevStatusRef.current[email._id] = email.status;
      });

      setEmails(fresh);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { fetchEmails(); }, [fetchEmails]);

  useEffect(() => {
    const id = setInterval(() => fetchEmails(true), 4000);
    return () => clearInterval(id);
  }, [fetchEmails]);

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
    addToast(`"${email.subject}" sent`, 'info');
  };

  const handleSelect = async (email: Email) => {
    const res = await emailsApi.getById(email._id);
    setSelected(res.data);
  };

  return (
    <div className="flex-1 flex flex-col bg-[#ffffff]">
      {/* Header Bar */}
      <div className="px-8 py-5 border-b border-[#eaedf1] flex items-center justify-between bg-[#ffffff]">
        <div>
          <h1 className="text-lg font-semibold text-[#0f172a] tracking-tight">Sent Feeds</h1>
          <p className="text-xs text-[#64748b] mt-0.5">
            {emails.length} message{emails.length !== 1 ? 's' : ''} · auto-updating every 4s
          </p>
        </div>
        <button
          onClick={() => setComposing(true)}
          className="px-4 py-2 rounded-xl bg-[#171717] hover:bg-[#000000] text-white text-xs font-semibold transition active:scale-[0.98] flex items-center gap-2 cursor-pointer shadow-sm"
        >
          <svg className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Compose Email
        </button>
      </div>

      {/* Main List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <SkeletonList />
        ) : emails.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="divide-y divide-[#eaedf1]">
            {emails.map((email) => (
              <EmailRow key={email._id} email={email} onClick={() => handleSelect(email)} />
            ))}
          </div>
        )}
      </div>

      {composing && <EmailCompose onSent={handleSent} onClose={() => setComposing(false)} />}
      {selected && <EmailDetail email={selected} onClose={() => setSelected(null)} />}
      <Toast toasts={toasts} onRemove={removeToast} />
    </div>
  );
};

const EmailRow = ({ email, onClick }: { email: Email; onClick: () => void; }) => {
  return (
    <div
      onClick={onClick}
      className="flex items-center px-8 py-4 bg-[#ffffff] hover:bg-[#f8fafc] cursor-pointer transition-colors gap-4"
    >
      <div className="size-9 rounded-full bg-[#f1f5f9] text-[#0f172a] font-semibold text-xs flex items-center justify-center shrink-0 border border-[#eaedf1]">
        {email.to.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold text-[#0f172a] truncate">{email.to}</span>
          <span className="text-[11px] text-[#94a3b8] font-mono shrink-0">{formatDate(email.createdAt)}</span>
        </div>
        <div className="text-xs text-[#64748b] truncate mt-0.5">{email.subject || '(no subject)'}</div>
      </div>
      <div className="shrink-0">
        <StatusBadge status={email.status} size="sm" />
      </div>
    </div>
  );
};

const SkeletonList = () => (
  <div className="divide-y divide-[#eaedf1]">
    {[1, 2, 3].map((i) => (
      <div key={i} className="flex items-center px-8 py-4 gap-4 animate-pulse">
        <div className="size-9 rounded-full bg-[#f1f5f9] shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-3 bg-[#f1f5f9] rounded w-1/3" />
          <div className="h-2.5 bg-[#f1f5f9] rounded w-1/2" />
        </div>
      </div>
    ))}
  </div>
);

const EmptyState = () => (
  <div className="h-96 flex flex-col items-center justify-center text-center p-8">
    <div className="size-12 rounded-2xl border border-[#eaedf1] bg-[#f8fafc] flex items-center justify-center text-[#94a3b8] mb-3">
      <svg className="size-6" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    </div>
    <div className="text-sm font-semibold text-[#0f172a]">No sent emails yet</div>
    <div className="text-xs text-[#64748b] mt-1 max-w-xs">
      Compose your first tracked email to receive instant read receipts and timeline updates.
    </div>
  </div>
);

const formatDate = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};