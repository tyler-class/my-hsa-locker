// Entries (the ledger), the summary, and reimbursements.
import { Hono } from 'hono';
import {
  applyHsaCards,
  entryDate,
  entryStatus,
  filterFromParams,
  filterLedger,
  ledgerCsv,
  needsReview,
  resolvedReasons,
  summarize,
} from '@shared/logic';
import { bulkEntries, entryPatch, reimbursementInput, reimbursementPatch } from '@shared/schemas';
import type { Entry, LedgerEntry, Reimbursement } from '@shared/types';
import {
  all,
  chunks,
  first,
  loadCategories,
  loadPeople,
  loadProviders,
  loadSettings,
  marks,
  newId,
  nowIso,
  REVIEW_DOC_WHERE,
  toEntry,
  toLedgerEntry,
  updateStmt,
} from '../db';
import { refreshDocs, refreshDocStatus } from '../status';
import { ApiError, body, notFound, type AppEnv } from './util';

export const entries = new Hono<AppEnv>();

const LEDGER_SQL = `SELECT e.*, d.kind AS doc_kind, d.status AS doc_status, d.filename AS doc_filename,
  d.received_at AS doc_received_at
  FROM entries e JOIN documents d ON d.id = e.document_id WHERE d.status != 'discarded'`;

export async function loadLedger(db: D1Database): Promise<LedgerEntry[]> {
  return (await all(db, LEDGER_SQL)).map(toLedgerEntry);
}

async function loadEntry(db: D1Database, id: string): Promise<Entry> {
  const r = await first(db, 'SELECT * FROM entries WHERE id = ?', id);
  if (!r) throw notFound('Entry');
  return toEntry(r);
}

async function loadEntries(db: D1Database, ids: string[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const part of chunks(ids))
    out.push(
      ...(await all(db, `SELECT * FROM entries WHERE id IN (${marks(part.length)})`, ...part)).map(
        toEntry,
      ),
    );
  return out;
}

// ---------- summary ----------

entries.get('/summary', async (c) => {
  const db = c.env.DB;
  const [settings, ledger] = await Promise.all([loadSettings(db), loadLedger(db)]);
  const { all: totals, years } = summarize(ledger, settings.year_basis);
  const recent = [...ledger]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.sort_order - b.sort_order)
    .slice(0, 10);
  const thisYear = new Date().getUTCFullYear();
  return c.json({
    totals,
    years,
    this_year: years.find((y) => y.year === thisYear) ?? null,
    recent,
    year_basis: settings.year_basis,
  });
});

// ---------- ledger ----------

entries.get('/entries', async (c) => {
  const ledger = await loadLedger(c.env.DB);
  return c.json({ entries: ledger });
});

/** Review queue: entries with reasons, plus documents flagged on their own. */
entries.get('/review', async (c) => {
  const db = c.env.DB;
  const ledger = (await loadLedger(db)).filter(needsReview);
  const docs = await all(
    db,
    `SELECT d.id FROM documents d WHERE ${REVIEW_DOC_WHERE} ORDER BY d.received_at`,
  );
  return c.json({ document_ids: docs.map((d) => String(d.id)), entries: ledger });
});

entries.get('/entries/:id', async (c) => {
  const e = await first(c.env.DB, `${LEDGER_SQL} AND e.id = ?`, c.req.param('id'));
  if (!e) throw notFound('Entry');
  return c.json(toLedgerEntry(e));
});

