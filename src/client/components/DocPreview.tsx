import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DocumentSummary } from '@shared/types';
import { fileUrl, useFile, useSaveFile } from '../lib/files';
import { Icon } from './Icon';
import { PdfPages } from './PdfPages';
import { cx } from './ui';
import { ZoomBox, type ZoomView } from './ZoomBox';

/**
 * The original file, shown inline: PDFs as pages and images as images, both zoomable inside the
 * box (pinch, double-tap, trackpad), and email bodies as text.
 * `fill` takes the container's height (side-by-side panes, the full-screen viewer) instead of a
 * fixed one; `bare` drops the rounded frame (the full-screen viewer).
 */
export function DocPreview({
  doc,
  className,
  fill,
  bare,
}: {
  doc: DocumentSummary;
  className?: string;
  fill?: boolean;
  bare?: boolean;
}) {
  const src = `/api/files/${doc.id}`;
  const isText = doc.mime.startsWith('text/');
  const isPdf = doc.mime === 'application/pdf';
  const isImage = doc.mime.startsWith('image/') && !/hei[cf]/.test(doc.mime);
  const live = doc.status !== 'discarded';
  const text = useQuery({
    queryKey: ['doc-text', doc.id],
    enabled: isText && live,
    queryFn: async () => (await fetch(src, { credentials: 'same-origin' })).text(),
    staleTime: Infinity,
  });
  const file = useFile(doc.id, undefined, isPdf && live);
  const [view, setView] = useState<ZoomView | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const save = useSaveFile();
  const height = fill ? 'h-full min-h-[320px]' : 'h-[70vh] min-h-[420px]';
  const box = cx(
    'w-full overflow-hidden',
    bare ? '' : 'rounded-xl border border-line',
    'bg-surface',
    className,
  );
  if (!live) return <div className={cx(box, 'p-6 text-sm text-soft')}>Discarded.</div>;
  if (isPdf)
    return (
      <ZoomBox className={cx(box, height, 'bg-chip')} onView={setView}>
        {file.data ? (
          <PdfPages
            file={file.data}
            view={view}
            // Full screen on a computer: a readable page width, not the whole window.
            className={bare ? 'md:mx-auto md:max-w-4xl md:py-4' : undefined}
          />
        ) : file.error ? (
          <p className="p-6 text-sm text-soft">{file.error.message}</p>
        ) : (
          <div className="aspect-[8.5/11] w-full animate-pulse bg-surface" />
        )}
      </ZoomBox>
    );
  if (isImage)
    return (
      <ZoomBox
        align="center"
        className={cx(box, fill ? 'h-full' : 'max-h-[70vh] min-h-[240px]', 'bg-chip')}
        // Inline, the box takes the photo's shape (up to 70% of the screen).
        {...(!fill && ratio ? { style: { aspectRatio: ratio } } : {})}
      >
        <img
          src={src}
          alt={doc.filename}
          draggable={false}
          onLoad={(e) =>
            setRatio(e.currentTarget.naturalWidth / Math.max(1, e.currentTarget.naturalHeight))
          }
          className={cx('block h-auto w-full', bare && 'md:mx-auto md:max-w-4xl')}
        />
      </ZoomBox>
    );
  if (isText)
    return (
      <pre
        className={cx(
          box,
          fill ? 'h-full' : 'max-h-[70vh]',
          'overflow-auto p-4 font-sans text-sm whitespace-pre-wrap text-ink',
        )}
      >
        {text.data ?? 'Loading…'}
      </pre>
    );
  return (
    <button
      type="button"
      onClick={() => void save(fileUrl(doc.id), doc.filename)}
      className={cx(box, 'flex items-center gap-3 p-5 text-left text-sm text-ink')}
    >
      <Icon name="file" className="text-accent" />
      {doc.filename}: this file type can’t be previewed. Download it.
    </button>
  );
}
