import React, { useEffect, useRef, useState } from 'react';
import { bulkEmailApi } from '../api';
import type { BulkJobStatus } from '../types';

function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(/[\n,]+/)
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r.length > 0 && !seen.has(r) && seen.add(r));
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

  useEffect(() => {
    if (!jobId) return;
    const poll = async () => {
      try {
        const res = await bulkEmailApi.getStatus(jobId);
        setJobStatus(res.data);
        if (res.data.state === 'completed' || res.data.state === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        /* ignore */
      }
    };
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [jobId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (recipients.length === 0) {
      setSubmitError('Please enter at least one recipient.');
      return;
    }
    if (!subject.trim()) {
      setSubmitError('Subject is required.');
      return;
    }

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
      const msg =
        (err as { response?: { data?: { message?: string; }; }; })?.response?.data?.message ||
        'Failed to queue email job.';
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
    <div className="flex-1 flex flex-col bg-[#ffffff]">
      <div className="px-8 py-5 border-b border-[#eaedf1] bg-[#ffffff]">
        <h1 className="text-lg font-semibold text-[#0f172a] tracking-tight">Mass Email Dispatch</h1>
        <p className="text-xs text-[#64748b] mt-0.5">Send asynchronous batch emails via Redis &amp; BullMQ worker queues</p>
      </div>

      <div className="flex-1 p-8 overflow-y-auto max-w-3xl">
        {jobId && jobStatus && (
          <div className="p-6 rounded-2xl border border-[#eaedf1] bg-[#f8fafc] mb-8 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-[#0f172a]">
                {jobStatus.state === 'completed'
                  ? '✓ Completed'
                  : jobStatus.state === 'failed'
                    ? '✗ Failed'
                    : jobStatus.state === 'active'
                      ? '⚙ Sending batch…'
                      : '⏳ Queued in BullMQ'}
              </span>
              <span className="text-xs font-mono text-[#64748b]">Job ID: {jobId}</span>
            </div>

            <div className="w-full bg-[#eaedf1] h-2 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${jobStatus.state === 'failed' ? 'bg-red-500' : 'bg-[#F17463]'
                  }`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="text-xs font-mono text-[#64748b] text-right">{progress}% complete</div>

            {jobStatus.state === 'completed' && jobStatus.result && (
              <div className="p-4 bg-[#ffffff] border border-[#eaedf1] rounded-xl space-y-2">
                <div className="text-xs font-semibold text-[#0f172a]">
                  Sent: <span className="text-emerald-600">{jobStatus.result.sent}</span>
                  {jobStatus.result.failed > 0 && (
                    <span className="text-red-600 ml-3">Failed: {jobStatus.result.failed}</span>
                  )}
                </div>
                {jobStatus.result.errors.length > 0 && (
                  <div className="max-h-32 overflow-y-auto p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 space-y-1 font-mono">
                    {jobStatus.result.errors.map((e, i) => (
                      <div key={i}>• {e}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {isDone && (
              <button
                onClick={handleReset}
                className="px-4 py-2 rounded-xl bg-[#171717] hover:bg-[#000000] text-white text-xs font-semibold cursor-pointer"
              >
                Send Another Batch
              </button>
            )}
          </div>
        )}

        {!jobId && (
          <form onSubmit={handleSubmit} className="space-y-5 text-left">
            <div>
              <label className="block text-xs font-semibold text-[#0f172a] mb-1.5">
                Subject Line
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Announcement subject"
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#eaedf1] bg-[#f8fafc] text-sm text-[#0f172a] outline-none focus:border-[#0f172a] focus:bg-[#ffffff] transition"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-[#0f172a]">Recipients</label>
                {recipients.length > 0 && (
                  <span className="text-[10px] font-mono font-bold px-2 py-0.5 bg-blue-50 text-blue-600 border border-blue-200 rounded-full">
                    {recipients.length} address{recipients.length !== 1 ? 'es' : ''}
                  </span>
                )}
              </div>
              <textarea
                value={recipientsRaw}
                onChange={(e) => setRecipientsRaw(e.target.value)}
                placeholder="Enter one email per line or comma-separated"
                className="w-full h-28 p-3 rounded-xl border border-[#eaedf1] bg-[#f8fafc] text-sm text-[#0f172a] outline-none focus:border-[#0f172a] focus:bg-[#ffffff] transition font-mono text-xs"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#0f172a] mb-1.5">
                Message Body
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write your email content here…"
                className="w-full h-44 p-3.5 rounded-xl border border-[#eaedf1] bg-[#f8fafc] text-sm text-[#0f172a] outline-none focus:border-[#0f172a] focus:bg-[#ffffff] transition leading-relaxed"
              />
            </div>

            {submitError && (
              <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs font-medium text-red-600">
                {submitError}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || recipients.length === 0}
              className="py-2.5 px-6 rounded-xl bg-[#171717] hover:bg-[#000000] text-white text-sm font-semibold transition active:scale-[0.98] cursor-pointer"
            >
              {submitting ? 'Queueing Batch…' : `Dispatch to ${recipients.length || '…'} recipients`}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};