entries.patch('/entries/:id', async (c) => {
  const db = c.env.DB;
  const before = await loadEntry(db, c.req.param('id'));
  const input = await body(c, entryPatch);
  const settings = await loadSettings(db);
  let next: Entry = { ...before, ...(input as Partial<Entry>) };
  if (next.type === 'eob') {
    next.amount_cents = null;
    next.reimbursement_id = before.reimbursement_id;
  }
  // A manual exclusion change wins; otherwise the HSA card list decides.
  if (input.excluded_reason !== undefined) next.excluded_auto = false;
  else if (input.card_last4 !== undefined) next = applyHsaCards(next, settings.hsa_cards);
  const reasons = resolvedReasons(next.review_reasons, next);
  if (next.type === 'eob' && before.reimbursement_id)
    throw new ApiError(
      409,
      'reimbursed',
      'Unmark this receipt as reimbursed before making it an EOB line.',
    );
  // Editing someone or a provider resolves the matching reasons.
  await updateStmt(db, 'entries', before.id, {
    ...input,
    ...(next.type === 'eob' ? { amount_cents: null, card_last4: null } : {}),
    excluded_reason: next.excluded_reason,
    excluded_auto: next.excluded_auto ? 1 : 0,
    review_reasons_json: JSON.stringify(reasons),
    ...(input.person_id !== undefined && next.person_id
      ? { patient_name_raw: before.patient_name_raw }
      : {}),
  }).run();
  await refreshDocStatus(db, before.document_id);
  return c.json(await loadEntry(db, before.id));
});

/** Approve: the user has checked it. Clears every reason. */
entries.post('/entries/:id/approve', async (c) => {
  const db = c.env.DB;
  const e = await loadEntry(db, c.req.param('id'));
  await updateStmt(db, 'entries', e.id, {
    review_reasons_json: '[]',
    reviewed_at: nowIso(),
  }).run();
  await refreshDocStatus(db, e.document_id);
  return c.json(await loadEntry(db, e.id));
});

/** Merge a possible duplicate: keep the earlier entry, drop this one. */
entries.post('/entries/:id/merge', async (c) => {
  const db = c.env.DB;
  const e = await loadEntry(db, c.req.param('id'));
  if (!e.dup_of_entry_id)
    throw new ApiError(400, 'invalid', 'This entry isn’t marked as a duplicate.');
  if (e.reimbursement_id)
    throw new ApiError(409, 'reimbursed', 'Unmark this receipt as reimbursed first.');
  await db.batch([
    db.prepare('UPDATE entries SET dup_of_entry_id = NULL WHERE dup_of_entry_id = ?').bind(e.id),
    db.prepare('DELETE FROM entries WHERE id = ?').bind(e.id),
  ]);
  await refreshDocStatus(db, e.document_id);
  return c.json({ ok: true, kept: e.dup_of_entry_id });
});

entries.delete('/entries/:id', async (c) => {
  const db = c.env.DB;
  const e = await loadEntry(db, c.req.param('id'));
  if (e.reimbursement_id)
    throw new ApiError(409, 'reimbursed', 'Unmark this receipt as reimbursed first.');
  await db.batch([
    db.prepare('UPDATE entries SET dup_of_entry_id = NULL WHERE dup_of_entry_id = ?').bind(e.id),
    db.prepare('DELETE FROM entries WHERE id = ?').bind(e.id),
  ]);
  await refreshDocStatus(db, e.document_id);
  return c.json({ ok: true });
});

entries.post('/entries/bulk', async (c) => {
  const db = c.env.DB;
  const input = await body(c, bulkEntries);
  const list = await loadEntries(db, input.ids);
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const e of list) {
    if (input.action === 'approve')
      stmts.push(updateStmt(db, 'entries', e.id, { review_reasons_json: '[]', reviewed_at: now }));
    else if (input.action === 'exclude') {
      if (e.type !== 'receipt') continue;
      stmts.push(
        updateStmt(db, 'entries', e.id, {
          excluded_reason: input.reason ?? 'not_eligible',
          excluded_auto: 0,
        }),
      );
    } else if (input.action === 'unexclude')
      stmts.push(updateStmt(db, 'entries', e.id, { excluded_reason: null, excluded_auto: 0 }));
    else if (input.action === 'delete') {
      if (e.reimbursement_id) continue;
      stmts.push(
        db
          .prepare('UPDATE entries SET dup_of_entry_id = NULL WHERE dup_of_entry_id = ?')
          .bind(e.id),
      );
      stmts.push(db.prepare('DELETE FROM entries WHERE id = ?').bind(e.id));
    }
  }
  if (stmts.length) await db.batch(stmts);
  await refreshDocs(
    db,
    list.map((e) => e.document_id),
  );
  return c.json({ ok: true, changed: list.length });
});

