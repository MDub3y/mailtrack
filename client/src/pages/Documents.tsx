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
    documentsApi.listShares(doc._id)
      .then(res => setShares(res.data))
      .catch(() => {})
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
      // Refresh list
      const listRes = await documentsApi.listShares(doc._id);
      setShares(listRes.data);
      setPassword('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Failed to create link.';
      setCreateError(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (tokenId: string) => {
    try {
      await documentsApi.revokeShare(doc._id, tokenId);
      setShares(prev => prev.filter(s => s._id !== tokenId));
    } catch { /* ignore */ }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={sp.panel}>
      <div style={sp.panelHeader}>
        <span style={{ fontWeight: 600, fontSize: '0.88rem', color: '#1e293b' }}>Share: {doc.originalName}</span>
        <button onClick={onClose} style={sp.closeBtn}>✕</button>
      </div>

      {/* Create new link */}
      <div style={sp.section}>
        <div style={sp.sectionTitle}>Create Share Link</div>
        <div style={sp.row}>
          <input
            type="password"
            placeholder="Password (optional)"
            value={password}
            onChange={e => setPassword(e.target.value)}
            style={sp.input}
          />
          <select
            value={expiresInHours ?? ''}
            onChange={e => setExpiresInHours(e.target.value ? Number(e.target.value) : undefined)}
            style={sp.select}
          >
            <option value="">No expiry</option>
            <option value="24">24 hours</option>
            <option value="168">7 days</option>
            <option value="720">30 days</option>
          </select>
        </div>
        {createError && <div style={sp.error}>{createError}</div>}
        <button onClick={handleCreate} disabled={creating} style={sp.createBtn}>
          {creating ? 'Creating…' : '+ Create Link'}
        </button>

        {newLink && (
          <div style={sp.newLink}>
            <span style={{ flex: 1, fontSize: '0.78rem', color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{newLink}</span>
            <button onClick={() => copyToClipboard(newLink)} style={sp.copyBtn}>
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>

      {/* Existing shares */}
      <div style={sp.section}>
        <div style={sp.sectionTitle}>Active Links</div>
        {loadingShares ? (
          <div style={{ fontSize: '0.82rem', color: '#94a3b8' }}>Loading…</div>
        ) : shares.length === 0 ? (
          <div style={{ fontSize: '0.82rem', color: '#94a3b8' }}>No active share links</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {shares.map(s => (
              <div key={s._id} style={sp.shareRow}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.75rem', color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.shareUrl}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: 2 }}>
                    {s.accessCount} views
                    {s.requiresPassword && ' · 🔒 password'}
                    {s.expiresAt && ` · expires ${new Date(s.expiresAt).toLocaleDateString()}`}
                  </div>
                </div>
                <button onClick={() => copyToClipboard(s.shareUrl)} style={sp.copyBtn}>Copy</button>
                <button onClick={() => handleRevoke(s._id)} style={sp.revokeBtn}>Revoke</button>
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
    documentsApi.list()
      .then(res => setDocs(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchDocs(); }, []);

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
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Upload failed.';
      setUploadError(msg);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This will also revoke all share links.`)) return;
    try {
      await documentsApi.delete(id);
      setDocs(prev => prev.filter(d => d._id !== id));
      if (openShareId === id) setOpenShareId(null);
    } catch { /* ignore */ }
  };

  return (
    <div style={s.page}>
      <div style={s.topBar}>
        <div>
          <div style={s.pageTitle}>Documents</div>
          <div style={s.pageSubtitle}>Upload PDFs and create secure share links</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {uploadError && <span style={{ fontSize: '0.8rem', color: '#dc2626' }}>{uploadError}</span>}
          <input type="file" accept=".pdf" style={{ display: 'none' }} ref={fileInputRef} onChange={handleUpload} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={s.uploadBtn}
          >
            {uploading ? 'Uploading…' : '⬆ Upload PDF'}
          </button>
        </div>
      </div>

      <div style={s.content}>
        {loading ? (
          <div style={s.empty}>Loading…</div>
        ) : docs.length === 0 ? (
          <div style={s.empty}>
            <div style={{ fontSize: '3rem', marginBottom: 12 }}>📄</div>
            <div style={{ fontSize: '1rem', fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>No documents yet</div>
            <div style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Upload a PDF to get started</div>
          </div>
        ) : (
          <div style={s.list}>
            {docs.map(doc => (
              <div key={doc._id}>
                <div style={s.docRow}>
                  <div style={s.docIcon}>📄</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={s.docName}>{doc.originalName}</div>
                    <div style={s.docMeta}>
                      {formatBytes(doc.size)}
                      <span style={s.metaDot}>·</span>
                      {doc.viewCount} view{doc.viewCount !== 1 ? 's' : ''}
                      <span style={s.metaDot}>·</span>
                      {new Date(doc.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <button
                      onClick={() => setOpenShareId(openShareId === doc._id ? null : doc._id)}
                      style={{ ...s.actionBtn, ...(openShareId === doc._id ? s.actionBtnActive : {}) }}
                    >
                      🔗 Share
                    </button>
                    <button
                      onClick={() => handleDelete(doc._id, doc.originalName)}
                      style={s.deleteBtn}
                    >
                      🗑
                    </button>
                  </div>
                </div>
                {openShareId === doc._id && (
                  <SharePanel doc={doc} onClose={() => setOpenShareId(null)} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', height: '100%' },
  topBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '20px 28px', borderBottom: '1px solid #f1f5f9', flexShrink: 0,
  },
  pageTitle: { fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' },
  pageSubtitle: { fontSize: '0.8rem', color: '#94a3b8', marginTop: 2 },
  uploadBtn: {
    padding: '9px 18px', borderRadius: 8, border: 'none',
    background: '#2563eb', color: '#fff', fontWeight: 600,
    fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'inherit',
  },
  content: { flex: 1, overflowY: 'auto', padding: '20px 28px' },
  empty: { textAlign: 'center', padding: '80px 20px', color: '#94a3b8' },
  list: { display: 'flex', flexDirection: 'column', gap: 0 },
  docRow: {
    display: 'flex', alignItems: 'center', gap: 14,
    padding: '14px 0', borderBottom: '1px solid #f1f5f9',
  },
  docIcon: { fontSize: '1.5rem', flexShrink: 0, width: 32, textAlign: 'center' },
  docName: { fontSize: '0.9rem', fontWeight: 600, color: '#0f172a', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  docMeta: { fontSize: '0.75rem', color: '#94a3b8', display: 'flex', gap: 4, alignItems: 'center' },
  metaDot: { opacity: 0.5 },
  actionBtn: {
    padding: '6px 14px', borderRadius: 6, border: '1px solid #e2e8f0',
    background: '#fff', color: '#374151', fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'inherit',
  },
  actionBtnActive: { background: '#eff6ff', borderColor: '#bfdbfe', color: '#2563eb' },
  deleteBtn: {
    padding: '6px 10px', borderRadius: 6, border: '1px solid #fecaca',
    background: '#fff5f5', color: '#dc2626', fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'inherit',
  },
};

const sp: Record<string, React.CSSProperties> = {
  panel: {
    margin: '0 0 8px 46px', background: '#f8fafc',
    border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden',
  },
  panelHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 16px', background: '#f1f5f9', borderBottom: '1px solid #e2e8f0',
  },
  closeBtn: { background: 'none', border: 'none', color: '#94a3b8', fontSize: '0.9rem', cursor: 'pointer' },
  section: { padding: '14px 16px', borderBottom: '1px solid #e2e8f0' },
  sectionTitle: {
    fontSize: '0.68rem', fontWeight: 700, color: '#94a3b8',
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10,
  },
  row: { display: 'flex', gap: 8, marginBottom: 10 },
  input: {
    flex: 1, padding: '7px 10px', borderRadius: 6, border: '1px solid #e2e8f0',
    fontSize: '0.83rem', outline: 'none', fontFamily: 'inherit',
  },
  select: {
    padding: '7px 10px', borderRadius: 6, border: '1px solid #e2e8f0',
    fontSize: '0.83rem', background: '#fff', fontFamily: 'inherit', cursor: 'pointer',
  },
  error: { fontSize: '0.78rem', color: '#dc2626', marginBottom: 8, padding: '6px 10px', background: '#fef2f2', borderRadius: 6 },
  createBtn: {
    padding: '7px 16px', borderRadius: 6, border: 'none',
    background: '#2563eb', color: '#fff', fontWeight: 600,
    fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'inherit',
  },
  newLink: {
    display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
    padding: '8px 10px', background: '#eff6ff', border: '1px solid #bfdbfe',
    borderRadius: 6,
  },
  copyBtn: {
    padding: '4px 10px', borderRadius: 5, border: '1px solid #e2e8f0',
    background: '#fff', fontSize: '0.75rem', cursor: 'pointer',
    fontFamily: 'inherit', flexShrink: 0, color: '#374151',
  },
  shareRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 10px', background: '#fff', border: '1px solid #e2e8f0',
    borderRadius: 6,
  },
  revokeBtn: {
    padding: '4px 10px', borderRadius: 5, border: '1px solid #fecaca',
    background: '#fff5f5', color: '#dc2626', fontSize: '0.75rem',
    cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
  },
};
