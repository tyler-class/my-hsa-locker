// Ledger filters, shared so the app's list and the server's CSV export agree.
import type { LedgerEntry, YearBasis } from '../types';
import { entryDate, entryStatus, needsReview, type EntryStatus } from './summary';

/**
 * The Ledger's status choices. `processing` is the documents still being read: they aren't
 * entries yet, so no entry matches it (the Ledger shows their placeholder rows instead).
 */
export type StatusFilter =
  'all' | 'processing' | 'outstanding' | 'reimbursed' | 'excluded' | 'needs_review';

/** The status choices in the order the Ledger shows them. */
export const LEDGER_STATUSES: StatusFilter[] = [
  'all',
  'processing',
  'needs_review',
  'outstanding',
  'reimbursed',
  'excluded',
];
export type TypeFilter = 'all' | 'receipt' | 'eob';
export type SortKey = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc' | 'added_desc';

export interface LedgerFilter {
  year?: number | 'undated' | null;
  person?: string | null;
  category?: string | null;
  provider?: string | null;
  status?: StatusFilter;
  type?: TypeFilter;
  q?: string;
  sort?: SortKey;
}

export interface FilterNames {
  person: Map<string, string>;
  provider: Map<string, string>;
  category: Map<string, string>;
}

export function matchesStatus(e: LedgerEntry, s: StatusFilter | undefined): boolean {
  if (!s || s === 'all') return true;
  if (s === 'processing') return false;
  if (s === 'needs_review') return needsReview(e);
  const st: EntryStatus = entryStatus(e);
  return st === s;
}

export function filterLedger(
  entries: LedgerEntry[],
  f: LedgerFilter,
  basis: YearBasis,
  names?: FilterNames,
): LedgerEntry[] {
  const q = f.q?.trim().toLowerCase() ?? '';
  const out = entries.filter((e) => {
    if (f.type && f.type !== 'all' && e.type !== f.type) return false;
    if (f.year !== undefined && f.year !== null) {
      const d = entryDate(e, basis);
      if (f.year === 'undated' ? !!d : !d || Number(d.slice(0, 4)) !== f.year) return false;
    }
    if (f.person && e.person_id !== f.person) return false;
    if (f.category && e.category_id !== f.category) return false;
    if (f.provider && e.provider_id !== f.provider) return false;
    if (!matchesStatus(e, f.status)) return false;
    if (q) {
      const hay = [
        e.description,
        e.notes,
        e.patient_name_raw,
        e.provider_name_raw,
        e.doc_filename,
        e.card_last4,
        e.person_id ? names?.person.get(e.person_id) : null,
        e.provider_id ? names?.provider.get(e.provider_id) : null,
        e.category_id ? names?.category.get(e.category_id) : null,
        e.amount_cents !== null ? (e.amount_cents / 100).toFixed(2) : null,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const sort = f.sort ?? 'date_desc';
  const date = (e: LedgerEntry) => entryDate(e, basis) ?? '';
  out.sort((a, b) => {
    switch (sort) {
      case 'date_asc':
        return date(a).localeCompare(date(b)) || a.sort_order - b.sort_order;
      case 'amount_desc':
        return (b.amount_cents ?? -1) - (a.amount_cents ?? -1);
      case 'amount_asc':
        return (a.amount_cents ?? Infinity) - (b.amount_cents ?? Infinity);
      case 'added_desc':
        return b.created_at.localeCompare(a.created_at) || a.sort_order - b.sort_order;
      default:
        return date(b).localeCompare(date(a)) || a.sort_order - b.sort_order;
    }
  });
  return out;
}

/**
 * How many each status choice holds, with the other filters applied. Processing counts the
 * documents being read (`processing`: how many the in-flight list holds), whatever the other
 * filters, since there's nothing in them to filter on yet; All counts entries.
 */
export function ledgerCounts(
  entries: LedgerEntry[],
  f: LedgerFilter,
  basis: YearBasis,
  names: FilterNames | undefined,
  processing: number,
): Record<StatusFilter, number> {
  return Object.fromEntries(
    LEDGER_STATUSES.map((status) => [
      status,
      status === 'processing'
        ? processing
        : filterLedger(entries, { ...f, status }, basis, names).length,
    ]),
  ) as Record<StatusFilter, number>;
}

/** Reads a filter from URL search params (used by both the app's URL and the CSV endpoint). */
export function filterFromParams(p: URLSearchParams): LedgerFilter {
  const y = p.get('year');
  return {
    year: y === 'undated' ? 'undated' : y && /^\d{4}$/.test(y) ? Number(y) : null,
    person: p.get('person') || null,
    category: p.get('category') || null,
    provider: p.get('provider') || null,
    status: (p.get('status') as StatusFilter) || 'all',
    type: (p.get('type') as TypeFilter) || 'all',
    q: p.get('q') ?? '',
    sort: (p.get('sort') as SortKey) || 'date_desc',
  };
}

export function filterToParams(f: LedgerFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.year !== null && f.year !== undefined) p.set('year', String(f.year));
  if (f.person) p.set('person', f.person);
  if (f.category) p.set('category', f.category);
  if (f.provider) p.set('provider', f.provider);
  if (f.status && f.status !== 'all') p.set('status', f.status);
  if (f.type && f.type !== 'all') p.set('type', f.type);
  if (f.q) p.set('q', f.q);
  if (f.sort && f.sort !== 'date_desc') p.set('sort', f.sort);
  return p;
}
