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
    try {
      const res = await emailsApi.getInbox();
      setEmails(res.data);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => load(true), 5000);
    return () => clearInterval(id);
  }, [load]);

  const handleSelect = async (email: Email) => {
    const res = await emailsApi.getById(email._id);
    setSelected(res.data);
  };

  return (
    <div className="flex-1 flex flex-col bg-[#ffffff]">
      <div className="px-8 py-5 border-b border-[#eaedf1] flex items-center justify-between bg-[#ffffff]">
        <div>
          <h1 className="text-lg font-semibold text-[#0f172a] tracking-tight">Inbox</h1>
          <p className="text-xs text-[#64748b] mt-0.5">
            {emails.length} message{emails.length !== 1 ? 's' : ''} · auto-updating every 5s
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-8 text-center text-xs font-mono text-[#94a3b8]">Loading inbox…</div>
        ) : emails.length === 0 ? (
          <div className="h-96 flex flex-col items-center justify-center text-center p-8">
            <div className="size-12 rounded-2xl border border-[#eaedf1] bg-[#f8fafc] flex items-center justify-center text-[#94a3b8] mb-3">
              <svg className="size-6" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
            </div>
            <div className="text-sm font-semibold text-[#0f172a]">Inbox is empty</div>
            <div className="text-xs text-[#64748b] mt-1 max-w-sm leading-relaxed">
              Emails sent to your inbound address will appear here automatically.
            </div>
          </div>
        ) : (
          <div className="divide-y divide-[#eaedf1]">
            {emails.map((email) => (
              <InboxRow key={email._id} email={email} onClick={() => handleSelect(email)} />
            ))}
          </div>
        )}
      </div>

      {selected && <EmailDetail email={selected} onClose={() => setSelected(null)} />}
    </div>
  );
};

const InboxRow = ({ email, onClick }: { email: Email; onClick: () => void; }) => {
  return (
    <div
      onClick={onClick}
      className="flex items-center px-8 py-4 bg-[#ffffff] hover:bg-[#f8fafc] cursor-pointer transition-colors gap-4"
    >
      <div className="size-9 rounded-full bg-emerald-50 text-emerald-600 font-semibold text-xs flex items-center justify-center shrink-0 border border-emerald-200">
        {email.from.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold text-[#0f172a] truncate">{email.from}</span>
          <span className="text-[11px] text-[#94a3b8] font-mono shrink-0">{formatDate(email.createdAt)}</span>
        </div>
        <div className="text-xs text-[#64748b] truncate mt-0.5">{email.subject || '(no subject)'}</div>
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