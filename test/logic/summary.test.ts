import { describe, expect, it } from 'vitest';
import type { Entry } from '../../src/shared/types';
import {
  applyHsaCards,
  collapseIdentical,
  entryStatus,
  entryYear,
  findDuplicate,
  resolvedReasons,
  reviewReasons,
  summarize,
} from '../../src/shared/logic';

let n = 0;
function entry(p: Partial<Entry>): Entry {
  n++;
  return {
    id: `e${n}`,
    document_id: `d${n}`,
    type: 'receipt',
    service_date: '2024-03-01',
    payment_date: null,
    person_id: 'p1',
    patient_name_raw: null,
    provider_id: 'v1',
    provider_name_raw: null,
    description: null,
    category_id: null,
    amount_cents: 1000,
    card_last4: null,
    billed_cents: null,
    allowed_cents: null,
    plan_paid_cents: null,
    patient_resp_cents: null,
    notes: null,
    confidence: 0.9,
    source_quote: null,
    review_reasons: [],
    reviewed_at: null,
    excluded_reason: null,
    excluded_auto: false,
    reimbursement_id: null,
    dup_of_entry_id: null,
    sort_order: 0,
    created_at: '',
    updated_at: '',
    ...p,
  };
}

describe('status and totals', () => {
  it('orders status: reimbursed, excluded, review, outstanding; EOBs separate', () => {
    expect(entryStatus(entry({}))).toBe('outstanding');
    expect(entryStatus(entry({ review_reasons: ['unknown_patient'] }))).toBe('needs_review');
    expect(entryStatus(entry({ excluded_reason: 'not_eligible', review_reasons: ['x'] }))).toBe(
      'excluded',
    );
    expect(entryStatus(entry({ reimbursement_id: 'r', excluded_reason: 'not_eligible' }))).toBe(
      'reimbursed',
    );
    expect(entryStatus(entry({ type: 'eob', amount_cents: 5000 }))).toBe('eob');
  });

  it('year basis falls back to the other date', () => {
    const e = entry({ service_date: '2023-12-30', payment_date: '2024-01-03' });
    expect(entryYear(e, 'service_date')).toBe(2023);
    expect(entryYear(e, 'payment_date')).toBe(2024);
    expect(
      entryYear(entry({ service_date: null, payment_date: '2022-05-01' }), 'service_date'),
    ).toBe(2022);
    expect(entryYear(entry({ service_date: null }), 'service_date')).toBeNull();
  });

  it('keeps pending review out of outstanding and EOBs out of money', () => {
    const doc = 'eobdoc';
    const rows = [
      entry({ amount_cents: 10000 }), // outstanding
      entry({ amount_cents: 2500, reimbursement_id: 'r1' }),
      entry({ amount_cents: 700, review_reasons: ['amount_not_in_source'] }),
      entry({ amount_cents: 300, excluded_reason: 'paid_with_hsa' }),
      entry({ type: 'eob', document_id: doc, amount_cents: null, billed_cents: 99999 }),
      entry({ type: 'eob', document_id: doc, amount_cents: null }),
      entry({ amount_cents: 4000, service_date: '2023-07-01' }),
      entry({ amount_cents: 100, service_date: null }),
    ];
    const { all, years } = summarize(rows, 'service_date');
    expect(all.documented_cents).toBe(10000 + 2500 + 700 + 300 + 4000 + 100);
    expect(all.outstanding_cents).toBe(10000 + 4000 + 100);
    expect(all.reimbursed_cents).toBe(2500);
    expect(all.pending_review_cents).toBe(700);
    expect(all.excluded_cents).toBe(300);
    expect(all.eob_line_count).toBe(2);
    expect(all.eob_document_count).toBe(1);
    expect(years.map((y) => y.year)).toEqual([2024, 2023, null]);
    expect(years[0]!.documented_cents).toBe(13500);
    expect(years[0]!.eob_document_count).toBe(1);
  });
});

describe('HSA cards', () => {
  it('excludes matching receipts automatically and reversibly', () => {
    const e = entry({ card_last4: '**** 4242' });
    const out = applyHsaCards(e, ['4242']);
    expect(out.excluded_reason).toBe('paid_with_hsa');
    expect(out.excluded_auto).toBe(true);
    const undone = applyHsaCards(out, []);
    expect(undone.excluded_reason).toBeNull();
  });
  it('leaves missing cards, other cards, manual exclusions and EOBs alone', () => {
    expect(applyHsaCards(entry({ card_last4: null }), ['4242']).excluded_reason).toBeNull();
    expect(applyHsaCards(entry({ card_last4: '1111' }), ['4242']).excluded_reason).toBeNull();
    const manual = entry({ card_last4: '1111', excluded_reason: 'not_eligible' });
    expect(applyHsaCards(manual, [])).toBe(manual);
    const eob = entry({ type: 'eob', card_last4: '4242' });
    expect(applyHsaCards(eob, ['4242']).excluded_reason).toBeNull();
  });
});

