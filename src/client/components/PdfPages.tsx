import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '../lib/pdfjs';
import { cx } from './ui';
import type { ZoomView } from './ZoomBox';

/** Pixels per page: iOS caps each canvas (and all canvases together), so stay well under. */
const BASE_PIXELS = 4_000_000;
const ZOOM_PIXELS = 12_000_000;
const GAP = 8;

/**
 * A PDF's pages as canvases, one under another, at the width of their container. Only the pages
 * near the view are drawn (far ones are let go, to save memory), and once a pinch ends the pages
 * in view are drawn again at the zoomed size so text stays sharp.
 */
export function PdfPages({
  file,
  view,
  className,
}: {
  file: Blob;
  view: ZoomView | null;
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const slots = useRef<(HTMLDivElement | null)[]>([]);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState('');
  /** The pixel ratio each page is drawn at (0 = not drawn). */
  const drawn = useRef<number[]>([]);
  const busy = useRef(false);
  const settledScale = useRef(1);
  const latest = useRef<() => void>(() => {});

  // Load pdf.js (its own chunk) and the document.
  useEffect(() => {
    let gone = false;
    let opened: PDFDocumentProxy | null = null;
    import('../lib/pdfjs')
      .then(async (m) => m.openPdf(await file.arrayBuffer()))
      .then(async (d) => {
        opened = d;
        if (gone) return void d.loadingTask.destroy();
        const s: { w: number; h: number }[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const v = (await d.getPage(i)).getViewport({ scale: 1 });
          s.push({ w: v.width, h: v.height });
        }
        if (gone) return;
        drawn.current = s.map(() => 0);
        setSizes(s);
        setDoc(d);
      })
      .catch(() => !gone && setError('This PDF couldn’t be shown. Download it instead.'));
    const pages = slots.current;
    return () => {
      gone = true;
      for (const el of pages) el?.querySelector('canvas')?.remove();
      void opened?.loadingTask.destroy();
    };
  }, [file]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Page tops at the current width.
  const heights = sizes.map((s) => (width * s.h) / s.w);
  const tops: number[] = [];
  heights.reduce((y, h, i) => ((tops[i] = y), y + h + GAP), 0);

  // When the width changes every page is redrawn.
  useEffect(() => {
    drawn.current = drawn.current.map(() => 0);
  }, [width]);

  // After every render: draw (or let go of) whatever the view now needs.
  useEffect(() => {
    if (view?.settled) settledScale.current = view.scale;
    const run = () => {
      if (!doc || !width || busy.current) return;
      const dpr = window.devicePixelRatio || 1;
      const top = view?.top ?? 0;
      const bottom = view?.bottom ?? heights[0] ?? 0;
      const span = bottom - top;
      const want = sizes.map((_, i) => {
        const h = heights[i]!;
        const y = tops[i]!;
        if (y + h < top - span || y > bottom + span) return 0;
        const area = width * h;
        const inView = y + h > top && y < bottom;
        const base = Math.min(dpr, Math.sqrt(BASE_PIXELS / area));
        if (!inView || settledScale.current <= 1.05) return base;
        return Math.max(base, Math.min(dpr * settledScale.current, Math.sqrt(ZOOM_PIXELS / area)));
      });
      // Let go of far pages straight away.
      want.forEach((w, i) => {
        if (w === 0 && drawn.current[i]) {
          const c = slots.current[i]?.querySelector('canvas');
          if (c) {
            c.width = 0;
            c.height = 0;
            c.remove();
          }
          drawn.current[i] = 0;
        }
      });
      // Draw one page at a time, those in view first.
      const order = want
        .map((w, i) => ({ w, i, d: Math.abs(tops[i]! - top) }))
        .filter(({ w, i }) => w > 0 && Math.abs(w - drawn.current[i]!) / w > 0.1)
        .sort((a, b) => a.d - b.d);
      const job = order[0];
      if (!job) return;
      busy.current = true;
      const { i, w } = job;
      const cssW = width;
      void (async () => {
        try {
          const page = await doc.getPage(i + 1);
          const viewport = page.getViewport({ scale: (cssW * w) / sizes[i]!.w });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.className = 'absolute inset-0 h-full w-full';
          await page.render({ canvas, viewport }).promise;
          const slot = slots.current[i];
          if (slot && cssW === width) {
            const old = slot.querySelector('canvas');
            slot.append(canvas);
            if (old) {
              old.width = 0;
              old.height = 0;
              old.remove();
            }
            drawn.current[i] = w;
          }
        } catch {
          drawn.current[i] = w; // don't retry a page that fails to draw
        } finally {
          busy.current = false;
          latest.current();
        }
      })();
    };
    latest.current = run;
    run();
  });

  if (error) return <p className="p-6 text-sm text-soft">{error}</p>;
  return (
    <div ref={wrap} className={cx('flex w-full flex-col', className)} style={{ gap: GAP }}>
      {sizes.length === 0 && <div className="aspect-[8.5/11] w-full bg-white" />}
      {sizes.map((s, i) => (
        <div
          key={i}
          ref={(el) => {
            slots.current[i] = el;
          }}
          className="relative w-full bg-white"
          style={{ aspectRatio: `${s.w} / ${s.h}` }}
          aria-label={`Page ${i + 1} of ${sizes.length}`}
        />
      ))}
    </div>
  );
}