/** Ledger CSV, respecting the same filters as the app (query string). */
entries.get('/export/ledger.csv', async (c) => {
  const db = c.env.DB;
  const [settings, ledger, people, providers, categories, reimbursements] = await Promise.all([
    loadSettings(db),
    loadLedger(db),
    loadPeople(db),
    loadProviders(db),
    loadCategories(db),
    all<{ id: string; date: string }>(db, 'SELECT id, date FROM reimbursements'),
  ]);
  const names = {
    person: new Map(people.map((p) => [p.id, p.name])),
    provider: new Map(providers.map((p) => [p.id, p.name])),
    category: new Map(categories.map((x) => [x.id, x.name])),
  };
  const rDate = new Map(reimbursements.map((r) => [r.id, r.date]));
  const rows = filterLedger(
    ledger,
    filterFromParams(new URL(c.req.url).searchParams),
    settings.year_basis,
    names,
  );
  const csv = ledgerCsv(
    rows.map((e) => ({
      type: e.type,
      flagged: needsReview(e),
      service_date: e.service_date,
      payment_date: e.payment_date,
      person: (e.person_id && names.person.get(e.person_id)) || e.patient_name_raw,
      provider: (e.provider_id && names.provider.get(e.provider_id)) || e.provider_name_raw,
      description: e.description,
      category: e.category_id ? (names.category.get(e.category_id) ?? null) : null,
      amount_cents: e.amount_cents,
      card_last4: e.card_last4,
      status: entryStatus(e),
      excluded_reason: e.excluded_reason,
      reimbursement_date: e.reimbursement_id ? (rDate.get(e.reimbursement_id) ?? null) : null,
      filename: e.doc_filename,
      notes: e.notes,
      processed_at: e.doc_received_at,
      billed_cents: e.billed_cents,
      allowed_cents: e.allowed_cents,
      plan_paid_cents: e.plan_paid_cents,
      patient_resp_cents: e.patient_resp_cents,
      id: e.id,
      document_id: e.document_id,
    })),
  );
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="hsa-locker-ledger-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});

/** Everything the app needs to build the documents ZIP in the browser. */
entries.get('/export/manifest', async (c) => {
  const db = c.env.DB;
  const [settings, ledger, people, providers] = await Promise.all([
    loadSettings(db),
    loadLedger(db),
    loadPeople(db),
    loadProviders(db),
  ]);
  const docs = await all<{
    id: string;
    filename: string;
    mime: string;
    size_bytes: number;
    received_at: string;
  }>(
    db,
    "SELECT id, filename, mime, size_bytes, received_at FROM documents WHERE status != 'discarded' ORDER BY received_at",
  );
  const person = new Map(people.map((p) => [p.id, p.name]));
  const provider = new Map(providers.map((p) => [p.id, p.name]));
  const firstEntry = new Map<string, LedgerEntry>();
  for (const e of ledger) if (!firstEntry.has(e.document_id)) firstEntry.set(e.document_id, e);
  return c.json({
    documents: docs.map((d) => {
      const e = firstEntry.get(d.id);
      return {
        ...d,
        date: e ? entryDate(e, settings.year_basis) : d.received_at.slice(0, 10),
        person: e ? (e.person_id && person.get(e.person_id)) || e.patient_name_raw : null,
        provider: e ? (e.provider_id && provider.get(e.provider_id)) || e.provider_name_raw : null,
        amount_cents: e && e.type === 'receipt' ? sumDoc(ledger, d.id) : null,
      };
    }),
  });
});

function sumDoc(ledger: LedgerEntry[], docId: string): number | null {
  const rows = ledger.filter((e) => e.document_id === docId && e.type === 'receipt');
  return rows.length ? rows.reduce((s, e) => s + (e.amount_cents ?? 0), 0) : null;
}

// ---------- reimbursements ----------

async function reimbursementList(db: D1Database, id?: string): Promise<Reimbursement[]> {
  return (
    await all<Reimbursement>(
      db,
      `SELECT r.id, r.date, r.note, r.created_at,
         COALESCE((SELECT SUM(amount_cents) FROM entries e WHERE e.reimbursement_id = r.id), 0) AS total_cents,
         (SELECT COUNT(*) FROM entries e WHERE e.reimbursement_id = r.id) AS entry_count
       FROM reimbursements r ${id ? 'WHERE r.id = ?' : ''} ORDER BY r.date DESC, r.created_at DESC`,
      ...(id ? [id] : []),
    )
  ).map((r) => ({ ...r, total_cents: Number(r.total_cents), entry_count: Number(r.entry_count) }));
}

entries.get('/reimbursements', async (c) =>
  c.json({ reimbursements: await reimbursementList(c.env.DB) }),
);

entries.get('/reimbursements/:id', async (c) => {
  const db = c.env.DB;
  const [r] = await reimbursementList(db, c.req.param('id'));
  if (!r) throw notFound('Reimbursement');
  const rows = (await all(db, `${LEDGER_SQL} AND e.reimbursement_id = ?`, r.id)).map(toLedgerEntry);
  return c.json({ reimbursement: r, entries: rows });
});

/** Records a reimbursement for outstanding receipts. Refuses EOB lines and already-reimbursed ones. */
export async function createReimbursement(
  db: D1Database,
  input: { date: string; note?: string | null; entry_ids: string[] },
): Promise<Reimbursement> {
  const list = await loadEntries(db, [...new Set(input.entry_ids)]);
  if (list.length !== new Set(input.entry_ids).size) throw notFound('Entry');
  for (const e of list) {
    if (e.type !== 'receipt')
      throw new ApiError(400, 'invalid', 'EOB lines can’t be reimbursed; only receipts count.');
    if (e.reimbursement_id)
      throw new ApiError(409, 'reimbursed', 'One of those receipts is already marked reimbursed.');
  }
  const id = newId();
  await db.batch([
    db
      .prepare('INSERT INTO reimbursements (id, date, note, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, input.date, input.note ?? null, nowIso()),
    ...list.map((e) => updateStmt(db, 'entries', e.id, { reimbursement_id: id })),
  ]);
  return (await reimbursementList(db, id))[0]!;
}

entries.post('/reimbursements', async (c) => {
  const input = await body(c, reimbursementInput);
  return c.json(await createReimbursement(c.env.DB, input), 201);
});

entries.patch('/reimbursements/:id', async (c) => {
  const input = await body(c, reimbursementPatch);
  const db = c.env.DB;
  const [r] = await reimbursementList(db, c.req.param('id'));
  if (!r) throw notFound('Reimbursement');
  const fields: Record<string, unknown> = {};
  if (input.date) fields.date = input.date;
  if (input.note !== undefined) fields.note = input.note;
  if (Object.keys(fields).length)
    await updateStmt(db, 'reimbursements', r.id, fields, { touch: false }).run();
  return c.json((await reimbursementList(db, r.id))[0]);
});

/** Undo: un-stamps the receipts and deletes the reimbursement. */
entries.delete('/reimbursements/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  await db.batch([
    db
      .prepare(
        'UPDATE entries SET reimbursement_id = NULL, updated_at = ? WHERE reimbursement_id = ?',
      )
      .bind(nowIso(), id),
    db.prepare('DELETE FROM reimbursements WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

/** Takes receipts out of their reimbursements (the per-receipt toggle). Empty reimbursements go. */
export async function unreimburse(db: D1Database, ids: string[]): Promise<number> {
  const list = (await loadEntries(db, ids)).filter((e) => e.reimbursement_id);
  if (!list.length) return 0;
  const rids = [...new Set(list.map((e) => e.reimbursement_id!))];
  await db.batch([
    ...list.map((e) => updateStmt(db, 'entries', e.id, { reimbursement_id: null })),
    ...rids.map((r) =>
      db
        .prepare(
          'DELETE FROM reimbursements WHERE id = ? AND NOT EXISTS (SELECT 1 FROM entries WHERE reimbursement_id = ?)',
        )
        .bind(r, r),
    ),
  ]);
  return list.length;
}

entries.post('/entries/unreimburse', async (c) => {
  const { ids } = await body(c, bulkEntries.pick({ ids: true }));
  return c.json({ ok: true, changed: await unreimburse(c.env.DB, ids) });
});
