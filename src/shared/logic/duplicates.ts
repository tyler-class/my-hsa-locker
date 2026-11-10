// Entry-level duplicates: the same visit logged twice from different documents (a receipt
// forwarded twice as different files, an EOB re-sent). Files with the same bytes never get this
// far; they're caught by SHA-256.
//
// Follows HSA Wizard's isCompositeDuplicate_ (same type, date, patient, amount, and a provider
// name where one contains the other), but flags for review instead of silently skipping.
import type { Entry } from '../types';
import { nameKey, providersLooselyEqual } from './names';

type DupFields = Pick<
  Entry,
  | 'type'
  | 'person_id'
  | 'provider_id'
  | 'provider_name_raw'
  | 'service_date'
  | 'payment_date'
  | 'amount_cents'
  | 'description'
>;

function sameProvider(a: DupFields, b: DupFields): boolean {
  if (a.provider_id && b.provider_id) return a.provider_id === b.provider_id;
  return providersLooselyEqual(a.provider_name_raw, b.provider_name_raw);
}

/** True when two entries describe the same visit (or the same EOB line). */
export function isSameVisit(a: DupFields, b: DupFields): boolean {
  if (a.type !== b.type || !a.person_id || a.person_id !== b.person_id) return false;
  const da = a.service_date ?? a.payment_date;
  const db = b.service_date ?? b.payment_date;
  if (!da || da !== db) return false;
  if (!sameProvider(a, b)) return false;
  if (a.type === 'receipt') return a.amount_cents !== null && a.amount_cents === b.amount_cents;
  return nameKey(a.description ?? '') === nameKey(b.description ?? '');
}

/** The first existing entry from another document that looks like the same visit. */
export function findDuplicate<T extends DupFields & Pick<Entry, 'id' | 'document_id'>>(
  candidate: DupFields & { document_id: string },
  existing: T[],
): T | null {
  return (
    existing.find((x) => x.document_id !== candidate.document_id && isSameVisit(candidate, x)) ??
    null
  );
}

/**
 * Identical rows within one document (the legacy sheet has repeated EOB lines). Returns the rows
 * to keep and how many were collapsed.
 */
export function collapseIdentical<T extends DupFields>(
  rows: T[],
): { kept: T[]; collapsed: number } {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const r of rows) {
    const k = [
      r.type,
      r.service_date ?? '',
      r.payment_date ?? '',
      nameKey(r.provider_name_raw ?? ''),
      nameKey(r.description ?? ''),
      r.amount_cents ?? '',
      r.person_id ?? '',
    ].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(r);
  }
  return { kept, collapsed: rows.length - kept.length };
}
