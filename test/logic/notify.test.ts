import { describe, expect, it } from 'vitest';
import {
  addDays,
  docLine,
  failedNotice,
  inboxKey,
  inboxKeyProblem,
  inboxNotices,
  inboxProblem,
  localDay,
  milestoneNotice,
  milestoneStep,
  notifiedIds,
  NOTIFY_KINDS,
  notifyMoney,
  pendingInbox,
  pendingReview,
  reviewKey,
  reviewNotice,
  weekday,
  weeklyNotice,
  yearEndNotice,
  type InboxEvent,
  type MilestoneState,
  type ReviewDoc,
} from '../../src/shared/logic';

const now = new Date('2027-03-10T15:00:00Z');
const doc = (p: Partial<ReviewDoc> = {}): ReviewDoc => ({
  id: 'd1',
  kind: 'receipt',
  filename: 'scan.pdf',
  processed_at: '2027-03-10T14:50:00Z',
  reasons: ['bad_amount'],
  provider: 'Lakeside Pediatrics',
  ...p,
});

describe('Needs review: words', () => {
  it('one document says what and why, and links to it', () => {
    expect(reviewNotice([doc()])).toEqual({
      kind: 'review',
      key: 'd1',
      title: 'Needs review',
      body: 'Receipt from Lakeside Pediatrics: amount looks wrong',
      url: '/review/d1',
      tag: 'review-d1',
    });
  });

  it('several become one notification to Review', () => {
    const n = reviewNotice([doc({ id: 'c' }), doc({ id: 'a' }), doc({ id: 'b' })])!;
    expect(n.body).toBe('3 documents need review');
    expect(n.url).toBe('/review');
    expect(n.key).toBe('a b c');
    expect(n.tag).toBe('review-a');
  });

  it('nothing pending, no notification', () => {
    expect(reviewNotice([])).toBeNull();
  });

  it('words each kind of document and reason', () => {
    expect(docLine(doc({ kind: 'eob', reasons: ['unknown_patient', 'low_confidence'] }))).toBe(
      'EOB from Lakeside Pediatrics: patient not recognized, and 1 more',
    );
    expect(docLine(doc({ provider: null, reasons: ['missing_date'] }))).toBe(
      'Receipt: no date found',
    );
    expect(
      docLine(doc({ kind: 'unknown', provider: null, reasons: ['scanned_pdf_unsupported'] })),
    ).toBe('scan.pdf: scanned PDF: no text to read');
    expect(docLine(doc({ kind: null, provider: null, reasons: ['extraction_failed'] }))).toBe(
      'scan.pdf: couldn’t read this document',
    );
    expect(docLine(doc({ reasons: [] }))).toBe('Receipt from Lakeside Pediatrics needs review');
  });
});

describe('Needs review: which documents', () => {
  const since = '2027-03-01T00:00:00Z';

  it('only documents read since the device signed up, within the last 3 days', () => {
    const docs = [
      doc({ id: 'new' }),
      doc({ id: 'before-device', processed_at: '2027-02-20T00:00:00Z' }),
      doc({ id: 'four-days', processed_at: '2027-03-06T14:00:00Z' }),
      doc({ id: 'never-read', processed_at: null }),
    ];
    expect(
      pendingReview(docs, { notified: new Set(), deviceSince: since, now }).map((d) => d.id),
    ).toEqual(['new']);
    // A device that signed up after the document was read doesn't hear about it.
    expect(
      pendingReview(docs, { notified: new Set(), deviceSince: '2027-03-10T14:55:00Z', now }),
    ).toEqual([]);
  });

  it('once per document: ids already in a sent key are left out', () => {
    const keys = [reviewKey(['b', 'a']), reviewKey(['c'])];
    expect(keys).toEqual(['a b', 'c']);
    const notified = notifiedIds(keys);
    expect([...notified].sort()).toEqual(['a', 'b', 'c']);
    const docs = ['a', 'b', 'c', 'd'].map((id) => doc({ id }));
    expect(pendingReview(docs, { notified, deviceSince: since, now }).map((d) => d.id)).toEqual([
      'd',
    ]);
  });
});

