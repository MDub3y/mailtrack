import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// @ts-ignore
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export const PdfViewer = ({ url }: { url: string }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.3);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    const loadingTask = pdfjs.getDocument({ url });
    loadingTask.promise.then((doc) => {
      setPdf(doc);
      setNumPages(doc.numPages);
      setPage(1);
      setLoading(false);
    }).catch((err: Error) => {
      setError('Failed to load PDF: ' + err.message);
      setLoading(false);
    });
    return () => { loadingTask.destroy(); };
  }, [url]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    pdf.getPage(page).then((p) => {
      if (cancelled) return;
      const viewport = p.getViewport({ scale });
      const canvas = canvasRef.current!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      // pdfjs-dist v4+ requires passing the canvas element directly
      const task = p.render({ canvas, viewport });
      return task.promise;
    }).catch(() => {/* ignore cancelled renders */});
    return () => { cancelled = true; };
  }, [pdf, page, scale]);

  if (loading) return (
    <div style={{ padding: 60, textAlign: 'center', color: '#64748b' }}>
      <div style={{ fontSize: '2rem', marginBottom: 12 }}>📄</div>
      Loading PDF…
    </div>
  );
  if (error) return <div style={{ padding: 40, color: '#dc2626', textAlign: 'center' }}>{error}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#f8fafc', minHeight: '100%' }}>
      <div style={{ display: 'flex', gap: 8, padding: '12px 20px', alignItems: 'center', position: 'sticky', top: 0, background: '#fff', zIndex: 10, width: '100%', boxSizing: 'border-box', borderBottom: '1px solid #e2e8f0', justifyContent: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} style={btn}>‹ Prev</button>
        <span style={{ fontSize: '0.82rem', color: '#64748b', padding: '0 4px' }}>Page {page} of {numPages}</span>
        <button onClick={() => setPage(p => Math.min(numPages, p + 1))} disabled={page >= numPages} style={btn}>Next ›</button>
        <div style={{ width: 1, height: 20, background: '#e2e8f0', margin: '0 4px' }} />
        <button onClick={() => setScale(s => Math.max(0.5, +(s - 0.2).toFixed(1)))} style={btn}>−</button>
        <span style={{ fontSize: '0.82rem', color: '#64748b', minWidth: 40, textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale(s => Math.min(3, +(s + 0.2).toFixed(1)))} style={btn}>+</button>
      </div>
      <div style={{ padding: 20 }}>
        <canvas ref={canvasRef} style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.12)', borderRadius: 4, maxWidth: '100%' }} />
      </div>
    </div>
  );
};

const btn: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 6, border: '1px solid #e2e8f0',
  background: '#fff', color: '#374151', fontSize: '0.8rem', cursor: 'pointer',
  fontFamily: 'inherit',
};
