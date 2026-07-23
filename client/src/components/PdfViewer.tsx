import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// @ts-ignore
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export const PdfViewer = ({ url }: { url: string; }) => {
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
    loadingTask.promise
      .then((doc) => {
        setPdf(doc);
        setNumPages(doc.numPages);
        setPage(1);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError('Failed to load PDF: ' + err.message);
        setLoading(false);
      });
    return () => {
      loadingTask.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    pdf
      .getPage(page)
      .then((p) => {
        if (cancelled) return;
        const viewport = p.getViewport({ scale });
        const canvas = canvasRef.current!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const task = p.render({ canvas, viewport });
        return task.promise;
      })
      .catch(() => { });
    return () => {
      cancelled = true;
    };
  }, [pdf, page, scale]);

  if (loading)
    return (
      <div className="p-16 text-center text-xs font-mono text-[#64748b]">
        Rendering PDF Canvas…
      </div>
    );
  if (error)
    return (
      <div className="p-10 text-center text-xs text-red-600 font-medium">{error}</div>
    );

  return (
    <div className="flex flex-col items-center bg-[#f8fafc] min-h-full">
      <div className="sticky top-0 z-10 w-full bg-[#ffffff] border-b border-[#eaedf1] p-3 flex items-center justify-center gap-3 shadow-xs">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="px-3 py-1.5 rounded-lg border border-[#eaedf1] bg-[#ffffff] text-xs font-medium text-[#0f172a] hover:bg-[#f8fafc] disabled:opacity-40 cursor-pointer"
        >
          ‹ Prev
        </button>
        <span className="text-xs text-[#64748b] font-mono">
          Page {page} of {numPages}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(numPages, p + 1))}
          disabled={page >= numPages}
          className="px-3 py-1.5 rounded-lg border border-[#eaedf1] bg-[#ffffff] text-xs font-medium text-[#0f172a] hover:bg-[#f8fafc] disabled:opacity-40 cursor-pointer"
        >
          Next ›
        </button>
        <div className="w-px h-4 bg-[#eaedf1] mx-1" />
        <button
          onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(1)))}
          className="px-2.5 py-1.5 rounded-lg border border-[#eaedf1] bg-[#ffffff] text-xs font-medium text-[#0f172a] hover:bg-[#f8fafc] cursor-pointer"
        >
          −
        </button>
        <span className="text-xs text-[#64748b] font-mono w-12 text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(1)))}
          className="px-2.5 py-1.5 rounded-lg border border-[#eaedf1] bg-[#ffffff] text-xs font-medium text-[#0f172a] hover:bg-[#f8fafc] cursor-pointer"
        >
          +
        </button>
      </div>

      <div className="p-6">
        <canvas
          ref={canvasRef}
          className="shadow-xl rounded-lg border border-[#eaedf1] max-w-full"
        />
      </div>
    </div>
  );
};