/**
 * In-app PDF viewer on PDF.js, loaded on first use (its own chunk plus a worker). Rendering the
 * bytes ourselves means the attachment response can be served sandboxed (DESIGN 15.13).
 */
import { useEffect, useRef, useState } from 'react';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfViewer({ url, name }: { url: string; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const task = getDocument({ url, withCredentials: true });
    task.promise.then(setDoc, (e: unknown) =>
      setError(e instanceof Error ? e.message : 'Could not open the PDF'),
    );
    return () => void task.destroy();
  }, [url]);

  useEffect(() => {
    if (!doc || !canvas.current || !box.current) return;
    let cancelled = false;
    let render: { cancel: () => void } | null = null;
    void doc.getPage(page).then((p) => {
      if (cancelled || !canvas.current || !box.current) return;
      const base = p.getViewport({ scale: 1 });
      const fitWidth = (box.current.clientWidth - 2) / base.width;
      const viewport = p.getViewport({ scale: fitWidth * zoom });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const c = canvas.current;
      c.width = Math.floor(viewport.width * dpr);
      c.height = Math.floor(viewport.height * dpr);
      c.style.width = `${Math.floor(viewport.width)}px`;
      c.style.height = `${Math.floor(viewport.height)}px`;
      const task = p.render({
        canvas: c,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      });
      render = task;
      task.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [doc, page, zoom]);

  if (error)
    return (
      <p role="alert">
        Couldn’t show this PDF ({error}).{' '}
        <a href={url} download={name}>
          Download it
        </a>{' '}
        instead.
      </p>
    );

  const pages = doc?.numPages ?? 0;
  return (
    <div className="pdf">
      <div className="pdf-bar" role="toolbar" aria-label="PDF controls">
        <button type="button" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
          Previous
        </button>
        <span aria-live="polite">{doc ? `Page ${page} of ${pages}` : 'Loading…'}</span>
        <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page >= pages}>
          Next
        </button>
        <span className="spacer" />
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))}
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(4, z * 1.25))}
          aria-label="Zoom in"
        >
          +
        </button>
        <a className="btn" href={url} download={name}>
          Download
        </a>
      </div>
      <div ref={box} className="pdf-page">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${name}, page ${page}`}
          data-testid="pdf-canvas"
        />
      </div>
    </div>
  );
}
