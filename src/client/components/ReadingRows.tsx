// Documents still being read, shown as placeholder rows until their entries arrive: the Ledger's
// Processing section and the top of Home's Recently logged. They aren't entries: selection,
// filters and totals never see them. Tapping one opens the original, which is there from the
// moment it's uploaded.
import { useState } from 'react';
import type { DocumentSummary } from '@shared/types';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { readingStatus, readingTitle } from '../lib/reading';
import { useInFlightDocs, useRefreshData } from '../lib/queries';
import { useViewer } from '../lib/viewer';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { cx, SectionLabel } from './ui';

function cameFrom(d: DocumentSummary) {
  const when = ago(d.received_at);
  if (d.source === 'email') return `Emailed ${when}`;
  if (d.source === 'upload') return `Uploaded ${when}`;
  return `Added ${when}`;
}

/**
 * One document being read: its name or "Photo", when it came, and where reading stands. Tapping
 * it opens the original; the trash deletes it (one that keeps failing can be deleted and added
 * again). Deleting asks first: the file is deleted straight away, so it can't be undone.
 */
export function ReadingRow({ doc, className }: { doc: DocumentSummary; className?: string }) {
  const { open } = useViewer();
  const refresh = useRefreshData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const s = readingStatus(doc);
  const photo = doc.mime.startsWith('image/');
  const what = photo ? 'photo' : 'document';
  async function remove() {
    if (!confirm(`Delete this ${what}? It won't be read, and the file is deleted.`)) return;
    setBusy(true);
    try {
      await api.post(`/documents/${doc.id}/discard`);
      toast({ text: 'Deleted' });
      await refresh();
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : 'Couldn’t delete it.' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => open('doc', doc.id)}
        className={cx(
          'flex min-w-0 flex-1 items-center gap-3.5 rounded-xl px-3 text-left transition-colors hover:bg-chip',
          className ?? 'py-3',
        )}
      >
        <span className="grid h-5 w-5 flex-none place-items-center text-soft" aria-hidden>
          <Icon name={photo ? 'camera' : 'file'} size={18} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] [overflow-wrap:anywhere]">{readingTitle(doc)}</span>
          <span className="text-xs text-soft">{cameFrom(doc)}</span>
          <span
            className={
              s.retrying
                ? 'text-xs text-warn [overflow-wrap:anywhere]'
                : 'flex items-center gap-1.5 text-xs text-accent'
            }
            role="status"
          >
            {!s.retrying && (
              <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
            )}
            {s.label}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => void remove()}
        disabled={busy}
        aria-label={`Delete this ${what}`}
        title={`Delete this ${what}`}
        className="grid h-11 w-11 flex-none place-items-center rounded-full text-soft transition-colors hover:bg-chip hover:text-danger disabled:opacity-50"
      >
        <Icon name="trash" size={18} />
      </button>
    </div>
  );
}

/** The Ledger's Processing section: a heading and a row per document being read. */
export function ProcessingSection({ heading = true }: { heading?: boolean }) {
  const docs = useInFlightDocs().data ?? [];
  if (!docs.length) return null;
  return (
    <section aria-label="Processing">
      {heading && <SectionLabel icon="refresh">Processing</SectionLabel>}
      <ul className="px-5 pt-2">
        {docs.map((d) => (
          <li key={d.id} className="border-b border-line">
            <ReadingRow doc={d} />
          </li>
        ))}
      </ul>
    </section>
  );
}
