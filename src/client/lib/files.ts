// Getting a file out of the app without leaving it. An installed iPhone app has no back button,
// so navigating to a file (or a download) can strand you in a full-screen viewer with no way out.
// Instead the file is fetched here and handed over: phones and tablets get the share sheet
// (Save to Files, Mail, AirDrop…), computers get an ordinary download. Same idea as Duffel's
// itinerary PDF.
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useToast } from '../components/Toast';

/** The original file of a document; `eml` is the email it came in. */
export function fileUrl(id: string, part?: 'eml'): string {
  return part === 'eml' ? `/api/files/${id}?part=eml` : `/api/files/${id}?download=1`;
}

/** The name in a Content-Disposition header, if it has one. */
export function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      /* fall through to the plain name */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1]!.trim() : null;
}

/** Fetches a same-origin file as a File, named the way the server names it. */
export async function fetchFile(url: string, fallbackName: string): Promise<File> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok)
    throw new Error(res.status === 404 ? 'That file is gone.' : 'Couldn’t get the file.');
  const blob = await res.blob();
  const name = filenameFrom(res.headers.get('Content-Disposition')) ?? fallbackName;
  return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}

/** Phones and tablets share files; computers download them. */
export const sharesFiles = () =>
  window.matchMedia?.('(pointer: coarse)').matches && typeof navigator.share === 'function';

export type Delivered = 'shared' | 'saved' | 'cancelled' | 'needs-tap';

/**
 * Hands a file over: the share sheet on a phone, a download on a computer. 'needs-tap' when the
 * browser wants a fresh tap before sharing (iOS, if the fetch before it was slow).
 */
export async function deliverFile(file: File): Promise<Delivered> {
  if (sharesFiles() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'AbortError') return 'cancelled';
      if (name === 'NotAllowedError') return 'needs-tap';
      throw e;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'saved';
}

/**
 * Fetches and hands over a file in one go. When iOS wants a fresh tap, `retry` is given a
 * function to call from that tap (e.g. a toast's button).
 */
export async function saveFromUrl(
  url: string,
  fallbackName: string,
  retry: (again: () => void) => void,
): Promise<Delivered> {
  const file = await fetchFile(url, fallbackName);
  const r = await deliverFile(file);
  if (r === 'needs-tap') retry(() => void deliverFile(file));
  return r;
}

/**
 * A document's original file (or its email), fetched once and kept briefly: the PDF preview,
 * the full-screen viewer and Share all use the same copy.
 */
export function useFile(id: string | null, part?: 'eml', enabled = true) {
  return useQuery({
    queryKey: ['file', id, part ?? 'file'],
    enabled: !!id && enabled,
    queryFn: () =>
      fetchFile(fileUrl(id!, part), part === 'eml' ? 'original-email.eml' : 'document'),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
}

/** Fetches a file and shares or downloads it, with a toast for errors and iOS's extra tap. */
export function useSaveFile() {
  const toast = useToast();
  return useCallback(
    async (url: string, fallbackName: string) => {
      try {
        await saveFromUrl(url, fallbackName, (again) =>
          toast({ text: 'Ready to share.', action: { label: 'Share', icon: 'share', run: again } }),
        );
      } catch (e) {
        toast({ text: e instanceof Error ? e.message : 'Couldn’t get the file.' });
      }
    },
    [toast],
  );
}
