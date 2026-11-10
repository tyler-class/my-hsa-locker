// Documents: upload, list, detail, the original file, reprocess, discard, and queue actions.
import { Hono } from 'hono';
import PostalMime from 'postal-mime';
import { ACCEPTED_MIME, MAX_UPLOAD_BYTES } from '@shared/lookups';
import { mimeFromName, sniffMime } from '@shared/logic';
import { entryCreate } from '@shared/schemas';
import {
  all,
  DOC_COLUMNS,
  first,
  insertStmt,
  newId,
  nowIso,
  toDocument,
  toEntry,
  type Row,
} from '../db';
import { MAX_ATTEMPTS, processDocument, sweep } from '../extract/pipeline';
import { htmlToText } from '../extract/text';
import { cleanFilename, storeDocument } from '../store';
import { refreshDocStatus } from '../status';
import { ApiError, body, notFound, type AppEnv } from './util';

export const documents = new Hono<AppEnv>();

const ACCEPTED = new Set<string>(ACCEPTED_MIME);

// Raw-body upload, one file per request (the app shows progress per file).
// Headers: Content-Type (the file's type), X-File-Name (URI-encoded).
documents.post('/documents', async (c) => {
  const declared = Number(c.req.header('Content-Length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES)
    throw new ApiError(413, 'too_large', 'Files can be 20 MB at most.');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.byteLength) throw new ApiError(400, 'invalid', 'The file is empty.');
  if (bytes.byteLength > MAX_UPLOAD_BYTES)
    throw new ApiError(413, 'too_large', 'Files can be 20 MB at most.');
  let name = 'document';
  try {
    name = decodeURIComponent(c.req.header('X-File-Name') ?? 'document');
  } catch {
    /* keep the default */
  }
  const mime =
    sniffMime(bytes) ?? mimeFromName(name) ?? (c.req.header('Content-Type') ?? '').split(';')[0]!;
  if (!ACCEPTED.has(mime))
    throw new ApiError(415, 'unsupported', 'Upload a PDF or a photo (JPEG, PNG, WebP or HEIC).');

  const r = await storeDocument(c.env, {
    bytes,
    filename: cleanFilename(name, 'document'),
    mime,
    source: 'upload',
    meta: { part_name: name },
  });
  if (!r.ok) {
    const doc = await first(
      c.env.DB,
      `SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ?`,
      r.duplicateOf,
    );
    return c.json({ duplicate: true, document: doc ? toDocument(doc) : null }, 200);
  }
  c.executionCtx.waitUntil(processDocument(c.env, r.id).catch(() => {}));
  const doc = await first(c.env.DB, `SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ?`, r.id);
  return c.json({ duplicate: false, document: toDocument(doc!) }, 201);
});

documents.get('/documents', async (c) => {
  const status = c.req.query('status');
  const ids = c.req.query('ids');
  const binds: unknown[] = [];
  let where = "d.status != 'discarded'";
  if (status === 'in_flight') where += " AND d.status IN ('pending', 'processing', 'failed')";
  else if (status) {
    where += ' AND d.status = ?';
    binds.push(status);
  }
  if (ids) {
    const list = ids.split(',').slice(0, 90);
    where += ` AND d.id IN (${list.map(() => '?').join(',')})`;
    binds.push(...list);
  }
  const limit = Math.min(500, Number(c.req.query('limit') ?? 200) || 200);
  const rows = await all(
    c.env.DB,
    `SELECT ${DOC_COLUMNS} FROM documents d WHERE ${where} ORDER BY d.received_at DESC LIMIT ?`,
    ...binds,
    limit,
  );
  return c.json({ documents: rows.map(toDocument) });
});

async function loadDoc(db: D1Database, id: string) {
  const row = await first<Row>(
    db,
    `SELECT ${DOC_COLUMNS}, d.file_key FROM documents d WHERE d.id = ?`,
    id,
  );
  if (!row) throw notFound('Document');
  return row;
}

documents.get('/documents/:id', async (c) => {
  const row = await loadDoc(c.env.DB, c.req.param('id'));
  const entries = (
    await all(c.env.DB, 'SELECT * FROM entries WHERE document_id = ? ORDER BY sort_order', row.id)
  ).map(toEntry);
  const inbox = row.inbox_log_id
    ? await first(c.env.DB, 'SELECT * FROM inbox_log WHERE id = ?', row.inbox_log_id)
    : null;
  return c.json({ document: toDocument(row), entries, inbox });
});

/** The original file, to signed-in users only. ?download=1 saves instead of previewing. */
documents.get('/files/:id', async (c) => {
  const row = await loadDoc(c.env.DB, c.req.param('id'));
  const eml = c.req.query('part') === 'eml';
  const key = eml ? (row.eml_key as string | null) : String(row.file_key);
  if (!key) throw notFound('Email');
  const obj = await c.env.FILES.get(key);
  if (!obj) throw notFound('File');
  const mime = eml ? 'message/rfc822' : String(row.mime);
  const name = eml ? 'original-email.eml' : String(row.filename);
  // HTML bodies are shown as text so nothing in an email can run in the app's origin.
  const safeType = mime === 'text/html' ? 'text/plain; charset=utf-8' : mime;
  const inline = c.req.query('download') !== '1' && !eml && mime !== 'text/html';
  return new Response(obj.body, {
    headers: {
      'Content-Type': safeType,
      'Content-Length': String(obj.size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      // Chrome's PDF viewer refuses sandboxed documents, so only non-PDFs are sandboxed.
      'Content-Security-Policy':
        mime === 'application/pdf'
          ? "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'"
          : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
});

/** The kept original email, read for the app's email view: headers, plain body, attachment names. */
documents.get('/documents/:id/email', async (c) => {
  const row = await loadDoc(c.env.DB, c.req.param('id'));
  if (!row.eml_key) throw notFound('Email');
  const obj = await c.env.FILES.get(String(row.eml_key));
  if (!obj) throw notFound('Email');
  const email = await PostalMime.parse(await obj.arrayBuffer());
  const who = (a?: { name?: string; address?: string } | null) =>
    a ? (a.name && a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? '')) : '';
  const list = (l?: { name?: string; address?: string }[]) =>
    (l ?? []).map(who).filter(Boolean).join(', ');
  const text = (email.text?.trim() ? email.text : email.html ? htmlToText(email.html) : '').trim();
  return c.json({
    from: who(email.from),
    to: list(email.to),
    cc: list(email.cc),
    date: email.date ?? null,
    subject: email.subject ?? '',
    text: text.slice(0, 200_000),
    attachments: email.attachments
      .filter((a) => a.disposition !== 'inline' || !a.contentId)
      .map((a) => ({
        filename: a.filename ?? 'attachment',
        mime: a.mimeType,
        size: typeof a.content === 'string' ? a.content.length : a.content.byteLength,
      })),
  });
});

async function reimbursedCount(db: D1Database, docId: string) {
  return (
    (
      await first<{ n: number }>(
        db,
        'SELECT COUNT(*) AS n FROM entries WHERE document_id = ? AND reimbursement_id IS NOT NULL',
        docId,
      )
    )?.n ?? 0
  );
}

documents.post('/documents/:id/reprocess', async (c) => {
  const row = await loadDoc(c.env.DB, c.req.param('id'));
  if (row.status === 'discarded')
    throw new ApiError(409, 'discarded', 'This document was discarded.');
  if (await reimbursedCount(c.env.DB, String(row.id)))
    throw new ApiError(
      409,
      'reimbursed',
      'Some of this document’s receipts are marked reimbursed. Undo that first, then reprocess.',
    );
  await c.env.DB.prepare(
    `UPDATE documents SET status = 'pending', attempts = 0, next_attempt_at = NULL, error = NULL,
       review_reasons_json = '[]', updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), row.id)
    .run();
  c.executionCtx.waitUntil(processDocument(c.env, String(row.id)).catch(() => {}));
  return c.json({ ok: true });
});

documents.post('/documents/:id/discard', async (c) => {
  const db = c.env.DB;
  const row = await loadDoc(db, c.req.param('id'));
  if (await reimbursedCount(db, String(row.id)))
    throw new ApiError(
      409,
      'reimbursed',
      'Some of this document’s receipts are marked reimbursed. Undo that first.',
    );
  await db.batch([
    db
      .prepare(
        'UPDATE entries SET dup_of_entry_id = NULL WHERE dup_of_entry_id IN (SELECT id FROM entries WHERE document_id = ?)',
      )
      .bind(row.id),
    db.prepare('DELETE FROM entries WHERE document_id = ?').bind(row.id),
    db
      .prepare(
        "UPDATE documents SET status = 'discarded', extraction_json = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(nowIso(), row.id),
  ]);
  // The file goes; the row stays as a record that it was received and discarded.
  await c.env.FILES.delete(String(row.file_key));
  return c.json({ ok: true });
});

/** Clears document-level review reasons (e.g. after typing a scanned receipt in by hand). */
documents.post('/documents/:id/approve', async (c) => {
  const row = await loadDoc(c.env.DB, c.req.param('id'));
  await c.env.DB.prepare(
    "UPDATE documents SET review_reasons_json = '[]', updated_at = ? WHERE id = ?",
  )
    .bind(nowIso(), row.id)
    .run();
  if (row.status === 'failed' || row.status === 'pending')
    await c.env.DB.prepare("UPDATE documents SET status = 'needs_review' WHERE id = ?")
      .bind(row.id)
      .run();
  await refreshDocStatus(c.env.DB, String(row.id));
  return c.json({ ok: true });
});

/** Adds an entry by hand (scanned PDFs, or anything the model missed). */
documents.post('/documents/:id/entries', async (c) => {
  const db = c.env.DB;
  const row = await loadDoc(db, c.req.param('id'));
  const input = await body(c, entryCreate);
  const now = nowIso();
  const count =
    (
      await first<{ n: number }>(
        db,
        'SELECT COUNT(*) AS n FROM entries WHERE document_id = ?',
        row.id,
      )
    )?.n ?? 0;
  const id = newId();
  await db.batch([
    insertStmt(db, 'entries', {
      id,
      document_id: row.id,
      ...input,
      excluded_auto: 0,
      review_reasons_json: '[]',
      reviewed_at: now,
      sort_order: count,
      created_at: now,
      updated_at: now,
    }),
    db
      .prepare(
        `UPDATE documents SET kind = CASE WHEN kind = 'unknown' THEN ? ELSE kind END,
           status = CASE WHEN status IN ('pending', 'failed', 'processing') THEN 'needs_review' ELSE status END,
           updated_at = ? WHERE id = ?`,
      )
      .bind(input.type, now, row.id),
  ]);
  await refreshDocStatus(db, String(row.id));
  const e = await first(db, 'SELECT * FROM entries WHERE id = ?', id);
  return c.json(toEntry(e!), 201);
});

/** Runs the queue now instead of waiting for the next cron tick. */
documents.post('/documents/process-now', async (c) => {
  c.executionCtx.waitUntil(sweep(c.env, 5).catch(() => 0));
  return c.json({ ok: true });
});

/** Gives failed documents (and ones that ran out of attempts) a fresh set of attempts. */
documents.post('/documents/retry-failed', async (c) => {
  const now = nowIso();
  const res = await c.env.DB.prepare(
    `UPDATE documents SET status = 'pending', attempts = 0, next_attempt_at = NULL, error = NULL,
       review_reasons_json = '[]', updated_at = ?
     WHERE status = 'failed' OR (status = 'needs_review' AND review_reasons_json LIKE '%extraction_failed%'
       AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.document_id = documents.id))`,
  )
    .bind(now)
    .run();
  c.executionCtx.waitUntil(sweep(c.env, 5).catch(() => 0));
  return c.json({ ok: true, retried: res.meta.changes ?? 0, max_attempts: MAX_ATTEMPTS });
});
