import { INBOX_DEFAULTS } from '@shared/lookups';
import { MILESTONE_DEFAULT_CENTS } from '@shared/logic';
import type {
  Category,
  DocumentSummary,
  Entry,
  ExcludedReason,
  InsightsPanel,
  LedgerEntry,
  Person,
  Provider,
  Settings,
  SourceMeta,
  YearBasis,
} from '@shared/types';

export type Row = Record<string, unknown>;

/**
 * The documents the Review screen shows (and its tab badge counts), for `documents d`: waiting
 * for review themselves, or holding an entry that is.
 */
export const REVIEW_DOC_WHERE = `(d.status = 'needs_review'
  OR (d.status != 'discarded' AND EXISTS (SELECT 1 FROM entries re WHERE re.document_id = d.id AND re.review_reasons_json != '[]')))`;

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

export async function all<T = Row>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const res = await db
    .prepare(sql)
    .bind(...binds)
    .all<T>();
  return res.results;
}

export async function first<T = Row>(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...binds)
    .first<T>();
}

/** UPDATE helper: only the given columns, plus updated_at when the table has one. */
export function updateStmt(
  db: D1Database,
  table: string,
  id: string,
  fields: Record<string, unknown>,
  { touch = true } = {},
) {
  const cols = Object.keys(fields);
  const sets = [...cols.map((c) => `${c} = ?`), ...(touch ? ['updated_at = ?'] : [])].join(', ');
  return db
    .prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`)
    .bind(...cols.map((c) => fields[c]), ...(touch ? [nowIso()] : []), id);
}

export function insertStmt(db: D1Database, table: string, fields: Record<string, unknown>) {
  const cols = Object.keys(fields);
  return db
    .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...cols.map((c) => fields[c]));
}

/** Splits a list for IN (...) clauses (D1 allows 100 bound parameters per statement). */
export function chunks<T>(list: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
export const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
/** A saved Insights layout; anything malformed is dropped (the board falls back to defaults). */
function panels(v: string | undefined): InsightsPanel[] {
  try {
    const a: unknown = JSON.parse(v ?? '[]');
    if (!Array.isArray(a)) return [];
    return a.flatMap((p: Partial<InsightsPanel>) =>
      p && typeof p.id === 'string' && (p.size === 'half' || p.size === 'full')
        ? [{ id: p.id, size: p.size, hidden: p.hidden === true }]
        : [],
    );
  } catch {
    return [];
  }
}

export const arr = (v: unknown): string[] => {
  try {
    const p = JSON.parse(String(v ?? '[]'));
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
};
const obj = <T>(v: unknown): T => {
  try {
    const p = JSON.parse(String(v ?? '{}'));
    return (p && typeof p === 'object' ? p : {}) as T;
  } catch {
    return {} as T;
  }
};

export function toPerson(r: Row): Person {
  return {
    id: String(r.id),
    name: String(r.name),
    relationship: s(r.relationship),
    aliases: arr(r.aliases_json),
    color: String(r.color ?? 'mist'),
    sort_order: Number(r.sort_order ?? 0),
  };
}

export function toProvider(r: Row): Provider {
  return { id: String(r.id), name: String(r.name), aliases: arr(r.aliases_json) };
}

export function toCategory(r: Row): Category {
  return { id: String(r.id), name: String(r.name), sort_order: Number(r.sort_order ?? 0) };
}

export function toEntry(r: Row): Entry {
  return {
    id: String(r.id),
    document_id: String(r.document_id),
    type: r.type === 'eob' ? 'eob' : 'receipt',
    service_date: s(r.service_date),
    payment_date: s(r.payment_date),
    person_id: s(r.person_id),
    patient_name_raw: s(r.patient_name_raw),
    provider_id: s(r.provider_id),
    provider_name_raw: s(r.provider_name_raw),
    description: s(r.description),
    category_id: s(r.category_id),
    amount_cents: n(r.amount_cents),
    card_last4: s(r.card_last4),
    billed_cents: n(r.billed_cents),
    allowed_cents: n(r.allowed_cents),
    plan_paid_cents: n(r.plan_paid_cents),
    patient_resp_cents: n(r.patient_resp_cents),
    notes: s(r.notes),
    confidence: n(r.confidence),
    source_quote: s(r.source_quote),
    review_reasons: arr(r.review_reasons_json),
    reviewed_at: s(r.reviewed_at),
    excluded_reason: (s(r.excluded_reason) as ExcludedReason | null) ?? null,
    excluded_auto: r.excluded_auto === 1 || r.excluded_auto === true,
    reimbursement_id: s(r.reimbursement_id),
    dup_of_entry_id: s(r.dup_of_entry_id),
    sort_order: Number(r.sort_order ?? 0),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export function toLedgerEntry(r: Row): LedgerEntry {
  return {
    ...toEntry(r),
    doc_kind: (r.doc_kind as LedgerEntry['doc_kind']) ?? 'unknown',
    doc_status: (r.doc_status as LedgerEntry['doc_status']) ?? 'processed',
    doc_filename: String(r.doc_filename ?? ''),
    doc_received_at: String(r.doc_received_at ?? ''),
  };
}

/** Never includes extraction_json. */
export const DOC_COLUMNS = `d.id, d.kind, d.status, d.source, d.source_meta_json, d.filename, d.mime,
  d.size_bytes, d.eml_key, d.text_layer_chars, d.extraction_model, d.extraction_provider,
  d.review_reasons_json, d.error, d.attempts, d.received_at, d.processed_at,
  (SELECT COUNT(*) FROM entries e WHERE e.document_id = d.id) AS entry_count`;

export function toDocument(r: Row): DocumentSummary {
  return {
    id: String(r.id),
    kind: (r.kind as DocumentSummary['kind']) ?? 'unknown',
    status: r.status as DocumentSummary['status'],
    source: r.source as DocumentSummary['source'],
    source_meta: obj<SourceMeta>(r.source_meta_json),
    filename: String(r.filename),
    mime: String(r.mime),
    size_bytes: Number(r.size_bytes ?? 0),
    has_eml: !!r.eml_key,
    text_layer_chars: n(r.text_layer_chars),
    extraction_model: s(r.extraction_model),
    extraction_provider: s(r.extraction_provider),
    review_reasons: arr(r.review_reasons_json),
    error: s(r.error),
    attempts: Number(r.attempts ?? 0),
    received_at: String(r.received_at),
    processed_at: s(r.processed_at),
    entry_count: Number(r.entry_count ?? 0),
  };
}

export async function loadPeople(db: D1Database): Promise<Person[]> {
  return (await all(db, 'SELECT * FROM people ORDER BY sort_order, name COLLATE NOCASE')).map(
    toPerson,
  );
}
export async function loadProviders(db: D1Database): Promise<Provider[]> {
  return (await all(db, 'SELECT * FROM providers ORDER BY name COLLATE NOCASE')).map(toProvider);
}
export async function loadCategories(db: D1Database): Promise<Category[]> {
  return (await all(db, 'SELECT * FROM categories ORDER BY sort_order, name COLLATE NOCASE')).map(
    toCategory,
  );
}

// ---------- settings ----------

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  return (
    (await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key))?.value ??
    null
  );
}

export function setSettingStmt(db: D1Database, key: string, value: string) {
  return db
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .bind(key, value);
}

export async function settingsMap(db: D1Database): Promise<Map<string, string>> {
  return new Map(
    (await all<{ key: string; value: string }>(db, 'SELECT key, value FROM settings')).map((r) => [
      r.key,
      r.value,
    ]),
  );
}

const num = (v: string | undefined, d: number) => {
  const x = Number(v);
  return v !== undefined && Number.isFinite(x) && x >= 0 ? x : d;
};

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** "hsa-" + 10 random base32 characters (50 bits). */
export function newInboxToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `hsa-${[...bytes].map((b) => BASE32[b & 31]).join('')}`;
}

/** The inbox token, created on first use. */
export async function getInboxToken(db: D1Database): Promise<string> {
  const existing = await getSetting(db, 'inbox_token');
  if (existing) return existing;
  await db
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('inbox_token', ?)")
    .bind(newInboxToken())
    .run();
  return (await getSetting(db, 'inbox_token'))!;
}

export async function loadSettings(db: D1Database): Promise<Settings> {
  const m = await settingsMap(db);
  const token = m.get('inbox_token') ?? (await getInboxToken(db));
  const domain = m.get('inbox_domain') || null;
  return {
    // Always: a receipt counts in the year of its service date, or its payment date if it has none.
    year_basis: 'service_date' as YearBasis,
    hsa_cards: arr(m.get('hsa_card_last4_json')),
    family_names: arr(m.get('family_names_json')),
    inbox_domain: domain,
    inbox_local: token,
    inbox_address: domain ? `${token}@${domain}` : null,
    inbox_paused: m.get('inbox_paused') === '1',
    inbox_min_kb: num(m.get('inbox_min_kb'), INBOX_DEFAULTS.min_kb),
    inbox_max_attachments: num(m.get('inbox_max_attachments'), INBOX_DEFAULTS.max_attachments),
    inbox_max_mb: num(m.get('inbox_max_mb'), INBOX_DEFAULTS.max_mb),
    inbox_daily_cap: num(m.get('inbox_daily_cap'), INBOX_DEFAULTS.daily_cap),
    inbox_allowlist: arr(m.get('inbox_allowlist_json')),
    onboarded: m.get('onboarded') === '1',
    notify_email: m.get('notify_email') || null,
    notify_daily: m.get('notify_daily') === '1',
    notify_milestone_cents: num(m.get('notify_milestone_cents'), MILESTONE_DEFAULT_CENTS),
    insights_layout: panels(m.get('insights_layout_json')),
  };
}
