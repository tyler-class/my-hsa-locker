// The money definitions. Only receipts carry money that counts; EOB lines are reference only.
//
//   Documented (per year)  = sum of every receipt's amount in that year
//   Reimbursed             = receipts stamped with a reimbursement
//   Outstanding            = receipts not reimbursed, not excluded, and not waiting for review
//   Pending review         = receipts with unresolved review reasons (never mixed into Outstanding)
import type { Entry, YearBasis } from '../types';
import { yearOf } from './dates';

export type EntryStatus = 'eob' | 'reimbursed' | 'excluded' | 'needs_review' | 'outstanding';

type StatusFields = Pick<
  Entry,
  'type' | 'reimbursement_id' | 'excluded_reason' | 'review_reasons' | 'amount_cents'
>;

export function needsReview(e: Pick<Entry, 'review_reasons'>): boolean {
  return e.review_reasons.length > 0;
}

/** Where an entry's money sits. Precedence: reimbursed, excluded, needs review, outstanding. */
export function entryStatus(e: StatusFields): EntryStatus {
  if (e.type === 'eob') return 'eob';
  if (e.reimbursement_id) return 'reimbursed';
  if (e.excluded_reason) return 'excluded';
  if (needsReview(e)) return 'needs_review';
  return 'outstanding';
}

/** The date an entry belongs to for yearly totals. */
export function entryDate(
  e: Pick<Entry, 'service_date' | 'payment_date'>,
  basis: YearBasis,
): string | null {
  return basis === 'payment_date'
    ? (e.payment_date ?? e.service_date)
    : (e.service_date ?? e.payment_date);
}

export function entryYear(
  e: Pick<Entry, 'service_date' | 'payment_date'>,
  basis: YearBasis,
): number | null {
  return yearOf(entryDate(e, basis));
}

export interface Totals {
  documented_cents: number;
  reimbursed_cents: number;
  outstanding_cents: number;
  pending_review_cents: number;
  excluded_cents: number;
  receipt_count: number;
  eob_line_count: number;
  /** Distinct EOB documents, not lines (the old sheet counted lines, which overstated EOBs). */
  eob_document_count: number;
  /** Distinct receipt documents. */
  receipt_document_count: number;
}

export interface YearTotals extends Totals {
  /** null collects entries with no usable date. */
  year: number | null;
}

type SummaryEntry = StatusFields & Pick<Entry, 'service_date' | 'payment_date' | 'document_id'>;

function emptyTotals(): Totals {
  return {
    documented_cents: 0,
    reimbursed_cents: 0,
    outstanding_cents: 0,
    pending_review_cents: 0,
    excluded_cents: 0,
    receipt_count: 0,
    eob_line_count: 0,
    eob_document_count: 0,
    receipt_document_count: 0,
  };
}

function addTo(t: Totals, e: SummaryEntry, docs: { receipt: Set<string>; eob: Set<string> }) {
  if (e.type === 'eob') {
    t.eob_line_count++;
    docs.eob.add(e.document_id);
    return;
  }
  const amt = e.amount_cents ?? 0;
  t.receipt_count++;
  docs.receipt.add(e.document_id);
  t.documented_cents += amt;
  const s = entryStatus(e);
  if (s === 'reimbursed') t.reimbursed_cents += amt;
  else if (s === 'excluded') t.excluded_cents += amt;
  else if (s === 'needs_review') t.pending_review_cents += amt;
  else if (s === 'outstanding') t.outstanding_cents += amt;
}

/** Totals for all entries plus one row per year (newest first, undated last). */
export function summarize(
  entries: SummaryEntry[],
  basis: YearBasis,
): { all: Totals; years: YearTotals[] } {
  const all = emptyTotals();
  const allDocs = { receipt: new Set<string>(), eob: new Set<string>() };
  const byYear = new Map<number | null, { t: Totals; docs: typeof allDocs }>();
  for (const e of entries) {
    addTo(all, e, allDocs);
    const y = entryYear(e, basis);
    if (!byYear.has(y))
      byYear.set(y, { t: emptyTotals(), docs: { receipt: new Set(), eob: new Set() } });
    const row = byYear.get(y)!;
    addTo(row.t, e, row.docs);
  }
  all.eob_document_count = allDocs.eob.size;
  all.receipt_document_count = allDocs.receipt.size;
  const years: YearTotals[] = [...byYear.entries()].map(([year, { t, docs }]) => ({
    year,
    ...t,
    eob_document_count: docs.eob.size,
    receipt_document_count: docs.receipt.size,
  }));
  years.sort((a, b) => (a.year === null ? 1 : b.year === null ? -1 : b.year - a.year));
  return { all, years };
}

/** Normalizes card digits to the last four, or null. */
export function last4(v: string | null | undefined): string | null {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
}

/**
 * Applies the HSA card list to a receipt: a matching last-4 excludes it as paid_with_hsa
 * (marked automatic so it can be undone if the list changes). Manual exclusions are left alone.
 * A missing last-4 never excludes and never triggers review.
 */
export function applyHsaCards<
  T extends Pick<Entry, 'type' | 'card_last4' | 'excluded_reason' | 'excluded_auto'>,
>(e: T, cards: string[]): T {
  if (e.type !== 'receipt') return e;
  if (e.excluded_reason && !e.excluded_auto) return e;
  const l4 = last4(e.card_last4);
  const match = !!l4 && cards.some((c) => last4(c) === l4);
  if (match) return { ...e, excluded_reason: 'paid_with_hsa', excluded_auto: true };
  if (e.excluded_auto) return { ...e, excluded_reason: null, excluded_auto: false };
  return e;
}
