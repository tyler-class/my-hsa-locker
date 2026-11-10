// File names and email-part filtering.
import { centsToDecimal } from './money';

export const LOGGED_PREFIX = '[LOGGED] ';

/** Strips HSA Wizard's "[LOGGED] " and "[DUPE SET n] " / "[ORIG. DUPE SET n] " prefixes. */
export function stripLegacyPrefixes(name: string): string {
  let s = name.trim();
  for (;;) {
    const next = s.replace(/^\[LOGGED\]\s*/i, '').replace(/^\[(?:ORIG\. )?DUPE SET \d+\]\s*/i, '');
    if (next === s) return s;
    s = next;
  }
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'text/html': 'html',
  'message/rfc822': 'eml',
};
export function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? 'bin';
}

/** Mime type from a file name, for when the sender didn't say. */
export function mimeFromName(name: string): string | null {
  const e = extOf(name);
  return (
    (
      {
        pdf: 'application/pdf',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        heic: 'image/heic',
        heif: 'image/heif',
      } as Record<string, string>
    )[e] ?? null
  );
}

/** The real type from a file's first bytes, or null if it isn't one we read. */
export function sniffMime(bytes: Uint8Array): string | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, j) => bytes[i + j] === b);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (ascii(0, '%PDF-')) return 'application/pdf';
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (
    ascii(4, 'ftyp') &&
    /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(String.fromCharCode(...bytes.slice(8, 12)))
  )
    return 'image/heic';
  return null;
}

const safe = (s: string | null | undefined) =>
  (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** "2024-03-05_Sam-Example_Riverside-PT_125.00.pdf" for exports. */
export function exportFilename(p: {
  date: string | null;
  person: string | null;
  provider: string | null;
  amount_cents: number | null;
  ext: string;
}): string {
  const parts = [p.date ?? 'undated', safe(p.person) || 'Unknown', safe(p.provider) || 'Unknown'];
  if (p.amount_cents !== null) parts.push(centsToDecimal(p.amount_cents));
  return `${parts.join('_')}.${p.ext || 'bin'}`;
}

/** Makes names unique within a ZIP by adding " (2)", " (3)"… */
export function uniqueNames(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((n) => {
    const k = n.toLowerCase();
    const count = used.get(k) ?? 0;
    used.set(k, count + 1);
    if (!count) return n;
    const dot = n.lastIndexOf('.');
    return dot > 0 ? `${n.slice(0, dot)} (${count + 1})${n.slice(dot)}` : `${n} (${count + 1})`;
  });
}

export interface MailPart {
  filename: string | null;
  mimeType: string;
  disposition: 'attachment' | 'inline' | null;
  contentId?: string | null;
  size: number;
}

/**
 * Which email parts become documents. HSA Wizard kept every PDF, and images at or above
 * "Min Image Size (KB)". Here, in addition: only types we can read, and inline images that are
 * referenced from the HTML (cid:) or look like logos/signatures are skipped regardless of size.
 */
export function keepPart(
  part: MailPart,
  opts: { minBytes: number; referencedCids?: Set<string> },
): { keep: boolean; reason?: string } {
  const mime = part.mimeType.toLowerCase();
  const name = (part.filename ?? '').toLowerCase();
  const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
  const isImage = mime.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/.test(name);
  if (!isPdf && !isImage) return { keep: false, reason: 'unsupported_type' };
  if (isPdf) return { keep: true };
  if (!/^image\/(png|jpe?g|webp|heic|heif)$/.test(mime) && !mimeFromName(name))
    return { keep: false, reason: 'unsupported_type' };
  if (part.size < opts.minBytes) return { keep: false, reason: 'too_small' };
  const cid = (part.contentId ?? '').replace(/[<>]/g, '');
  if (part.disposition === 'inline' && cid && opts.referencedCids?.has(cid))
    return { keep: false, reason: 'inline_image' };
  if (/(logo|signature|banner|icon|facebook|twitter|linkedin|instagram|spacer|pixel)/.test(name))
    return { keep: false, reason: 'logo' };
  return { keep: true };
}
