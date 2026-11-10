// Keeps a document's status in step with its entries after edits in Review.
import { arr, first, nowIso } from './db';

/** processed ↔ needs_review, from the document's own reasons and its entries'. */
export async function refreshDocStatus(db: D1Database, docId: string): Promise<void> {
  const doc = await first<{ status: string; review_reasons_json: string }>(
    db,
    'SELECT status, review_reasons_json FROM documents WHERE id = ?',
    docId,
  );
  if (!doc || !['processed', 'needs_review'].includes(doc.status)) return;
  const pending = await first<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM entries WHERE document_id = ? AND review_reasons_json != '[]'",
    docId,
  );
  const next =
    arr(doc.review_reasons_json).length || (pending?.n ?? 0) ? 'needs_review' : 'processed';
  if (next !== doc.status)
    await db
      .prepare('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?')
      .bind(next, nowIso(), docId)
      .run();
}

export async function refreshDocs(db: D1Database, docIds: Iterable<string>): Promise<void> {
  for (const id of new Set(docIds)) await refreshDocStatus(db, id);
}