describe('the switches', () => {
  it('six kinds, each with a one-line description', () => {
    expect(NOTIFY_KINDS.map((k) => k.id)).toEqual([
      'review',
      'failed',
      'milestone',
      'year_end',
      'inbox',
      'weekly',
    ]);
    for (const k of NOTIFY_KINDS) {
      expect(k.description.length).toBeLessThan(70);
      expect(k.description).toMatch(/\.$/);
    }
  });
});

describe('overnight hold', () => {
  // The 9 p.m. to 8 a.m. window itself is the kit's (test/api/push.test.ts).
  it('what arrived overnight is still pending at 8 a.m.', () => {
    const d = doc({ processed_at: '2027-03-10T02:30:00Z' }); // 21:30 EST on the 9th
    const at8 = new Date('2027-03-10T13:00:00Z');
    expect(
      pendingReview([d], { notified: new Set(), deviceSince: '2027-03-01T00:00:00Z', now: at8 }),
    ).toHaveLength(1);
    const e: InboxEvent = { id: 'm1', at: '2027-03-10T02:30:00Z', problem: 'daily_cap' };
    expect(
      pendingInbox([e], {
        notified: new Set(),
        sentToday: new Set(),
        deviceSince: '2027-03-01T00:00:00Z',
        now: at8,
      }),
    ).toHaveLength(1);
  });
});

describe('Couldn’t read a document', () => {
  it('one document by name, linked to it', () => {
    expect(failedNotice([doc({ id: 'f1', filename: 'statement.pdf', failed: true })])).toEqual({
      kind: 'failed',
      key: 'f1',
      title: 'Couldn’t read a document',
      body: 'Couldn’t read statement.pdf.',
      url: '/review/f1',
      tag: 'failed-f1',
    });
  });

  it('several as one, to Review; none, nothing', () => {
    const n = failedNotice([doc({ id: 'b' }), doc({ id: 'a' })])!;
    expect(n).toMatchObject({
      title: 'Couldn’t read documents',
      body: 'Couldn’t read 2 documents.',
      url: '/review',
      key: 'a b',
    });
    expect(failedNotice([])).toBeNull();
  });

  it('once per document', () => {
    const notified = notifiedIds([reviewKey(['a'])]);
    const docs = [doc({ id: 'a', failed: true }), doc({ id: 'b', failed: true })];
    expect(
      pendingReview(docs, { notified, deviceSince: '2027-03-01T00:00:00Z', now }).map((d) => d.id),
    ).toEqual(['b']);
  });
});

describe('Reimbursable milestone', () => {
  const t0 = new Date('2027-03-10T15:00:00Z');
  const later = (h: number) => new Date(t0.getTime() + h * 3_600_000);

  it('the first look only records where the total is', () => {
    expect(milestoneStep(null, 60_000, 50_000, t0)).toEqual({ above: true, since: null });
    expect(milestoneStep(null, 10_000, 50_000, t0)).toEqual({ above: false, since: null });
  });

  it('crossing up starts a crossing; staying above keeps it; dropping below re-arms', () => {
    let s: MilestoneState = { above: false, since: null };
    s = milestoneStep(s, 49_999, 50_000, t0);
    expect(s).toEqual({ above: false, since: null });
    s = milestoneStep(s, 50_000, 50_000, t0); // at the amount counts
    expect(s).toEqual({ above: true, since: t0.toISOString() });
    expect(milestoneStep(s, 80_000, 50_000, later(1))).toBe(s);
    s = milestoneStep(s, 0, 50_000, later(2)); // reimbursed
    expect(s).toEqual({ above: false, since: null });
    s = milestoneStep(s, 51_200, 50_000, later(3));
    expect(s).toEqual({ above: true, since: later(3).toISOString() });
  });

  it('says how much, links to Reimbursable, and never twice for one crossing', () => {
    const s = { above: true, since: t0.toISOString() };
    const o = {
      totalCents: 51_200,
      sentKeys: new Set<string>(),
      deviceSince: '2027-03-01T00:00:00Z',
      now: later(1),
    };
    expect(milestoneNotice(s, o)).toEqual({
      kind: 'milestone',
      key: t0.toISOString(),
      title: 'Reimbursable',
      body: 'You have $512 reimbursable. Time to pay yourself back?',
      url: '/ledger?status=outstanding',
      tag: 'milestone',
    });
    expect(milestoneNotice(s, { ...o, sentKeys: new Set([t0.toISOString()]) })).toBeNull();
    expect(milestoneNotice({ above: true, since: null }, o)).toBeNull();
    expect(milestoneNotice({ above: false, since: null }, o)).toBeNull();
    // A device that signed up after the crossing, or a crossing days ago: nothing.
    expect(milestoneNotice(s, { ...o, deviceSince: later(0.5).toISOString() })).toBeNull();
    expect(milestoneNotice(s, { ...o, now: later(24 * 4) })).toBeNull();
  });

  it('money as on Home, without a bare .00', () => {
    expect(notifyMoney(51_200)).toBe('$512');
    expect(notifyMoney(21_340)).toBe('$213.40');
    expect(notifyMoney(123_456_7)).toBe('$12,345.67');
  });
});

