// Words for a document still being read (the Ledger's placeholder rows).
import type { DocumentSummary } from '@shared/types';

/** Names a phone or camera gives a photo ("IMG_1234.HEIC", "image.jpg", "PXL_2026…"). */
const CAMERA_NAME =
  /^(img|image|photo|pxl|dsc|dscn|dcim|mvimg|screenshot|scan|document|camera)?[\s_-]*[\d\s_.-]*(\.\w+)?$/i;

/** What to call a document being read: its name, or "Photo" for a camera's file name. */
export function readingTitle(d: Pick<DocumentSummary, 'filename' | 'mime'>) {
  if (d.mime.startsWith('image/') && CAMERA_NAME.test(d.filename.trim())) return 'Photo';
  return d.filename || (d.mime.startsWith('image/') ? 'Photo' : 'Document');
}

/** "3:42 PM", in this device's way of writing times. */
function localClock(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Where it stands, in plain words. */
export function readingStatus(
  d: Pick<DocumentSummary, 'status' | 'next_attempt_at'>,
  now = Date.now(),
  clock = localClock,
): { label: string; retrying: boolean } {
  if (d.status !== 'failed') return { label: 'Reading…', retrying: false };
  const at = d.next_attempt_at;
  return {
    label:
      at && new Date(at).getTime() > now
        ? `Couldn’t read it yet · trying again at ${clock(at)}`
        : 'Couldn’t read it yet · trying again now',
    retrying: true,
  };
}

/** A photo being read with no reading copy yet (the server says which have one). */
export function needsCopy(d: { mime: string; status: string; has_reading_copy?: boolean }) {
  return (
    d.mime.startsWith('image/') &&
    d.has_reading_copy === false &&
    ['pending', 'processing', 'failed'].includes(d.status)
  );
}
