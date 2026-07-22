import { useEffect, useRef, useState } from 'react';
import { bulkEmailApi } from '../api';
import type { BulkJobStatus } from '../types';

function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(/[\n,]+/)
    .map(r => r.trim().toLowerCase())
    .filter(r => r.length > 0 && !seen.has(r) && seen.add(r));
}

export const BulkCompose = () => {
  const [subject, setSubject] = useState('');
  const [recipientsRaw, setRecipientsRaw] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<BulkJobStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const recipients = parseRecipients(recipientsRaw);

  // Polling
  useEffect(() => {
    if (!jobId) return;
    const poll = async () => {
      try {
        const res = await bulkEmailApi.getStatus(jobId);
        setJobStatus(res.data);
        if (res.data.state === 'completed' || res.data.state === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch { /* ignore */ }
    };
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (recipients.length === 0) { setSubmitError('Please enter at least one recipient.'); return; }
    if (!subject.trim()) { setSubmitError('Subject is required.'); return; }

    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await bulkEmailApi.sendBulk({
        recipients,
        subject: subject.trim(),
        htmlBody: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.7;color:#1e293b">${body.replace(/\n/g, '<br/>')}</div>`,
        textBody: body,
      });
      setJobId(res.data.jobId);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Failed to queue email job.';
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    setSubject('');
    setRecipientsRaw('');
    setBody('');
    setJobId(null);
    setJobStatus(null);
    setSubmitError('');
  };

  const isDone = jobStatus?.state === 'completed' || jobStatus?.state === 'failed';
  const progress = jobStatus?.progress ?? 0;

  return (
    <div style={s.page}>
      <div style={s.topBar}>
        <div style={s.pageTitle}>Mass Email</div>
        <div style={s.pageSubtitle}>Send to multiple recipients via background queue</div>
      </div>

      <div style={s.content}>
        {/* Job progress panel */}
        {jobId && jobStatus && (
          <div style={s.progressCard}>
            <div style={s.progressHeader}>
              <span style={{ fontWeight: 600, color: '#1e293b' }}>
                {jobStatus.state === 'completed' ? '✅ Completed' :
                 jobStatus.state === 'failed'    ? '❌ Failed' :
                 jobStatus.state === 'active'    ? '⚙️ Sending…' : '⏳ Queued'}
              </span>
              <span style={{ fontSize: '0.8rem', color: '#64748b' }}>Job {jobId}</span>
            </div>

            {/* Progress bar */}
            <div style={s.progressTrack}>
              <div style={{ ...s.progressFill, width: `${progress}%`, background: jobStatus.state === 'failed' ? '#ef4444' : '#2563eb' }} />
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 4 }}>{progress}% complete</div>

            {/* Result summary */}
            {jobStatus.state === 'completed' && jobStatus.result && (
              <div style={s.resultBox}>
                <div style={s.resultRow}>
                  <span style={{ color: '#16a34a', fontWeight: 700 }}>✓ {jobStatus.result.sent} sent</span>
                  {jobStatus.result.failed > 0 && (
                    <span style={{ color: '#dc2626', fontWeight: 700, marginLeft: 16 }}>✗ {jobStatus.result.failed} failed</span>
                  )}
                </div>
                {jobStatus.result.errors.length > 0 && (
                  <div style={s.errorList}>
                    {jobStatus.result.errors.map((e, i) => (
                      <div key={i} style={{ fontSize: '0.75rem', color: '#7f1d1d', padding: '2px 0' }}>• {e}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {jobStatus.state === 'failed' && jobStatus.failedReason && (
              <div style={{ marginTop: 10, padding: '10px 12px', background: '#fef2f2', borderRadius: 6, border: '1px solid #fecaca', fontSize: '0.83rem', color: '#dc2626' }}>
                {jobStatus.failedReason}
              </div>
            )}

            {isDone && (
              <button onClick={handleReset} style={s.resetBtn}>Send Another</button>
            )}
          </div>
        )}

        {/* Compose form — hide after job is submitted */}
        {!jobId && (
          <form onSubmit={handleSubmit} style={s.form}>
            <div style={s.formGroup}>
              <label style={s.label}>Subject</label>
              <input
                type="text"
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="Email subject"
                style={s.input}
              />
            </div>

            <div style={s.formGroup}>
              <label style={s.label}>
                Recipients
                {recipients.length > 0 && (
                  <span style={s.recipientCount}>{recipients.length} recipient{recipients.length !== 1 ? 's' : ''}</span>
                )}
              </label>
              <textarea
                value={recipientsRaw}
                onChange={e => setRecipientsRaw(e.target.value)}
                placeholder="Enter one email address per line (or comma-separated)"
                style={{ ...s.input, minHeight: 100, resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>

            <div style={s.formGroup}>
              <label style={s.label}>Message</label>
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                placeholder="Write your message…"
                style={{ ...s.input, minHeight: 180, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
              />
            </div>

            {submitError && (
              <div style={s.errorBanner}>{submitError}</div>
            )}

            <div style={s.formFooter}>
              <button
                type="submit"
                disabled={submitting || recipients.length === 0}
                style={s.submitBtn}
              >
                {submitting ? 'Queuing…' : `📨 Send to ${recipients.length || '…'} recipients`}
              </button>
              {recipients.length > 500 && (
                <span style={{ fontSize: '0.78rem', color: '#dc2626', marginLeft: 12 }}>Max 500 recipients</span>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', height: '100%' },
  topBar: { padding: '20px 28px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 },
  pageTitle: { fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' },
  pageSubtitle: { fontSize: '0.8rem', color: '#94a3b8', marginTop: 2 },
  content: { flex: 1, overflowY: 'auto', padding: '24px 28px', maxWidth: 680 },
  form: { display: 'flex', flexDirection: 'column', gap: 20 },
  formGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: '0.8rem', fontWeight: 600, color: '#374151', display: 'flex', alignItems: 'center', gap: 8 },
  recipientCount: { padding: '2px 8px', background: '#eff6ff', color: '#2563eb', borderRadius: 20, fontSize: '0.72rem', fontWeight: 700 },
  input: {
    padding: '10px 14px', borderRadius: 8, border: '1px solid #e2e8f0',
    fontSize: '0.92rem', outline: 'none', width: '100%', boxSizing: 'border-box' as const,
    fontFamily: 'inherit', color: '#1e293b',
  },
  errorBanner: {
    padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca',
    borderRadius: 8, color: '#dc2626', fontSize: '0.83rem',
  },
  formFooter: { display: 'flex', alignItems: 'center', paddingTop: 4 },
  submitBtn: {
    padding: '11px 24px', borderRadius: 8, border: 'none',
    background: '#2563eb', color: '#fff', fontWeight: 700,
    fontSize: '0.9rem', cursor: 'pointer', fontFamily: 'inherit',
  },
  progressCard: {
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
    padding: '20px 24px', marginBottom: 24,
  },
  progressHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14,
  },
  progressTrack: {
    height: 8, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden',
  },
  progressFill: {
    height: '100%', borderRadius: 4, transition: 'width 0.4s ease',
  },
  resultBox: {
    marginTop: 14, padding: '12px 14px', background: '#f8fafc',
    border: '1px solid #e2e8f0', borderRadius: 8,
  },
  resultRow: { fontSize: '0.92rem', marginBottom: 6 },
  errorList: {
    maxHeight: 160, overflowY: 'auto', marginTop: 8,
    padding: '8px 10px', background: '#fff5f5', borderRadius: 6,
    border: '1px solid #fecaca',
  },
  resetBtn: {
    marginTop: 16, padding: '9px 20px', borderRadius: 8, border: 'none',
    background: '#2563eb', color: '#fff', fontWeight: 600,
    fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'inherit',
  },
};
