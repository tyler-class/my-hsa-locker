import { describe, expect, it } from 'vitest';
import type { Entry } from '../../src/shared/types';
import {
  aging,
  balanceSeries,
  breakdown,
  glance,
  periods,
  summarize,
  type InsightEntry,
} from '../../src/shared/logic';

let n = 0;
function entry(p: Partial<Entry> & { doc_received_at?: string }): InsightEntry & { id: string } {
  n++;
  return {
    id: `e${n}`,
    type: 'receipt',
    service_date: '2024-03-01',
    payment_date: null,
    person_id: 'p1',
    provider_id: 'v1',
    category_id: 'c1',
    amount_cents: 1000,
    review_reasons: [],
    excluded_reason: null,
    reimbursement_id: null,
    ...p,
  };
}

const TODAY = '2026-11-10';
const reimbursements = [
  { id: 'r1', date: '2025-02-10' },
  { id: 'r2', date: '2026-06-01' },
];
const ledger = [
  entry({ service_date: '2019-05-02', amount_cents: 12_000 }), // outstanding, 7y old
  entry({ service_date: '2024-03-01', amount_cents: 5_000, reimbursement_id: 'r1' }),
  entry({ service_date: '2025-08-20', amount_cents: 2_500, reimbursement_id: 'r2' }),
  entry({ service_date: '2026-10-15', amount_cents: 4_000 }), // outstanding, this month-ish
  entry({ service_date: '2026-11-02', amount_cents: 1_500, review_reasons: ['missing_patient'] }),
  entry({ service_date: '2026-01-05', amount_cents: 3_000, excluded_reason: 'paid_with_hsa' }),
  entry({ service_date: null, amount_cents: 700, doc_received_at: '2026-09-09T10:00:00Z' }),
  entry({ type: 'eob', amount_cents: 99_999 }), // never money
];

describe('insights', () => {
  it('glance agrees with summarize()', () => {
    const g = glance(ledger, reimbursements, 'service_date');
    const { all } = summarize(
      ledger.map((e) => ({ ...e, document_id: e.id })),
      'service_date',
    );
    expect(g.reimbursable_cents).toBe(all.outstanding_cents);
    expect(g.reimbursed_cents).toBe(all.reimbursed_cents);
    expect(g.documented_cents).toBe(all.documented_cents);
    expect(g.review_cents).toBe(all.pending_review_cents);
    expect(g.excluded_cents).toBe(all.excluded_cents);
    expect(g.reimbursable_count).toBe(3);
    expect(g.oldest_reimbursable).toBe('2019-05-02');
    expect(g.withdrawals).toBe(2);
    expect(g.last_withdrawal).toBe('2026-06-01');
  });

  it('the balance lines end exactly at Reimbursable, month by month to today', () => {
    const s = balanceSeries(ledger, reimbursements, 'service_date', TODAY);
    expect(s[0]!.month).toBe('2019-05');
    const last = s[s.length - 1]!;
    expect(last.month).toBe('2026-11');
    expect(last.claimable_cents - last.reimbursed_cents).toBe(
      glance(ledger, reimbursements, 'service_date').reimbursable_cents,
    );
    // Months are contiguous and cumulative values never drop.
    for (let i = 1; i < s.length; i++) {
      expect(s[i]!.claimable_cents).toBeGreaterThanOrEqual(s[i - 1]!.claimable_cents);
      expect(s[i]!.reimbursed_cents).toBeGreaterThanOrEqual(s[i - 1]!.reimbursed_cents);
    }
    expect(s.length).toBe(7 * 12 + 7); // May 2019 .. Nov 2026
    // Reimbursed counts on the reimbursement date, not the care date.
    expect(s.find((p) => p.month === '2025-01')!.reimbursed_cents).toBe(0);
    expect(s.find((p) => p.month === '2025-02')!.reimbursed_cents).toBe(5_000);
    // The undated receipt lands on the day it was logged.
    expect(
      s.find((p) => p.month === '2026-09')!.claimable_cents -
        s.find((p) => p.month === '2026-08')!.claimable_cents,
    ).toBe(700);
  });

  it('months: last 12, current marked, split by status, undated counted', () => {
    const p = periods(ledger, 'service_date', TODAY, 'month');
    expect(p.rows).toHaveLength(12);
    expect(p.rows[0]!.key).toBe('2025-12');
    expect(p.rows[11]!).toMatchObject({ key: '2026-11', current: true, review_cents: 1_500 });
    expect(p.rows.find((r) => r.key === '2026-10')!.outstanding_cents).toBe(4_000);
    expect(p.rows.find((r) => r.key === '2026-01')!.excluded_cents).toBe(3_000);
    expect(p.undated_count).toBe(1);
  });

  it('quarters: last 8 ending in the current one', () => {
    const p = periods(ledger, 'service_date', TODAY, 'quarter');
    expect(p.rows.map((r) => r.key)).toEqual([
      '2025-Q1',
      '2025-Q2',
      '2025-Q3',
      '2025-Q4',
      '2026-Q1',
      '2026-Q2',
      '2026-Q3',
      '2026-Q4',
    ]);
    expect(p.rows.find((r) => r.key === '2025-Q3')!.reimbursed_cents).toBe(2_500);
  });

  it('years: every year from the first to now, gaps included', () => {
    const p = periods(ledger, 'service_date', TODAY, 'year');
    expect(p.rows.map((r) => r.key)).toEqual([
      '2019',
      '2020',
      '2021',
      '2022',
      '2023',
      '2024',
      '2025',
      '2026',
    ]);
    expect(p.rows.find((r) => r.key === '2020')!.outstanding_cents).toBe(0);
    expect(p.rows.at(-1)!.current).toBe(true);
  });

  it('aging buckets only reimbursable receipts', () => {
    const a = aging(ledger, 'service_date', TODAY);
    const by = Object.fromEntries(a.map((b) => [b.key, b]));
    expect(by.lt1!.cents).toBe(4_000);
    expect(by['5to10']!.cents).toBe(12_000);
    expect(by.undated!.cents).toBe(700);
    expect(a.reduce((s, b) => s + b.cents, 0)).toBe(
      glance(ledger, reimbursements, 'service_date').reimbursable_cents,
    );
  });

  it('breakdowns respect the window and sort by spending', () => {
    const extra = [
      ...ledger,
      entry({ service_date: '2026-02-01', category_id: 'c2', amount_cents: 9_000 }),
    ];
    const thisYear = breakdown(extra, 'service_date', TODAY, 'category', 'this');
    expect(thisYear[0]).toMatchObject({ id: 'c2', cents: 9_000 });
    expect(thisYear.find((r) => r.id === 'c1')!.cents).toBe(4_000 + 1_500 + 3_000);
    const all = breakdown(extra, 'service_date', TODAY, 'category', 'all');
    expect(all.reduce((s, r) => s + r.cents, 0)).toBe(
      glance(extra, [], 'service_date').documented_cents,
    );
    expect(breakdown(extra, 'service_date', TODAY, 'category', 'last')).toEqual([
      { id: 'c1', cents: 2_500, count: 1, reimbursable_cents: 0 },
    ]);
  });
});
