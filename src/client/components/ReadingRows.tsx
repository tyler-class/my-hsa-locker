// The Ledger's placeholder rows: one per document still being read, at the top, until its
// entries arrive. They aren't entries: selection, filters and totals never see them.
import type { DocumentSummary } from '@shared/types';
import { ago } from '../lib/format';
import { readingStatus, readingTitle } from '../lib/reading';
import { useInFlightDocs } from '../lib/queries';
import { useViewer } from '../lib/viewer';
import { Icon } from './Icon';

function cameFrom(d: DocumentSummary) {
  const when = ago(d.received_at);
  if (d.source === 'email') return `Emailed ${when}`;
  if (d.source === 'upload') return `Uploaded ${when}`;
  return `Added ${when}`;
}

export function ReadingRows() {
  const docs = useInFlightDocs().data ?? [];
  const { open } = useViewer();
  if (!docs.length) return null;
  return (
    <ul className="px-5 pt-2" aria-label="Documents being read">
      {docs.map((d) => {
        const s = readingStatus(d);
        const photo = d.mime.startsWith('image/');
        return (
          <li key={d.id} className="border-b border-line">
            {/* The original is there from the moment it's uploaded, so it opens in the viewer. */}
            <button
              type="button"
              onClick={() => open('doc', d.id)}
              className="flex w-full items-center gap-3.5 rounded-xl px-3 py-3 text-left transition-colors hover:bg-chip"
            >
              <span className="grid h-5 w-5 flex-none place-items-center text-soft" aria-hidden>
                <Icon name={photo ? 'camera' : 'file'} size={18} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[15px] [overflow-wrap:anywhere]">{readingTitle(d)}</span>
                <span className="text-xs text-soft">{cameFrom(d)}</span>
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
          </li>
        );
      })}
    </ul>
  );
}
