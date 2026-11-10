// Getting text out of documents without OCR.
// PDFs: Workers AI's toMarkdown reads the PDF's text layer on Cloudflare's side (free, and it
// keeps PDF parsing off this Worker's CPU budget). It does not OCR, so scanned PDFs come back
// nearly empty and go to the vision path or to review.
import { bytesToBinary } from '../bytes';

/** Below this many characters a PDF is treated as scanned (no usable text layer). */
export const MIN_TEXT_CHARS = 200;

export async function pdfText(
  env: Cloudflare.Env,
  bytes: Uint8Array,
  name: string,
): Promise<string> {
  if (env.LLM_PROVIDER === 'fake') {
    // Tests: synthetic "PDFs" carry their text in the clear.
    return bytesToBinary(bytes).replace(/^%PDF-[\d.]*\s*/, '');
  }
  const res = await env.AI.toMarkdown({
    name,
    blob: new Blob([bytes], { type: 'application/pdf' }),
  });
  const one = Array.isArray(res) ? res[0] : res;
  if (!one || one.format === 'error') return '';
  return stripMarkdownNoise(String((one as { data?: string }).data ?? ''));
}

/** toMarkdown adds front matter and image placeholders; keep only the readable text. */
export function stripMarkdownNoise(md: string): string {
  return md
    .replace(/^---[\s\S]*?---\s*/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** Plain text from an HTML email body: drops scripts/styles, keeps line structure. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k]) return ENTITIES[k];
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)));
      return m;
    })
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
