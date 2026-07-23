import { useEffect, useRef, useState } from 'react';
import { documentsApi } from '../api';
import type { PlatformDocument, ShareTokenInfo } from '../types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface SharePanelProps {
  doc: PlatformDocument;
  onClose: () => void;
}

const SharePanel = ({ doc, onClose }: SharePanelProps) => {
  const [password, setPassword] = useState('');
  const [expiresInHours, setExpiresInHours] = useState<number | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [newLink, setNewLink] = useState('');
  const [shares, setShares] = useState<ShareTokenInfo[]>([]);
  const [loadingShares, setLoadingShares] = useState(true);
  const [copied, setCopied] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    documentsApi
      .listShares(doc._id)
      .then((res) => setShares(res.data))
      .catch(() => { })
      .finally(() => setLoadingShares(false));
  }, [doc._id]);

  const handleCreate = async () => {
    setCreating(true);
    setCreateError('');
    setNewLink('');
    try {
      const res = await documentsApi.createShare(doc._id, {
        password: password || undefined,
        expiresInHours,
      });
      setNewLink(res.data.shareUrl);
      const listRes = await documentsApi.listShares(doc._id);
      setShares(listRes.data);
      setPassword('');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string; }; }; })?.response?.data?.message ||
        'Failed to create link.';
      setCreateError(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (tokenId: string) => {
    try {
      await documentsApi.revokeShare(doc._id, tokenId);
      setShares((prev) => prev.filter((s) => s._id !== tokenId));
    } catch {
      /* ignore */
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="mt-3 ml-12 p-5 bg-[#f8fafc] border border-[#eaedf1] rounded-xl text-left space-y-4">
      <div className="flex items-center justify-between pb-3 border-b border-[#eaedf1]">
        <span className="text-xs font-semibold text-[#0f172a]">Share Link: {doc.originalName}</span>
        <button onClick={onClose} className="text-xs text-[#94a3b8] hover:text-[#0f172a] cursor-pointer">
          ✕
        </button>
      </div>

      <div className="space-y-3">
        <span className="text-[10px] font-mono font-bold uppercase text-[#94a3b8] tracking-wider block">
          Create New Share Link
        </span>
        <div className="flex gap-2">
          <input
            type="password"
            placeholder="Password (optional)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="flex-1 px-3 py-1.5 rounded-lg border border-[#eaedf1] bg-[#ffffff] text-xs text-[#0f172a] outline-none"
          />
          <select
            value={expiresInHours ?? ''}
            onChange={(e) => setExpiresInHours(e.target.value ? Number(e.target.value) : undefined)}
            className="px-3 py-1.5 rounded-lg border border-[#eaedf1] bg-[#ffffff] text-xs text-[#0f172a] outline-none cursor-pointer"
          >
            <option value="">No expiration</option>
            <option value="24">24 hours</option>
            <option value="168">7 days</option>
            <option value="720">30 days</option>
          </select>
        </div>

        {createError && <div className="text-xs text-red-500 font-medium">{createError}</div>}

        <button
          onClick={handleCreate}
          disabled={creating}
          className="px-3.5 py-1.5 rounded-lg bg-[#171717] hover:bg-[#000000] text-white text-xs font-medium cursor-pointer"
        >
          {creating ? 'Creating…' : '+ Generate Link'}
        </button>

        {newLink && (
          <div className="flex items-center gap-2 p-2.5 bg-blue-50 border border-blue-200 rounded-lg">
            <span className="flex-1 text-xs text-blue-900 truncate font-mono">{newLink}</span>
            <button
              onClick={() => copyToClipboard(newLink)}
              className="px-2.5 py-1 rounded bg-[#ffffff] border border-blue-200 text-xs font-medium text-blue-700 hover:bg-blue-100 cursor-pointer"
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>

      <div className="pt-3 border-t border-[#eaedf1] space-y-3">
        <span className="text-[10px] font-mono font-bold uppercase text-[#94a3b8] tracking-wider block">
          Active Links
        </span>
        {loadingShares ? (
          <div className="text-xs text-[#94a3b8]">Loading links…</div>
        ) : shares.length === 0 ? (
          <div className="text-xs text-[#94a3b8]">No active share links created yet.</div>
        ) : (
          <div className="space-y-2">
            {shares.map((s) => (
              <div key={s._id} className="flex items-center gap-2 p-2.5 bg-[#ffffff] border border-[#eaedf1] rounded-lg">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-mono text-[#0f172a] truncate">{s.shareUrl}</div>
                  <div className="text-[11px] text-[#94a3b8] mt-0.5">
                    {s.accessCount} views
                    {s.requiresPassword && ' · Password protected'}
                    {s.expiresAt && ` · Expires ${new Date(s.expiresAt).toLocaleDateString()}`}
                  </div>
                </div>
                <button
                  onClick={() => copyToClipboard(s.shareUrl)}
                  className="px-2.5 py-1 rounded border border-[#eaedf1] bg-[#f8fafc] text-xs font-medium text-[#0f172a] hover:bg-[#f1f5f9] cursor-pointer"
                >
                  Copy
                </button>
                <button
                  onClick={() => handleRevoke(s._id)}
                  className="px-2.5 py-1 rounded border border-red-200 bg-red-50 text-xs font-medium text-red-600 hover:bg-red-100 cursor-pointer"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export const Documents = () => {
  const [docs, setDocs] = useState<PlatformDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [openShareId, setOpenShareId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocs = () => {
    setLoading(true);
    documentsApi
      .list()
      .then((res) => setDocs(res.data))
      .catch(() => { })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchDocs();
  }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploading(true);
    setUploadError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      await documentsApi.upload(formData);
      fetchDocs();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string; }; }; })?.response?.data?.message ||
        'Upload failed.';
      setUploadError(msg);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This will also revoke all active share links.`)) return;
    try {
      await documentsApi.delete(id);
      setDocs((prev) => prev.filter((d) => d._id !== id));
      if (openShareId === id) setOpenShareId(null);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-[#ffffff]">
      <div className="px-8 py-5 border-b border-[#eaedf1] flex items-center justify-between bg-[#ffffff]">
        <div>
          <h1 className="text-lg font-semibold text-[#0f172a] tracking-tight">Documents</h1>
          <p className="text-xs text-[#64748b] mt-0.5">Upload PDFs and configure protected share links</p>
        </div>
        <div className="flex items-center gap-3">
          {uploadError && <span className="text-xs text-red-500 font-medium">{uploadError}</span>}
          <input
            type="file"
            accept=".pdf"
            className="hidden"
            ref={fileInputRef}
            onChange={handleUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="px-4 py-2 rounded-xl bg-[#171717] hover:bg-[#000000] text-white text-xs font-semibold transition active:scale-[0.98] flex items-center gap-2 cursor-pointer shadow-sm"
          >
            <svg className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            {uploading ? 'Uploading…' : 'Upload PDF'}
          </button>
        </div>
      </div>

      <div className="flex-1 p-8 overflow-y-auto">
        {loading ? (
          <div className="text-center py-20 text-xs font-mono text-[#94a3b8]">Loading documents…</div>
        ) : docs.length === 0 ? (
          <div className="h-80 flex flex-col items-center justify-center text-center p-8">
            <div className="size-12 rounded-2xl border border-[#eaedf1] bg-[#f8fafc] flex items-center justify-center text-[#94a3b8] mb-3">
              <svg className="size-6" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="text-sm font-semibold text-[#0f172a]">No documents uploaded</div>
            <div className="text-xs text-[#64748b] mt-1 max-w-xs">
              Upload a PDF document to start generating password-protected view links.
            </div>
          </div>
        ) : (
          <div className="divide-y divide-[#eaedf1]">
            {docs.map((doc) => (
              <div key={doc._id} className="py-4">
                <div className="flex items-center gap-4">
                  <div className="size-9 rounded-xl border border-[#eaedf1] bg-[#f8fafc] text-[#0f172a] flex items-center justify-center shrink-0">
                    <svg className="size-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <div className="text-sm font-semibold text-[#0f172a] truncate">{doc.originalName}</div>
                    <div className="text-xs text-[#94a3b8] flex items-center gap-2 mt-0.5 font-mono">
                      <span>{formatBytes(doc.size)}</span>
                      <span>·</span>
                      <span>{doc.viewCount} view{doc.viewCount !== 1 ? 's' : ''}</span>
                      <span>·</span>
                      <span>{new Date(doc.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setOpenShareId(openShareId === doc._id ? null : doc._id)}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer transition ${openShareId === doc._id
                          ? 'bg-blue-50 border-blue-200 text-blue-700'
                          : 'bg-[#ffffff] border-[#eaedf1] text-[#0f172a] hover:bg-[#f8fafc]'
                        }`}
                    >
                      Share Link
                    </button>
                    <button
                      onClick={() => handleDelete(doc._id, doc.originalName)}
                      className="p-1.5 rounded-lg border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 cursor-pointer"
                    >
                      <svg className="size-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
                {openShareId === doc._id && <SharePanel doc={doc} onClose={() => setOpenShareId(null)} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};