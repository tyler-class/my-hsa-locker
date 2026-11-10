// Storing an original file: R2 bytes + a pending documents row. Shared by upload, email and import.
import { extForMime, sniffMime } from '@shared/logic';
import type { DocSource, SourceMeta } from '@shared/types';
import { first, newId, nowIso } from './db';

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function cleanFilename(name: string | null | undefined, fallback: string): string {
  const n = (name ?? '')
    .replace(/[\\/\0\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return n || fallback;
}

export interface StoreInput {
  bytes: Uint8Array;
  filename: string;
  /** Declared type; the sniffed type wins for binary files. */
  mime: string;
  source: DocSource;
  meta?: SourceMeta;
  inboxLogId?: string | null;
  emlKey?: string | null;
  legacyMd5?: string | null;
  receivedAt?: string;
  /** Documents created already-processed (imports) skip the queue. */
  status?: 'pending' | 'processed' | 'needs_review';
  kind?: 'receipt' | 'eob' | 'unknown';
  reviewReasons?: string[];
}

export type StoreResult =
  { ok: true; id: string; sha256: string } | { ok: false; duplicateOf: string; sha256: string };

/** Stores a file unless the same bytes are already stored (not discarded). */
export async function storeDocument(env: Cloudflare.Env, input: StoreInput): Promise<StoreResult> {
  const hash = await sha256Hex(input.bytes);
  const existing = await first<{ id: string }>(
    env.DB,
    "SELECT id FROM documents WHERE sha256 = ? AND status != 'discarded'",
    hash,
  );
  if (existing) return { ok: false, duplicateOf: existing.id, sha256: hash };

  const sniffed = input.mime.startsWith('text/') ? null : sniffMime(input.bytes);
  const mime = sniffed ?? input.mime;
  const id = newId();
  const key = `docs/${id}.${extForMime(mime)}`;
  await env.FILES.put(key, input.bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { document_id: id },
  });
  const now = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO documents (id, kind, status, source, source_meta_json, inbox_log_id, file_key, eml_key,
         filename, mime, size_bytes, sha256, legacy_md5, review_reasons_json, received_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.kind ?? 'unknown',
        input.status ?? 'pending',
        input.source,
        JSON.stringify(input.meta ?? {}),
        input.inboxLogId ?? null,
        key,
        input.emlKey ?? null,
        input.filename,
        mime,
        input.bytes.byteLength,
        hash,
        input.legacyMd5 ?? null,
        JSON.stringify(input.reviewReasons ?? []),
        input.receivedAt ?? now,
        now,
        now,
      )
      .run();
  } catch (e) {
    // Lost a race with an identical file: keep the other one.
    await env.FILES.delete(key);
    const other = await first<{ id: string }>(
      env.DB,
      "SELECT id FROM documents WHERE sha256 = ? AND status != 'discarded'",
      hash,
    );
    if (other) return { ok: false, duplicateOf: other.id, sha256: hash };
    throw e;
  }
  return { ok: true, id, sha256: hash };
}
