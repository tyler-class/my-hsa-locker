import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ACCEPTED_MIME, MAX_UPLOAD_BYTES } from '@shared/lookups';
import type { DocumentSummary } from '@shared/types';
import { api, errorMessage, uploadFile } from '../lib/api';
import { bytes } from '../lib/format';
import { useRefreshData } from '../lib/queries';
import { Icon } from './Icon';
import { cx, GhostButton, PrimaryButton, Sheet } from './ui';

interface Item {
  key: string;
  file: File;
  progress: number;
  state: 'queued' | 'uploading' | 'reading' | 'done' | 'review' | 'duplicate' | 'error';
  docId?: string;
  message?: string;
}

const LABEL: Record<Item['state'], string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  reading: 'Reading…',
  done: 'Done',
  review: 'Needs review',
  duplicate: 'Already here',
  error: 'Failed',
};

/** Multi-file upload: drag and drop on desktop, camera or photos on phones. */
export function UploadSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const refresh = useRefreshData();
  const nav = useNavigate();
  // Polls the documents still being read.
  const docStatus = useDocStatuses(items.filter((i) => i.state === 'reading').map((i) => i.docId!));
  const shown = items.map((i) => {
    const s = i.docId ? docStatus.get(i.docId) : undefined;
    if (i.state !== 'reading' || !s) return i;
    if (s === 'processed') return { ...i, state: 'done' as const };
    if (s === 'needs_review') return { ...i, state: 'review' as const };
    return i;
  });

  const update = (key: string, patch: Partial<Item>) =>
    setItems((list) => list.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function add(files: FileList | File[] | null) {
    if (!files) return;
    const next = [...files].map((file) => ({
      key: `${file.name}-${file.size}-${Math.random()}`,
      file,
      progress: 0,
      state: 'queued' as const,
    }));
    setItems((list) => [...list, ...next]);
    for (const it of next) {
      if (it.file.size > MAX_UPLOAD_BYTES) {
        update(it.key, { state: 'error', message: 'Larger than 20 MB.' });
        continue;
      }
      if (it.file.type && !(ACCEPTED_MIME as readonly string[]).includes(it.file.type)) {
        update(it.key, { state: 'error', message: 'Use a PDF or photo.' });
        continue;
      }
      update(it.key, { state: 'uploading' });
      try {
        const r = await uploadFile(it.file, (p) => update(it.key, { progress: p }));
        update(it.key, {
          state: r.duplicate ? 'duplicate' : 'reading',
          docId: r.document?.id,
          progress: 1,
        });
      } catch (e) {
        update(it.key, { state: 'error', message: errorMessage(e) });
      }
    }
    refresh();
  }

  const close = () => {
    setItems([]);
    onClose();
  };
  const anyReview = shown.some((i) => i.state === 'review');

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Add receipts"
      sub="PDFs or photos. Each is read automatically."
      footer={
        <>
          <GhostButton onClick={close}>Close</GhostButton>
          {anyReview && (
            <PrimaryButton
              onClick={() => {
                close();
                nav('/review');
              }}
            >
              Go to Review
            </PrimaryButton>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4 py-2">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            add(e.dataTransfer.files);
          }}
          className={cx(
            'flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center',
            drag ? 'border-accent bg-accent-tint' : 'border-line',
          )}
        >
          <Icon name="upload" size={26} className="text-accent" />
          <p className="hidden text-sm text-soft sm:block">Drop files here, or</p>
          <div className="flex flex-wrap justify-center gap-2">
            <PrimaryButton icon="file" onClick={() => fileRef.current?.click()}>
              Choose files
            </PrimaryButton>
            <PrimaryButton
              tone="secondary"
              icon="camera"
              className="sm:hidden"
              onClick={() => cameraRef.current?.click()}
            >
              Take photo
            </PrimaryButton>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept="image/*,application/pdf"
            onChange={(e) => (add(e.target.files), (e.target.value = ''))}
          />
          <input
            ref={cameraRef}
            type="file"
            hidden
            accept="image/*"
            capture="environment"
            onChange={(e) => (add(e.target.files), (e.target.value = ''))}
          />
        </div>
        {shown.length > 0 && (
          <ul className="flex flex-col">
            {shown.map((i) => (
              <li
                key={i.key}
                className="flex items-center gap-3 border-b border-line py-2.5 text-sm"
              >
                <Icon name="file" size={16} className="text-faint" />
                <span className="min-w-0 flex-1 truncate">{i.file.name}</span>
                <span className="text-xs text-faint tnum">{bytes(i.file.size)}</span>
                <span
                  className={cx(
                    'w-28 text-right text-xs',
                    i.state === 'error'
                      ? 'text-danger'
                      : i.state === 'review'
                        ? 'text-warn'
                        : i.state === 'done'
                          ? 'text-ok'
                          : 'text-soft',
                  )}
                  title={i.message}
                >
                  {i.state === 'uploading'
                    ? `${Math.round(i.progress * 100)}%`
                    : (i.message ?? LABEL[i.state])}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

function useDocStatuses(ids: string[]): Map<string, string> {
  const q = useQuery({
    queryKey: ['upload-status', ids.join(',')],
    enabled: ids.length > 0,
    queryFn: async () =>
      (await api.get<{ documents: DocumentSummary[] }>(`/documents?ids=${ids.join(',')}`))
        .documents,
    refetchInterval: 3000,
  });
  return new Map((q.data ?? []).map((d) => [d.id, d.status]));
}