describe('review reasons', () => {
  const base = {
    type: 'receipt' as const,
    amount_cents: 4500,
    service_date: '2024-03-01',
    payment_date: null,
    patient_name_raw: 'Sam',
    person_id: 'p1',
    provider_name_raw: 'Clinic',
    provider_id: 'v1',
    confidence: 0.95,
    dup_of_entry_id: null,
  };
  const now = new Date('2024-06-01');
  it('is clean when everything checks out', () => {
    expect(reviewReasons(base, { sourceText: 'Paid $45.00', now })).toEqual([]);
  });
  it('flags hallucinated amounts only when there is source text', () => {
    expect(reviewReasons(base, { sourceText: 'Paid $54.00', now })).toEqual([
      'amount_not_in_source',
    ]);
    expect(reviewReasons(base, { now })).toEqual([]);
  });
  it('flags missing, zero, negative and unparsed amounts on receipts only', () => {
    expect(reviewReasons({ ...base, amount_cents: null }, { now })).toContain('missing_amount');
    expect(reviewReasons({ ...base, amount_cents: 0 }, { now })).toContain('missing_amount');
    expect(reviewReasons({ ...base, amount_cents: -5 }, { now })).toContain('bad_amount');
    expect(reviewReasons({ ...base, amount_unparsed: true }, { now })).toContain('bad_amount');
    expect(reviewReasons({ ...base, type: 'eob', amount_cents: null }, { now })).toEqual([]);
  });
  it('flags dates, people, providers, confidence and duplicates', () => {
    const r = reviewReasons(
      {
        ...base,
        service_date: '2030-01-01',
        person_id: null,
        provider_id: null,
        provider_suggested: true,
        confidence: 0.3,
        dup_of_entry_id: 'x',
      },
      { now },
    );
    expect(r).toEqual([
      'date_in_future',
      'unknown_patient',
      'provider_suggestion',
      'low_confidence',
      'possible_duplicate',
    ]);
    expect(reviewReasons({ ...base, service_date: null }, { now })).toEqual(['missing_date']);
    expect(reviewReasons({ ...base, patient_name_raw: null, person_id: null }, { now })).toEqual([
      'missing_patient',
    ]);
  });
  it('drops reasons an edit has fixed', () => {
    expect(
      resolvedReasons(['unknown_patient', 'low_confidence'], { ...base, person_id: 'p2' }),
    ).toEqual(['low_confidence']);
  });
});

describe('duplicates', () => {
  it('finds the same visit from another document, with truncated provider names', () => {
    const a = entry({
      document_id: 'A',
      provider_id: null,
      provider_name_raw: 'Lakeside Physical Therapy',
      amount_cents: 4500,
    });
    const b = entry({
      document_id: 'B',
      provider_id: null,
      provider_name_raw: 'Lakeside Physical Ther',
      amount_cents: 4500,
    });
    expect(findDuplicate(b, [a])?.id).toBe(a.id);
    expect(findDuplicate({ ...b, amount_cents: 4600 }, [a])).toBeNull();
    expect(findDuplicate({ ...b, document_id: 'A' }, [a])).toBeNull();
    expect(findDuplicate({ ...b, person_id: null }, [a])).toBeNull();
  });
  it('compares EOB lines by description', () => {
    const a = entry({
      type: 'eob',
      document_id: 'A',
      description: 'NEUROMUSCULAR REEDUCATION 97112',
    });
    const b = entry({
      type: 'eob',
      document_id: 'B',
      description: 'Neuromuscular reeducation 97112',
    });
    expect(findDuplicate(b, [a])?.id).toBe(a.id);
    expect(findDuplicate({ ...b, description: 'THERAPEUTIC EXERCISE 97110' }, [a])).toBeNull();
  });
  it('collapses identical rows', () => {
    const r = { ...entry({ type: 'eob', description: 'X' }) };
    const { kept, collapsed } = collapseIdentical([r, { ...r }, { ...r, description: 'Y' }]);
    expect(kept).toHaveLength(2);
    expect(collapsed).toBe(1);
  });
});
