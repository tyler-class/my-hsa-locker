// The numbers behind the Insights tab. Every figure follows the money definitions in summary.ts
// (entryStatus), so a total here always agrees with Home and the Ledger:
//
//   Claimable   = receipts that are reimbursed or still reimbursable (not excluded, not in review)
//   Reimbursable (outstanding) = claimable receipts not yet reimbursed
//
// Dates use the year basis (service date, else payment date). A receipt with neither has no
// place on a calendar: the balance chart files it under the day it was logged, the period
// charts leave it out and say how many they left out.
import type { Entry, Reimbursement, YearBasis } from '../types';
import { isIsoDate } from './dates';
import { entryDate, entryStatus, type EntryStatus } from './summary';

export type InsightEntry = Pick<
  Entry,
  | 'type'
  | 'amount_cents'
  | 'service_date'
  | 'payment_date'
  | 'reimbursement_id'
  | 'excluded_reason'
  | 'review_reasons'
  | 'person_id'
  | 'category_id'
  | 'provider_id'
> & {
  /** When the document arrived (ISO timestamp); the balance chart's date for undated receipts. */
  doc_received_at?: string;
};

type Money = 'reimbursed' | 'outstanding' | 'needs_review' | 'excluded';

/** Receipts only, each with its status and calendar date (null when undated). */
function receipts(entries: InsightEntry[], basis: YearBasis) {
  const out: { e: InsightEntry; s: Money; date: string | null; cents: number }[] = [];
  for (const e of entries) {
    const s: EntryStatus = entryStatus(e);
    if (s === 'eob') continue;
    const d = entryDate(e, basis);
    out.push({ e, s, date: isIsoDate(d) ? d : null, cents: e.amount_cents ?? 0 });
  }
  return out;
}

const monthKey = (d: string) => d.slice(0, 7);

