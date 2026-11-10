import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EmailView } from '@shared/types';
import { api } from '../lib/api';
import { deliverFile, fileUrl, sharesFiles, useFile, useSaveFile } from '../lib/files';
import { formatDate } from '../lib/format';
import { useDocument } from '../lib/queries';
import { useViewer } from '../lib/viewer';
import { DocPreview } from './DocPreview';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { cx } from './ui';

/**
 * The full-screen viewer for a document's original file or the email it came in. It always has
 * a Back button in a solid top bar (an installed iPhone app has no browser back button), plus
 * Share (phones) or Download (computers). Mounted once, in Layout; opened with useViewer().
 */
export function DocViewer() {
  const { viewing, close } = useViewer();
  useEffect(() => {
    if (!viewing) return;
    // Escape closes the viewer only, not a sheet underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [viewing, close]);
  if (!viewing) return null;
  return viewing.kind === 'doc' ? (
    <DocScreen key={`d${viewing.id}`} id={viewing.id} onBack={close} />
  ) : (
    <EmailScreen key={`e${viewing.id}`} id={viewing.id} onBack={close} />
  );
}

/** The solid bar along the top, matching the app's own top bar (status bar inset included). */
function Screen({
  title,
  onBack,
  actions,
  children,
}: {
  title: string;
  onBack: () => void;
  actions: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[45] flex flex-col bg-bg"
    >
      <header className="flex h-[calc(env(safe-area-inset-top,0px)+48px)] flex-none items-center gap-1 border-b border-line bg-bg px-1.5 pt-[env(safe-area-inset-top,0px)] md:h-14 md:px-4">
        <button
          type="button"
          onClick={onBack}
          className="flex flex-none items-center gap-0.5 rounded-full py-2 pr-3 pl-1.5 text-[15px] font-medium text-accent hover:bg-chip"
        >
          <Icon name="back" size={20} />
          Back
        </button>
        <h2 className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold text-ink">
          {title}
        </h2>
        <div className="flex flex-none items-center justify-end gap-0.5">{actions}</div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom,0px)]">
        {children}
      </div>
    </div>
  );
}

function BarButton({
  icon,
  label,
  onClick,
  disabled,
  showLabel,
}: {
  icon: 'share' | 'download' | 'mail';
  label: string;
  onClick: () => void;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cx(
        'flex h-10 items-center justify-center gap-1.5 rounded-full text-[15px] font-medium text-accent hover:bg-chip disabled:opacity-40',
        showLabel ? 'px-3' : 'w-10',
      )}
    >
      <Icon name={icon} size={20} />
      {showLabel && <span className="hidden sm:inline">{label}</span>}
    </button>
  );
}

/** Share on a phone, Download on a computer, using the copy already fetched when there is one. */
function useHandOver(id: string, part?: 'eml') {
  const file = useFile(id, part);
  const save = useSaveFile();
  const toast = useToast();
  const share = sharesFiles();
  return {
    label: share ? 'Share' : 'Download',
    icon: (share ? 'share' : 'download') as 'share' | 'download',
    run: () => {
      // Straight from the tap when the file is here (iOS only shares from a fresh tap).
      if (file.data)
        void deliverFile(file.data).catch(() => toast({ text: 'Couldn’t share the file.' }));
      else void save(fileUrl(id, part), part === 'eml' ? 'original-email.eml' : 'document');
    },
  };
}

function DocScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const doc = useDocument(id);
  const { open } = useViewer();
  const hand = useHandOver(id);
  const d = doc.data?.document;
  return (
    <Screen
      title={d?.filename ?? 'Document'}
      onBack={onBack}
      actions={
        <>
          {d?.has_eml && (
            <BarButton icon="mail" label="Original email" onClick={() => open('email', id)} />
          )}
          <BarButton icon={hand.icon} label={hand.label} onClick={hand.run} showLabel />
        </>
      }
    >
      {d ? (
        <DocPreview doc={d} fill bare className="min-h-0 flex-1" />
      ) : doc.error ? (
        <p className="p-6 text-sm text-soft">This document couldn’t be found.</p>
      ) : (
        <div className="flex-1 bg-chip" />
      )}
    </Screen>
  );
}

function EmailScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const email = useQuery({
    queryKey: ['email', id],
    queryFn: () => api.get<EmailView>(`/documents/${id}/email`),
    staleTime: Infinity,
    retry: false,
  });
  const hand = useHandOver(id, 'eml');
  const e = email.data;
  return (
    <Screen
      title="Original email"
      onBack={onBack}
      actions={
        <BarButton
          icon={hand.icon}
          label={`${hand.label} .eml`}
          onClick={hand.run}
          disabled={!e && !!email.error}
          showLabel
        />
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {e ? (
          <article className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-5">
            <h1 className="text-xl leading-snug font-semibold tracking-tight text-balance text-ink">
              {e.subject || '(no subject)'}
            </h1>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <EmailField label="From" value={e.from} />
              <EmailField label="To" value={e.to} />
              <EmailField label="Cc" value={e.cc} />
              <EmailField label="Date" value={e.date ? formatDate(e.date.slice(0, 10)) : ''} />
            </dl>
            {e.attachments.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {e.attachments.map((a, i) => (
                  <li
                    key={i}
                    className="flex max-w-full items-center gap-1.5 rounded-full bg-chip px-3 py-1.5 text-xs text-soft"
                  >
                    <Icon name="file" size={14} className="text-faint" />
                    <span className="truncate">{a.filename}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-line pt-4 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-ink">
              {e.text || 'This email has no text.'}
            </div>
          </article>
        ) : email.error ? (
          <p className="p-6 text-sm text-soft">
            This email can’t be shown here. {hand.label} the .eml file instead.
          </p>
        ) : (
          <p className="p-6 text-sm text-faint">Loading…</p>
        )}
      </div>
    </Screen>
  );
}

function EmailField({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{value}</dd>
    </>
  );
}