describe('Year-end', () => {
  const years = [
    { year: 2026, outstanding_cents: 84_250 },
    { year: 2025, outstanding_cents: 1_000 },
  ];

  it('December 1 only, with what’s reimbursable from that year', () => {
    expect(yearEndNotice('2026-12-01', years)).toEqual({
      kind: 'year_end',
      key: '2026',
      title: 'Year-end',
      body: 'You have $842.50 reimbursable from 2026.',
      url: '/ledger?year=2026&status=outstanding',
      tag: 'year-end-2026',
    });
    expect(yearEndNotice('2026-12-02', years)).toBeNull();
    expect(yearEndNotice('2026-11-30', years)).toBeNull();
  });

  it('nothing when that year has nothing reimbursable', () => {
    expect(yearEndNotice('2027-12-01', years)).toBeNull();
    expect(yearEndNotice('2026-12-01', [{ year: 2026, outstanding_cents: 0 }])).toBeNull();
  });
});

describe('Weekly summary', () => {
  const NY = 'America/New_York';
  const entry = (created_at: string, amount_cents: number, p = {}) => ({
    type: 'receipt' as const,
    reimbursement_id: null,
    excluded_reason: null,
    review_reasons: [],
    amount_cents,
    service_date: '2026-11-02',
    payment_date: null,
    document_id: created_at,
    created_at,
    ...p,
  });
  const sunday8 = new Date('2026-11-08T13:00:00Z'); // Sunday 8:00 EST

  it('local dates and weekdays', () => {
    expect(localDay(new Date('2026-11-08T03:00:00Z'), NY)).toBe('2026-11-07');
    expect(localDay(new Date('2026-11-08T03:00:00Z'), 'Not/AZone')).toBe('2026-11-08');
    expect(weekday('2026-11-08')).toBe(0);
    expect(addDays('2026-11-08', -7)).toBe('2026-11-01');
  });

  it('Sunday: last Sunday to Saturday’s receipts, counted and totaled', () => {
    const entries = [
      entry('2026-11-01T03:00:00Z', 1_000), // Sat Oct 31, 23:00 EDT: the week before
      entry('2026-11-01T14:00:00Z', 4_500), // Sun Nov 1
      entry('2026-11-04T18:00:00Z', 12_000),
      entry('2026-11-07T20:00:00Z', 3_840, { review_reasons: ['missing_date'] }),
      entry('2026-11-08T04:30:00Z', 1_000), // Sat Nov 7, 23:30 EST
      entry('2026-11-05T18:00:00Z', 9_999, { type: 'eob' }), // EOBs aren't receipts
      entry('2026-11-08T12:00:00Z', 5_000), // this Sunday, 7:00: next week's
    ];
    expect(weeklyNotice(entries, { now: sunday8, tz: NY })).toEqual({
      kind: 'weekly',
      key: '2026-11-08',
      title: 'Weekly summary',
      body: 'This week: 4 receipts added, $213.40.',
      url: '/ledger?sort=added_desc',
      tag: 'weekly',
    });
  });

  it('skips weeks with nothing added, and days that aren’t Sunday', () => {
    expect(
      weeklyNotice([entry('2026-10-20T14:00:00Z', 4_500)], { now: sunday8, tz: NY }),
    ).toBeNull();
    const one = [entry('2026-11-04T18:00:00Z', 4_500)];
    expect(weeklyNotice(one, { now: sunday8, tz: NY })!.body).toBe(
      'This week: 1 receipt added, $45.',
    );
    expect(weeklyNotice(one, { now: new Date('2026-11-09T13:00:00Z'), tz: NY })).toBeNull();
  });
});

