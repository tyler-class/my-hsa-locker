// Endpoints the HSA Wizard import script uses (scripts/import-from-hsa-wizard.ts). Both are
// idempotent: re-running an import never duplicates documents or entries.
import { Hono } from 'hono';
import { z } from 'zod';
import { applyHsaCards } from '@shared/logic';
import { ACCEPTED_MIME, MAX_UPLOAD_BYTES } from '@shared/lookups';
import { first, insertStmt, loadSettings, newId, nowIso } from '../db';
import { cleanFilename, storeDocument } from '../store';
import { ApiError, body, notFound, type AppEnv } from './util';

export const legacy = new Hono<AppEnv>();

/** Stores an original file without reading it (the legacy rows come separately). */
legacy.post('/legacy-import/document', async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES)
    throw new ApiError(413, 'too_large', 'Files can be 20 MB at most.');
  const header = (k: string) => {
    try {
      return decodeURIComponent(c.req.header(k) ?? '');
    } catch {
      return '';
    }
  };
  const filename = cleanFilename(header('X-File-Name'), 'document');
  let mime = (c.req.header('Content-Type') ?? '').split(';')[0]!;
  // Rows whose file wasn't found get a short text placeholder so their entries still import.
  if (!bytes.byteLength) throw new ApiError(400, 'invalid', 'The file is empty.');
  if (mime !== 'text/plain' && !(ACCEPTED_MIME as readonly string[]).includes(mime))
    mime = 'application/octet-stream';
  const received = header('X-Received-At');
  const r = await storeDocument(c.env, {
    bytes,
    filename,
    mime,
    source: 'import',
    meta: { part_name: header('X-Original-Name') || filename },
    legacyMd5: header('X-Legacy-Md5') || null,
    receivedAt: /^\d{4}-\d{2}-\d{2}/.test(received) ? new Date(received).toISOString() : undefined,
    status: 'processed',
  });
  return c.json({ id: r.ok ? r.id : r.duplicateOf, duplicate: !r.ok }, r.ok ? 201 : 200);
});

const legacyEntry = z.object({
  type: z.enum(['receipt', 'eob']),
  service_date: z.string().nullable(),
  payment_date: z.string().nullable(),
  person_id: z.string().nullable(),
  patient_name_raw: z.string().nullable(),
  provider_id: z.string().nullable(),
  provider_name_raw: z.string().nullable(),
  description: z.string().nullable(),
  category_id: z.string().nullable(),
  amount_cents: z.number().int().nullable(),
  card_last4: z.string().nullable(),
  notes: z.string().nullable(),
  review_reasons: z.array(z.string()),
  processed_at: z.string().nullable(),
});

const legacyEntries = z.object({
  document_id: z.string(),
  kind: z.enum(['receipt', 'eob', 'unknown']),
  document_reasons: z.array(z.string()).default([]),
  entries: z.array(legacyEntry).max(500),
});

/** Adds a document's entries, once. A document that already has entries is left alone. */
legacy.post('/legacy-import/entries', async (c) => {
  const db = c.env.DB;
  const input = await body(c, legacyEntries);
  const doc = await first<{ id: string }>(
    db,
    'SELECT id FROM documents WHERE id = ?',
    input.document_id,
  );
  if (!doc) throw notFound('Document');
  const existing = await first<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM entries WHERE document_id = ?',
    doc.id,
  );
  if ((existing?.n ?? 0) > 0) return c.json({ ok: true, skipped: true, added: 0 });
  const settings = await loadSettings(db);
  const now = nowIso();
  const rows = input.entries.map((e, i) => {
    const cards = applyHsaCards(
      { type: e.type, card_last4: e.card_last4, excluded_reason: null, excluded_auto: false },
      settings.hsa_cards,
    );
    return insertStmt(db, 'entries', {
      id: newId(),
      document_id: doc.id,
      type: e.type,
      service_date: e.service_date,
      payment_date: e.payment_date,
      person_id: e.person_id,
      patient_name_raw: e.patient_name_raw,
      provider_id: e.provider_id,
      provider_name_raw: e.provider_name_raw,
      description: e.description,
      category_id: e.category_id,
      amount_cents: e.type === 'eob' ? null : e.amount_cents,
      card_last4: e.card_last4,
      notes: e.notes,
      review_reasons_json: JSON.stringify(e.review_reasons),
      excluded_reason: cards.excluded_reason,
      excluded_auto: cards.excluded_auto ? 1 : 0,
      sort_order: i,
      created_at: e.processed_at ?? now,
      updated_at: now,
    });
  });
  const anyReview =
    input.document_reasons.length || input.entries.some((e) => e.review_reasons.length);
  await db.batch([
    ...rows,
    db
      .prepare(
        `UPDATE documents SET kind = ?, status = ?, review_reasons_json = ?, extraction_provider = 'hsa-wizard',
           processed_at = COALESCE(processed_at, ?), updated_at = ? WHERE id = ?`,
      )
      .bind(
        input.kind,
        anyReview ? 'needs_review' : 'processed',
        JSON.stringify(input.document_reasons),
        now,
        now,
        doc.id,
      ),
  ]);
  return c.json({ ok: true, skipped: false, added: rows.length });
});
