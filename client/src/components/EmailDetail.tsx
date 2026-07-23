import React, { useEffect, useRef } from 'react';
import type { Email } from '../types';
import { StatusBadge } from './StatusBadge';
import { emailsApi } from '../api';
import { useAuth } from '../context/AuthContext';

interface Props {
  email: Email;
  onClose: () => void;
  onOpened?: (id: string) => void;
}

const eventLabel: Record<string, { label: string; color: string; }> = {
  sent: { label: 'Sent to MailTrack Engine', color: '#64748b' },
  delivered: { label: 'Delivered to Inbound MX', color: '#16a34a' },
  opened: { label: 'Opened by Recipient', color: '#2563eb' },
};

export const EmailDetail = ({ email, onClose, onOpened }: Props) => {
  const { user } = useAuth();
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (user && email.recipientId === user._id && email.status !== 'opened') {
      emailsApi
        .markOpened(email._id)
        .then((res) => {
          onOpened?.(res.data._id);
        })
        .catch(() => { });
    }
  }, [email._id, email.recipientId, email.status, user, onOpened]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isReceived = user?._id === email.recipientId;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 bg-[#0f172a]/20 backdrop-blur-xs flex justify-end"
      onClick={(e) => e.target === overlayRef.current && onClose()}
    >
      <div className="w-full max-w-xl bg-[#ffffff] h-full border-l border-[#eaedf1] shadow-2xl flex flex-col text-left">
        {/* Drawer Header */}
        <div className="p-6 border-b border-[#eaedf1] flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-[#0f172a] truncate">
              {email.subject || '(no subject)'}
            </h2>
            <div className="text-xs text-[#94a3b8] flex items-center gap-2 mt-1 font-mono">
              <span>{isReceived ? `From: ${email.from}` : `To: ${email.to}`}</span>
              <span>·</span>
              <span>{new Date(email.createdAt).toLocaleString()}</span>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {!isReceived && <StatusBadge status={email.status} />}
            <button
              onClick={onClose}
              className="text-xs text-[#94a3b8] hover:text-[#0f172a] cursor-pointer"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="text-sm text-[#0f172a] leading-relaxed">
            {email.htmlBody ? (
              <div dangerouslySetInnerHTML={{ __html: email.htmlBody }} />
            ) : (
              <pre className="whitespace-pre-wrap font-sans text-xs text-[#374151]">
                {email.textBody || '(empty message)'}
              </pre>
            )}
          </div>

          {email.attachments && email.attachments.length > 0 && (
            <div className="pt-4 border-t border-[#eaedf1] space-y-2">
              <span className="text-[10px] font-mono font-bold uppercase text-[#94a3b8] tracking-wider block">
                Attachments
              </span>
              <div className="flex flex-wrap gap-2">
                {email.attachments.map((a, i) => (
                  <a
                    key={i}
                    href={a.shareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#eaedf1] bg-[#f8fafc] text-xs font-medium text-[#0f172a] hover:bg-[#f1f5f9] transition"
                  >
                    📄 {a.name}
                  </a>
                ))}
              </div>
            </div>
          )}

          {!isReceived && (
            <div className="pt-4 border-t border-[#eaedf1] space-y-3">
              <span className="text-[10px] font-mono font-bold uppercase text-[#94a3b8] tracking-wider block">
                Delivery Timeline
              </span>
              <div className="space-y-3">
                {email.events.map((evt, i) => {
                  const m = eventLabel[evt.type] ?? { label: evt.type, color: '#64748b' };
                  return (
                    <div key={i} className="flex items-center gap-3">
                      <div className="size-2 rounded-full shrink-0" style={{ background: m.color }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold" style={{ color: m.color }}>
                          {m.label}
                        </div>
                        <div className="text-[10px] font-mono text-[#94a3b8]">
                          {new Date(evt.timestamp).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};