function addMonths(key: string, n: number): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (key: string) => `${MON[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

// ------------------------------------------------------------------------------- at a glance

export interface Glance {
  reimbursable_cents: number;
  reimbursable_count: number;
  reimbursed_cents: number;
  withdrawals: number;
  last_withdrawal: string | null;
  documented_cents: number;
  documented_count: number;
  review_cents: number;
  review_count: number;
  excluded_cents: number;
  excluded_count: number;
  /** Date of the oldest receipt still reimbursable (dated ones only). */
  oldest_reimbursable: string | null;
}

export function glance(
  entries: InsightEntry[],
  reimbursements: Pick<Reimbursement, 'date'>[],
  basis: YearBasis,
): Glance {
  const g: Glance = {
    reimbursable_cents: 0,
    reimbursable_count: 0,
    reimbursed_cents: 0,
    withdrawals: reimbursements.length,
    last_withdrawal: reimbursements.reduce<string | null>(
      (a, r) => (a === null || r.date > a ? r.date : a),
      null,
    ),
    documented_cents: 0,
    documented_count: 0,
    review_cents: 0,
    review_count: 0,
    excluded_cents: 0,
    excluded_count: 0,
    oldest_reimbursable: null,
  };
  for (const { s, date, cents } of receipts(entries, basis)) {
    g.documented_cents += cents;
    g.documented_count++;
    if (s === 'reimbursed') g.reimbursed_cents += cents;
    else if (s === 'excluded') {
      g.excluded_cents += cents;
      g.excluded_count++;
    } else if (s === 'needs_review') {
      g.review_cents += cents;
      g.review_count++;
    } else {
      g.reimbursable_cents += cents;
      g.reimbursable_count++;
      if (date && (!g.oldest_reimbursable || date < g.oldest_reimbursable))
        g.oldest_reimbursable = date;
    }
  }
  return g;
}

// --------------------------------------------------------------------------- balance over time

export interface BalancePoint {
  month: string;
  /** Cumulative claimable receipts by the end of this month. */
  claimable_cents: number;
  /** Cumulative reimbursed by the end of this month (by reimbursement date). */
  reimbursed_cents: number;
}

/**
 * Month by month, from the first month with anything to the current month. The gap between the
 * two lines is what was reimbursable at that point; the last point's gap equals Reimbursable.
 */
export function balanceSeries(
  entries: InsightEntry[],
  reimbursements: Pick<Reimbursement, 'id' | 'date'>[],
  basis: YearBasis,
  today: string,
): BalancePoint[] {
  const paidOn = new Map(reimbursements.map((r) => [r.id, r.date]));
  const add = new Map<string, number>();
  const paid = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const { e, s, date, cents } of receipts(entries, basis)) {
    if (s !== 'reimbursed' && s !== 'outstanding') continue;
    const logged = e.doc_received_at?.slice(0, 10);
    const when = date ?? (isIsoDate(logged) ? logged : today);
    bump(add, monthKey(when), cents);
    if (s === 'reimbursed') {
      const r = paidOn.get(e.reimbursement_id!);
      bump(paid, monthKey(r && isIsoDate(r) ? r : today), cents);
    }
  }
  const keys = [...add.keys(), ...paid.keys()].sort();
  if (!keys.length) return [];
  const last = monthKey(today) > keys[keys.length - 1]! ? monthKey(today) : keys[keys.length - 1]!;
  const out: BalancePoint[] = [];
  let c = 0;
  let r = 0;
  for (let k = keys[0]!; k <= last; k = addMonths(k, 1)) {
    c += add.get(k) ?? 0;
    r += paid.get(k) ?? 0;
    out.push({ month: k, claimable_cents: c, reimbursed_cents: r });
  }
  return out;
}

// ------------------------------------------------------------------------- spending by period

export type PeriodUnit = 'month' | 'quarter' | 'year';

export interface PeriodRow {
  key: string;
  label: string;
  /** The period today falls in (still filling up). */
  current: boolean;
  reimbursed_cents: number;
  outstanding_cents: number;
  review_cents: number;
  excluded_cents: number;
}

export interface Periods {
  rows: PeriodRow[];
  /** Receipts with no date, left out of every period. */
  undated_count: number;
}

function periodOf(date: string, unit: PeriodUnit): string {
  if (unit === 'year') return date.slice(0, 4);
  if (unit === 'month') return date.slice(0, 7);
  return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
}

function periodLabel(key: string, unit: PeriodUnit): string {
  if (unit === 'year') return key;
  if (unit === 'month') return `${MON[Number(key.slice(5, 7)) - 1]} ’${key.slice(2, 4)}`;
  return `${key.slice(5)} ’${key.slice(2, 4)}`;
}

/** Spending per period, split by where the money sits. Months: last 12. Quarters: last 8. Years: all. */
export function periods(
  entries: InsightEntry[],
  basis: YearBasis,
  today: string,
  unit: PeriodUnit,
): Periods {
  const cur = periodOf(today, unit);
  const keys: string[] = [];
  if (unit === 'month') for (let i = 11; i >= 0; i--) keys.push(addMonths(monthKey(today), -i));
  else if (unit === 'quarter') {
    const qm = (Number(cur.slice(6)) - 1) * 3 + 1;
    const start = `${cur.slice(0, 4)}-${String(qm).padStart(2, '0')}`;
    for (let i = 7; i >= 0; i--) keys.push(periodOf(`${addMonths(start, -3 * i)}-01`, 'quarter'));
  }
  const rows = new Map<string, PeriodRow>();
  const row = (k: string) => {
    let r = rows.get(k);
    if (!r) {
      r = {
        key: k,
        label: periodLabel(k, unit),
        current: k === cur,
        reimbursed_cents: 0,
        outstanding_cents: 0,
        review_cents: 0,
        excluded_cents: 0,
      };
      rows.set(k, r);
    }
    return r;
  };
  keys.forEach(row);
  let undated = 0;
  for (const { s, date, cents } of receipts(entries, basis)) {
    if (!date) {
      undated++;
      continue;
    }
    const k = periodOf(date, unit);
    if (unit !== 'year' && !rows.has(k)) continue;
    if (k > cur) continue;
    const r = row(k);
    if (s === 'reimbursed') r.reimbursed_cents += cents;
    else if (s === 'outstanding') r.outstanding_cents += cents;
    else if (s === 'needs_review') r.review_cents += cents;
    else r.excluded_cents += cents;
  }
  if (unit === 'year' && rows.size) {
    // Every year from the first one with spending to this one, gaps included.
    const first = Number([...rows.keys()].sort()[0]);
    for (let y = first; y <= Number(cur); y++) row(String(y));
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.key.localeCompare(b.key)),
    undated_count: undated,
  };
}

// ---------------------------------------------------------------------------- age of receipts

export interface AgeBucket {
  key: string;
  label: string;
  cents: number;
  count: number;
}

const AGES: [string, string, number][] = [
  ['lt1', 'Under 1 year', 1],
  ['1to2', '1–2 years', 2],
  ['2to5', '2–5 years', 5],
  ['5to10', '5–10 years', 10],
  ['10plus', '10+ years', Infinity],
];

/** Reimbursable receipts by how long ago the care was. Undated ones get their own bucket. */
export function aging(entries: InsightEntry[], basis: YearBasis, today: string): AgeBucket[] {
  const out: AgeBucket[] = AGES.map(([key, label]) => ({ key, label, cents: 0, count: 0 }));
  const undated: AgeBucket = { key: 'undated', label: 'No date', cents: 0, count: 0 };
  const t = Date.parse(`${today}T00:00:00Z`);
  for (const { s, date, cents } of receipts(entries, basis)) {
    if (s !== 'outstanding') continue;
    if (!date) {
      undated.cents += cents;
      undated.count++;
      continue;
    }
    const years = (t - Date.parse(`${date}T00:00:00Z`)) / (365.25 * 86_400_000);
    const i = AGES.findIndex(([, , max]) => years < max);
    out[i]!.cents += cents;
    out[i]!.count++;
  }
  return undated.count ? [...out, undated] : out;
}

// ------------------------------------------------------------------------------- breakdowns

export type BreakdownBy = 'category' | 'person' | 'provider';
export type Window = 'this' | 'last' | 'all';

export interface BreakdownRow {
  /** null: receipts with no category, person or provider. */
  id: string | null;
  cents: number;
  count: number;
  reimbursable_cents: number;
}

/** Spending (every receipt, whatever its status) grouped by category, person or provider. */
export function breakdown(
  entries: InsightEntry[],
  basis: YearBasis,
  today: string,
  by: BreakdownBy,
  window: Window,
): BreakdownRow[] {
  const year = Number(today.slice(0, 4));
  const want = window === 'this' ? year : window === 'last' ? year - 1 : null;
  const rows = new Map<string | null, BreakdownRow>();
  for (const { e, s, date, cents } of receipts(entries, basis)) {
    if (want !== null && (!date || Number(date.slice(0, 4)) !== want)) continue;
    const id = by === 'category' ? e.category_id : by === 'person' ? e.person_id : e.provider_id;
    const r = rows.get(id) ?? { id, cents: 0, count: 0, reimbursable_cents: 0 };
    r.cents += cents;
    r.count++;
    if (s === 'outstanding') r.reimbursable_cents += cents;
    rows.set(id, r);
  }
  return [...rows.values()].sort((a, b) => b.cents - a.cents || b.count - a.count);
}
