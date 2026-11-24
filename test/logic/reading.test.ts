import { describe, expect, it } from 'vitest';
import { needsCopy, readingStatus, readingTitle } from '../../src/client/lib/reading';
import {
  filterFromParams,
  filterLedger,
  LEDGER_STATUSES,
  ledgerCounts,
} from '../../src/shared/logic';
import type { LedgerEntry } from '../../src/shared/types';

describe('placeholder rows for documents being read', () => {
  it('calls a camera’s file name a photo and keeps a real name', () => {
    for (const filename of [
      'IMG_1234.HEIC',
      'image.jpg',
      'PXL_20261124_153012345.jpg',
      'photo.png',
    ])
      expect(readingTitle({ filename, mime: 'image/jpeg' })).toBe('Photo');
    expect(readingTitle({ filename: 'walgreens receipt.jpg', mime: 'image/jpeg' })).toBe(
      'walgreens receipt.jpg',
    );
    expect(readingTitle({ filename: 'IMG_1234.pdf', mime: 'application/pdf' })).toBe(
      'IMG_1234.pdf',
    );
  });

  it('says reading, or when it will try again', () => {
    const now = Date.parse('2026-11-24T15:30:00Z');
    expect(readingStatus({ status: 'pending', next_attempt_at: null }, now).label).toBe('Reading…');
    expect(readingStatus({ status: 'processing', next_attempt_at: null }, now).label).toBe(
      'Reading…',
    );
    const later = readingStatus(
      { status: 'failed', next_attempt_at: '2026-11-24T15:42:00Z' },
      now,
      () => '3:42 PM',
    );
    expect(later).toEqual({
      label: 'Couldn’t read it yet · trying again at 3:42 PM',
      retrying: true,
    });
    expect(
      readingStatus({ status: 'failed', next_attempt_at: '2026-11-24T15:00:00Z' }, now).label,
    ).toBe('Couldn’t read it yet · trying again now');
  });
});

describe('the Ledger’s Processing choice', () => {
  const entry = (p: Partial<LedgerEntry>): LedgerEntry =>
    ({
      id: Math.random().toString(36),
      document_id: 'd',
      type: 'receipt',
      service_date: '2026-03-01',
      payment_date: null,
      person_id: null,
      patient_name_raw: null,
      provider_id: null,
      provider_name_raw: null,
      description: null,
      category_id: null,
      amount_cents: 1000,
      card_last4: null,
      notes: null,
      review_reasons: [],
      excluded_reason: null,
      excluded_auto: false,
      reimbursement_id: null,
      dup_of_entry_id: null,
      sort_order: 0,
      created_at: '',
      doc_filename: 'r.pdf',
      ...p,
    }) as LedgerEntry;
  const entries = [
    entry({}),
    entry({ excluded_reason: 'paid_with_hsa' }),
    entry({ excluded_reason: 'not_eligible' }),
    entry({ review_reasons: ['unknown_patient'] }),
  ];

  it('counts the documents being read, alongside the others', () => {
    const counts = ledgerCounts(
      entries,
      filterFromParams(new URLSearchParams()),
      'service_date',
      undefined,
      3,
    );
    expect(counts).toEqual({
      all: 4,
      processing: 3,
      needs_review: 1,
      outstanding: 1,
      reimbursed: 0,
      excluded: 2,
    });
    // Every choice the Ledger offers has a count.
    expect(Object.keys(counts).sort()).toEqual([...LEDGER_STATUSES].sort());
  });

  it('holds no entries, and the other filters don’t change its count', () => {
    const f = filterFromParams(new URLSearchParams('status=processing&year=2026&q=nothing'));
    expect(f.status).toBe('processing');
    expect(filterLedger(entries, f, 'service_date')).toEqual([]);
    expect(ledgerCounts(entries, f, 'service_date', undefined, 2).processing).toBe(2);
    expect(ledgerCounts(entries, f, 'service_date', undefined, 0).processing).toBe(0);
  });
});

describe('a reading copy for a photo sent before the app made them', () => {
  it('is made only for a photo being read that the server says has none', () => {
    const photo = { mime: 'image/jpeg', status: 'failed', has_reading_copy: false };
    expect(needsCopy(photo)).toBe(true);
    expect(needsCopy({ ...photo, status: 'pending' })).toBe(true);
    expect(needsCopy({ ...photo, has_reading_copy: true })).toBe(false);
    // Not said (an older server, or a list other than in-flight): leave it.
    expect(needsCopy({ mime: 'image/jpeg', status: 'failed' })).toBe(false);
    expect(needsCopy({ ...photo, mime: 'application/pdf' })).toBe(false);
    expect(needsCopy({ ...photo, status: 'processed' })).toBe(false);
  });
});
