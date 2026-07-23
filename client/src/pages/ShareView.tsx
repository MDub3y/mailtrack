import React, { useEffect, useState } from 'react';
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
  const { token } = useParams<{ token: string; }>();
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [metaError, setMetaError] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [viewToken, setViewToken] = useState('');
  const [documentName, setDocumentName] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    if (!token) return;
    axios
      .get<ShareMeta>(`${API}/share/${token}`)
      .then((res) => {
        setMeta(res.data);
        setDocumentName(res.data.documentName);
        if (!res.data.requiresPassword) {
          doAccess('');
        }
      })
      .catch((err) => {
        const msg = err.response?.data?.message || 'Failed to load share link.';
        setMetaError(msg);
      });
  }, [token]);

  const doAccess = async (pwd: string) => {
    setUnlocking(true);
    setPasswordError('');
    try {
      const res = await axios.post<{ viewToken: string; documentName: string; }>(
        `${API}/share/${token}/access`,
        { password: pwd }
      );
      setViewToken(res.data.viewToken);
      setDocumentName(res.data.documentName);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string; }; }; })?.response?.data?.message ||
        'Access failed.';
      setPasswordError(msg);
    } finally {
      setUnlocking(false);
    }
  };

  const handleUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    doAccess(password);
  };

  if (metaError) {
    return (
      <div className="min-h-screen bg-[#ffffff] flex flex-col">
        <header className="px-6 py-4 border-b border-[#eaedf1] bg-[#ffffff] flex items-center justify-between">
          <span className="text-xs font-mono font-bold tracking-[0.2em] text-[#F17463] uppercase">
            MXDUB MailTrack
          </span>
        </header>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-sm p-8 rounded-2xl border border-[#eaedf1] bg-[#f8fafc] text-center space-y-3">
            <h2 className="text-base font-semibold text-[#0f172a]">Link Unavailable</h2>
            <p className="text-xs text-[#64748b]">{metaError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!meta) {
    return (
      <div className="min-h-screen bg-[#ffffff] flex flex-col">
        <header className="px-6 py-4 border-b border-[#eaedf1] bg-[#ffffff]">
          <span className="text-xs font-mono font-bold tracking-[0.2em] text-[#F17463] uppercase">
            MXDUB MailTrack
          </span>
        </header>
        <div className="flex-1 flex items-center justify-center text-xs font-mono text-[#94a3b8]">
          Loading document security clearance…
        </div>
      </div>
    );
  }

  if (viewToken) {
    const fileUrl = `${API}/share/${token}/file?vt=${encodeURIComponent(viewToken)}`;
    return (
      <div className="flex flex-col h-screen bg-[#ffffff]">
        <header className="px-6 py-3.5 border-b border-[#eaedf1] bg-[#ffffff] flex items-center justify-between">
          <span className="text-xs font-mono font-bold tracking-[0.2em] text-[#F17463] uppercase">
            MXDUB MailTrack
          </span>
          <span className="text-xs font-semibold text-[#0f172a] truncate max-w-md">
            {documentName}
          </span>
        </header>
        <div className="flex-1 overflow-y-auto">
          <PdfViewer url={fileUrl} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#ffffff] flex flex-col">
      <header className="px-6 py-4 border-b border-[#eaedf1] bg-[#ffffff]">
        <span className="text-xs font-mono font-bold tracking-[0.2em] text-[#F17463] uppercase">
          MXDUB MailTrack
        </span>
      </header>

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md p-8 rounded-2xl border border-[#eaedf1] bg-[#ffffff] shadow-sm text-center space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-[#0f172a]">{meta.documentName}</h2>
            <p className="text-xs font-mono text-[#94a3b8] mt-1">{formatBytes(meta.documentSize)}</p>
          </div>

          <p className="text-xs text-[#64748b] leading-relaxed">
            This document is password protected by the sender.
          </p>

          <form onSubmit={handleUnlock} className="space-y-3">
            <input
              type="password"
              placeholder="Enter document password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#eaedf1] bg-[#f8fafc] text-sm text-[#0f172a] outline-none focus:border-[#0f172a] transition"
              autoFocus
            />

            {passwordError && (
              <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-600">
                {passwordError}
              </div>
            )}

            <button
              type="submit"
              disabled={unlocking || !password}
              className="w-full py-2.5 px-4 rounded-xl bg-[#171717] hover:bg-[#000000] text-white text-xs font-semibold transition active:scale-[0.98] cursor-pointer"
            >
              {unlocking ? 'Verifying Password…' : 'Unlock Document'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};