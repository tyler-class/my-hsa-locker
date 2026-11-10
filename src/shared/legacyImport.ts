// Planning an import from HSA Wizard's "📄 HSA Document Log" CSV. Pure logic; the script in
// scripts/import-from-hsa-wizard.ts does the reading, uploading and reporting.
import type { EntryType } from './types';
import { collapseIdentical } from './logic/duplicates';
import { parseDate } from './logic/dates';
import { parseMoney } from './logic/money';
import { last4 } from './logic/summary';
import { nameKey, normalizePatientName } from './logic/names';
import { stripLegacyPrefixes } from './logic/files';
import { parseCsv } from './logic/csv';

export const LEGACY_COLUMNS = {
  type: 'Document Type',
  flag: 'Flag for Review',
  appointment: 'Appointment Date',
  payment: 'Payment Date',
  patient: 'Patient Name',
  provider: 'Provider Name',
  description: 'Description of Services',
  category: 'Category',
  amount: 'Amount',
  card: 'Payment Card Last 4 Digits',
  link: 'Link to Drive Document',
  fileId: 'Drive File ID',
  fileName: 'Drive File Name',
  notes: 'Additional Notes',
  // The sheet has used both names for this column.
  processed: ['Last Processed Date', 'Processed Date'],
  hash: 'Content Hash',
} as const;

export interface LegacyRow {
  line: number;
  type: EntryType;
  flagged: boolean;
  service_date: string | null;
  payment_date: string | null;
  patient: string | null;
  provider: string | null;
  description: string | null;
  category: string | null;
  amount_cents: number | null;
  amount_raw: string;
  card_last4: string | null;
  file_id: string | null;
  file_name: string | null;
  notes: string | null;
  processed_at: string | null;
  md5: string | null;
}

/** Reads the CSV export of the log tab. Throws if the header doesn't look like HSA Wizard's. */
export function readLegacyCsv(text: string): LegacyRow[] {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim());
  const col = (name: string | readonly string[]) => {
    for (const n of typeof name === 'string' ? [name] : name) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const C = Object.fromEntries(
    Object.entries(LEGACY_COLUMNS).map(([k, v]) => [k, col(v)]),
  ) as Record<keyof typeof LEGACY_COLUMNS, number>;
  if (C.type < 0 || C.amount < 0 || C.patient < 0)
    throw new Error(
      'This CSV doesn’t have HSA Wizard’s columns (Document Type, Patient Name, Amount…).',
    );
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  return rows.slice(1).map((r, idx) => {
    const type: EntryType = /^eob$/i.test(get(r, C.type)) ? 'eob' : 'receipt';
    const amountRaw = get(r, C.amount);
    const processed = get(r, C.processed);
    return {
      line: idx + 2,
      type,
      flagged: /^(true|yes|1|x)$/i.test(get(r, C.flag)),
      service_date: parseDate(get(r, C.appointment)),
      payment_date: type === 'eob' ? null : parseDate(get(r, C.payment)),
      patient: get(r, C.patient) || null,
      provider: get(r, C.provider) || null,
      description: get(r, C.description) || null,
      category: get(r, C.category) || null,
      amount_cents: type === 'eob' || !amountRaw ? null : parseMoney(amountRaw),
      amount_raw: amountRaw,
      card_last4: type === 'eob' ? null : last4(get(r, C.card)),
      file_id: get(r, C.fileId) || null,
      file_name: get(r, C.fileName) ? stripLegacyPrefixes(get(r, C.fileName)) : null,
      notes: get(r, C.notes) || null,
      processed_at: parseDate(processed.split(/[ T]/)[0]) ?? null,
      md5: get(r, C.hash) || null,
    };
  });
}

/** The user-confirmed mapping file: printed names → canonical names. */
export interface ImportMapping {
  /** Printed patient name → person name (people are created as needed). "" skips mapping. */
  people: Record<string, string>;
  /** Printed provider name → canonical provider name. */
  providers: Record<string, string>;
}

/** A first-draft mapping: names collapsed with the family-names rule and truncated providers joined. */
export function draftMapping(rows: LegacyRow[], familyNames: string[]): ImportMapping {
  const people: Record<string, string> = {};
  const printed = [...new Set(rows.map((r) => r.patient).filter((p): p is string => !!p))];
  const normalized = new Map(printed.map((p) => [p, normalizePatientName(p, familyNames)]));
  // "Sam" → "Sam Example" when "Sam Example" also appears and Example is a family name.
  const full = [...new Set(normalized.values())];
  for (const p of printed) {
    const n = normalized.get(p)!;
    const longer = full.filter(
      (f) =>
        f !== n &&
        nameKey(f).startsWith(`${nameKey(n)} `) &&
        familyNames.some((fam) => nameKey(f).endsWith(nameKey(fam))),
    );
    people[p] = longer.length === 1 ? longer[0]! : n;
  }
  const providers: Record<string, string> = {};
  const names = [...new Set(rows.map((r) => r.provider).filter((p): p is string => !!p))].sort(
    (a, b) => b.length - a.length,
  );
  for (const p of names) {
    const k = nameKey(p);
    const longer = names.find((o) => o !== p && k.length >= 12 && nameKey(o).startsWith(k));
    providers[p] = longer ?? p;
  }
  return { people, providers };
}

export interface PlannedDocument {
  key: string;
  file_name: string | null;
  file_id: string | null;
  md5: string | null;
  kind: EntryType;
  rows: LegacyRow[];
  collapsed: number;
}

/** Groups rows into documents (one per Drive file id, else hash, else file name, else row). */
export function planDocuments(rows: LegacyRow[], mapping: ImportMapping): PlannedDocument[] {
  const groups = new Map<string, LegacyRow[]>();
  for (const r of rows) {
    const key = r.file_id
      ? `id:${r.file_id}`
      : r.md5
        ? `md5:${r.md5}`
        : r.file_name
          ? `name:${r.file_name}`
          : `row:${r.line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return [...groups.entries()].map(([key, list]) => {
    // Identical rows inside one document (repeated EOB lines) collapse to one.
    const asEntries = list.map((r) => ({
      r,
      type: r.type,
      person_id: r.patient ? (mapping.people[r.patient] ?? r.patient) : null,
      provider_id: null,
      provider_name_raw: r.provider ? (mapping.providers[r.provider] ?? r.provider) : null,
      service_date: r.service_date,
      payment_date: r.payment_date,
      amount_cents: r.amount_cents,
      description: r.description,
    }));
    const { kept, collapsed } = collapseIdentical(asEntries);
    const first = list[0]!;
    return {
      key,
      file_name: first.file_name,
      file_id: first.file_id,
      md5: first.md5,
      kind: list.some((r) => r.type === 'eob') ? 'eob' : 'receipt',
      rows: kept.map((k) => k.r),
      collapsed,
    };
  });
}

/** Review reasons for an imported row. */
export function importReasons(r: LegacyRow, personFound: boolean): string[] {
  const out: string[] = [];
  if (r.flagged) out.push('legacy_flagged');
  if (r.type === 'receipt' && (r.amount_cents === null || r.amount_cents <= 0))
    out.push(r.amount_raw ? 'bad_amount' : 'missing_amount');
  if (!personFound) out.push(r.patient ? 'unknown_patient' : 'missing_patient');
  return out;
}
