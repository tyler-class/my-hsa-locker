// The backup format: raw rows per table, in insert order (parents first), plus a manifest of the
// R2 keys the documents point at. Files themselves are in the documents export (a ZIP).

export const EXPORT_FORMAT = 'hsa-locker';
export const EXPORT_VERSION = 1;

export const TABLE_COLUMNS = {
  settings: ['key', 'value'],
  people: [
    'id',
    'name',
    'relationship',
    'aliases_json',
    'color',
    'sort_order',
    'created_at',
    'updated_at',
  ],
  providers: ['id', 'name', 'aliases_json', 'created_at', 'updated_at'],
  categories: ['id', 'name', 'sort_order'],
  inbox_log: [
    'id',
    'received_at',
    'to_addr',
    'from_addr',
    'subject',
    'outcome',
    'reason',
    'eml_key',
    'attempts',
    'size_bytes',
    'attachment_count',
    'document_count',
  ],
  inbox_verifications: [
    'id',
    'received_at',
    'provider',
    'from_addr',
    'subject',
    'code',
    'link',
    'dismissed_at',
  ],
  documents: [
    'id',
    'kind',
    'status',
    'source',
    'source_meta_json',
    'inbox_log_id',
    'file_key',
    'eml_key',
    'filename',
    'mime',
    'size_bytes',
    'sha256',
    'legacy_md5',
    'text_layer_chars',
    'extraction_json',
    'extraction_model',
    'extraction_provider',
    'review_reasons_json',
    'error',
    'attempts',
    'next_attempt_at',
    'received_at',
    'processed_at',
    'created_at',
    'updated_at',
  ],
  reimbursements: ['id', 'date', 'note', 'created_at'],
  entries: [
    'id',
    'document_id',
    'type',
    'service_date',
    'payment_date',
    'person_id',
    'patient_name_raw',
    'provider_id',
    'provider_name_raw',
    'description',
    'category_id',
    'amount_cents',
    'card_last4',
    'billed_cents',
    'allowed_cents',
    'plan_paid_cents',
    'patient_resp_cents',
    'notes',
    'confidence',
    'source_quote',
    'review_reasons_json',
    'reviewed_at',
    'excluded_reason',
    'excluded_auto',
    'reimbursement_id',
    'dup_of_entry_id',
    'sort_order',
    'created_at',
    'updated_at',
  ],
} as const;

export type TableName = keyof typeof TABLE_COLUMNS;
export const TABLE_ORDER = Object.keys(TABLE_COLUMNS) as TableName[];

/** Settings that never leave the instance (session salt; the inbox address is a secret too). */
export const PRIVATE_SETTINGS = ['session_salt', 'inbox_token'];

export type Cell = string | number | null;
export type ExportRow = Record<string, Cell>;

export interface HsaExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exported_at: string;
  tables: Partial<Record<TableName, ExportRow[]>>;
  /** R2 keys referenced by documents (for checking a files restore). */
  files?: string[];
}

export function isHsaExport(v: unknown): v is HsaExport {
  const o = v as HsaExport;
  return (
    !!o &&
    o.format === EXPORT_FORMAT &&
    typeof o.version === 'number' &&
    !!o.tables &&
    typeof o.tables === 'object'
  );
}

export function rowValues(table: TableName, row: ExportRow): { cols: string[]; vals: Cell[] } {
  const cols: string[] = [];
  const vals: Cell[] = [];
  for (const c of TABLE_COLUMNS[table]) {
    if (c in row) {
      const v = row[c];
      cols.push(c);
      vals.push(v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
  }
  return { cols, vals };
}

function sqlLiteral(v: Cell): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}

/** Plain SQL inserts for `wrangler d1 execute --file`. Does not delete existing rows. */
export function exportToSql(data: HsaExport, { orIgnore = false } = {}): string {
  const lines: string[] = ['PRAGMA defer_foreign_keys = ON;'];
  for (const table of TABLE_ORDER) {
    for (const row of data.tables[table] ?? []) {
      const { cols, vals } = rowValues(table, row);
      if (!cols.length) continue;
      lines.push(
        `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${cols.join(', ')}) VALUES (${vals.map(sqlLiteral).join(', ')});`,
      );
    }
  }
  return lines.join('\n') + '\n';
}