describe('Email inbox problem', () => {
  const NY = 'America/New_York';
  const noon = new Date('2026-11-09T17:00:00Z'); // 12:00 EST
  const ev = (id: string, problem: InboxEvent['problem'], at = '2026-11-09T15:00:00Z', p = {}) =>
    ({ id, at, problem, ...p }) as InboxEvent;
  const o = {
    notified: new Set<string>(),
    sentToday: new Set<InboxEvent['problem']>(),
    deviceSince: '2026-11-01T00:00:00Z',
    now: noon,
  };

  it('which inbox log outcomes are problems', () => {
    expect(inboxProblem('rejected', 'daily_cap')).toBe('daily_cap');
    expect(inboxProblem('rejected', 'too_large')).toBe('too_large');
    expect(inboxProblem('rejected', 'sender_not_allowed')).toBe('sender_not_allowed');
    expect(inboxProblem('failed', 'store_failed')).toBe('failed');
    expect(inboxProblem('rejected', 'unknown_recipient')).toBeNull(); // spam to a wrong address
    expect(inboxProblem('rejected', 'paused')).toBeNull();
    expect(inboxProblem('accepted', null)).toBeNull();
  });

  it('one notification per problem, worded and linked to the inbox settings', () => {
    const events = [
      ev('a', 'daily_cap'),
      ev('b', 'daily_cap'),
      ev('c', 'daily_cap'),
      ev('v', 'verification', '2026-11-09T14:00:00Z', { provider: 'Gmail', code: true }),
      ev('s', 'sender_not_allowed'),
      ev('f', 'failed'),
    ];
    const ns = inboxNotices(events, { now: noon, tz: NY });
    expect(ns.map((n) => n.body)).toEqual([
      'Gmail sent a forwarding code. Enter it in Gmail to finish setup.',
      '3 emails were rejected today: daily limit reached.',
      'An email was rejected today: sender not on the allow list.',
      'An email couldn’t be read today.',
    ]);
    expect(ns[1]).toEqual({
      kind: 'inbox',
      key: 'daily_cap a b c',
      title: 'Email inbox',
      body: '3 emails were rejected today: daily limit reached.',
      url: '/settings/inbox',
      tag: 'inbox-daily_cap',
    });
    expect(inboxNotices([ev('t', 'too_large')], { now: noon, tz: NY })[0]!.body).toBe(
      'An email was rejected today: too large.',
    );
    expect(
      inboxNotices([ev('v', 'verification', undefined, { provider: 'Outlook' })], {
        now: noon,
        tz: NY,
      })[0]!.body,
    ).toBe('Outlook sent a forwarding confirmation. Open it in Settings to finish setup.');
    expect(inboxNotices([], { now: noon, tz: NY })).toEqual([]);
  });

  it('held overnight, it doesn’t say “today”', () => {
    const at8 = new Date('2026-11-10T13:00:00Z');
    const n = inboxNotices([ev('a', 'too_large', '2026-11-10T03:00:00Z')], { now: at8, tz: NY });
    expect(n[0]!.body).toBe('An email was rejected: too large.');
  });

  it('never twice: each email once, and each problem once a day', () => {
    expect(inboxKeyProblem(inboxKey('daily_cap', ['b', 'a']))).toBe('daily_cap');
    const events = [ev('a', 'daily_cap'), ev('b', 'daily_cap'), ev('t', 'too_large')];
    const notified = notifiedIds([inboxKey('daily_cap', ['a'])]);
    expect(pendingInbox(events, { ...o, notified }).map((e) => e.id)).toEqual(['b', 't']);
    expect(
      pendingInbox(events, { ...o, sentToday: new Set(['daily_cap'] as const) }).map((e) => e.id),
    ).toEqual(['t']);
    // Before the device signed up, or older than the last few days: left out.
    expect(pendingInbox([ev('old', 'too_large', '2026-10-01T00:00:00Z')], o)).toEqual([]);
    expect(pendingInbox(events, { ...o, deviceSince: '2026-11-09T16:00:00Z' })).toEqual([]);
  });
});
