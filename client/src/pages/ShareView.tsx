import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { PdfViewer } from '../components/PdfViewer';

const API = 'http://localhost:5000/api';

interface ShareMeta {
  requiresPassword: boolean;
  documentName: string;
  documentSize: number;
  expiresAt?: string;
  accessCount: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const ShareView = () => {
  const { token } = useParams<{ token: string }>();
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [metaError, setMetaError] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [viewToken, setViewToken] = useState('');
  const [documentName, setDocumentName] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  // Step 1: Fetch metadata
  useEffect(() => {
    if (!token) return;
    axios.get<ShareMeta>(`${API}/share/${token}`)
      .then(res => {
        setMeta(res.data);
        setDocumentName(res.data.documentName);
        // If no password required, auto-access
        if (!res.data.requiresPassword) {
          doAccess('');
        }
      })
      .catch(err => {
        const msg = err.response?.data?.message || 'Failed to load share link.';
        setMetaError(msg);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const doAccess = async (pwd: string) => {
    setUnlocking(true);
    setPasswordError('');
    try {
      const res = await axios.post<{ viewToken: string; documentName: string }>(`${API}/share/${token}/access`, { password: pwd });
      setViewToken(res.data.viewToken);
      setDocumentName(res.data.documentName);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Access failed.';
      setPasswordError(msg);
    } finally {
      setUnlocking(false);
    }
  };

  const handleUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    doAccess(password);
  };

  // Show error state
  if (metaError) {
    return (
      <div style={s.page}>
        <div style={s.header}>
          <span style={s.brand}>✉ MailTrack</span>
        </div>
        <div style={s.center}>
          <div style={s.card}>
            <div style={{ fontSize: '2.5rem', marginBottom: 16 }}>⚠️</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1e293b', marginBottom: 8 }}>Link Unavailable</div>
            <div style={{ fontSize: '0.9rem', color: '#64748b' }}>{metaError}</div>
          </div>
        </div>
      </div>
    );
  }

  // Loading metadata
  if (!meta) {
    return (
      <div style={s.page}>
        <div style={s.header}>
          <span style={s.brand}>✉ MailTrack</span>
        </div>
        <div style={s.center}>
          <div style={{ color: '#64748b', fontSize: '0.95rem' }}>Loading…</div>
        </div>
      </div>
    );
  }

  // Viewing PDF
  if (viewToken) {
    const fileUrl = `${API}/share/${token}/file?vt=${encodeURIComponent(viewToken)}`;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <div style={s.header}>
          <span style={s.brand}>✉ MailTrack</span>
          <span style={{ color: '#94a3b8', fontSize: '0.85rem', marginLeft: 'auto' }}>📄 {documentName}</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <PdfViewer url={fileUrl} />
        </div>
      </div>
    );
  }

  // Password gate
  return (
    <div style={s.page}>
      <div style={s.header}>
        <span style={s.brand}>✉ MailTrack</span>
      </div>
      <div style={s.center}>
        <div style={s.card}>
          <div style={{ fontSize: '2.5rem', marginBottom: 16 }}>🔒</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1e293b', marginBottom: 4 }}>
            {meta.documentName}
          </div>
          <div style={{ fontSize: '0.82rem', color: '#94a3b8', marginBottom: 4 }}>
            {formatBytes(meta.documentSize)}
          </div>
          {meta.expiresAt && (
            <div style={{ fontSize: '0.78rem', color: '#f59e0b', marginBottom: 16 }}>
              Expires {new Date(meta.expiresAt).toLocaleString()}
            </div>
          )}
          <div style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: 20 }}>
            This document is password protected. Enter the password to view it.
          </div>
          <form onSubmit={handleUnlock} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              type="password"
              placeholder="Enter password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={s.input}
              autoFocus
            />
            {passwordError && (
              <div style={{ fontSize: '0.82rem', color: '#dc2626', padding: '8px 12px', background: '#fef2f2', borderRadius: 6, border: '1px solid #fecaca' }}>
                {passwordError}
              </div>
            )}
            <button type="submit" disabled={unlocking || !password} style={s.unlockBtn}>
              {unlocking ? 'Unlocking…' : '🔓 View Document'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#f8fafc' },
  header: {
    display: 'flex', alignItems: 'center', padding: '14px 24px',
    background: '#0f172a', borderBottom: '1px solid rgba(255,255,255,0.06)',
    flexShrink: 0,
  },
  brand: { color: '#f1f5f9', fontWeight: 700, fontSize: '1rem', letterSpacing: '-0.02em' },
  center: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    background: '#fff', borderRadius: 16, padding: '40px 36px',
    boxShadow: '0 8px 40px rgba(0,0,0,0.10)', textAlign: 'center',
    maxWidth: 380, width: '100%',
  },
  input: {
    padding: '10px 14px', borderRadius: 8, border: '1px solid #e2e8f0',
    fontSize: '0.95rem', outline: 'none', width: '100%', boxSizing: 'border-box' as const,
    fontFamily: 'inherit',
  },
  unlockBtn: {
    padding: '11px 20px', borderRadius: 8, border: 'none',
    background: '#2563eb', color: '#fff', fontWeight: 600,
    fontSize: '0.9rem', cursor: 'pointer', fontFamily: 'inherit',
  },
};
