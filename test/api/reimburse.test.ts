import { describe, expect, it } from 'vitest';
import type { LedgerEntry, Reimbursement } from '../../src/shared/types';
import type { Totals } from '../../src/shared/logic';
import { session } from './helpers';

describe('summary and reimbursements (sample household)', () => {
  it('computes totals, records and undoes a reimbursement', async () => {
    const api = await session();
    expect((await api.post('/sample-data')).status).toBe(201);
    const sum = async () => (await api.get<{ totals: Totals }>('/summary')).data.totals;
    const before = await sum();
    // Pending review is never part of outstanding.
    expect(before.pending_review_cents).toBe(6000 + 31275 + 1200);
    expect(before.eob_document_count).toBe(1);
    expect(before.eob_line_count).toBe(4);

    const { entries } = (await api.get<{ entries: LedgerEntry[] }>('/entries')).data;
    const outstanding = entries.filter(
      (e) =>
        e.type === 'receipt' &&
        !e.reimbursement_id &&
        !e.excluded_reason &&
        !e.review_reasons.length,
    );
    const pick = outstanding.slice(0, 2);
    const total = pick.reduce((s, e) => s + e.amount_cents!, 0);
    const r = await api.post<Reimbursement>('/reimbursements', {
      date: '2026-10-01',
      note: 'test',
      entry_ids: pick.map((e) => e.id),
    });
    expect(r.status).toBe(201);
    expect(r.data.total_cents).toBe(total);
    const mid = await sum();
    expect(mid.outstanding_cents).toBe(before.outstanding_cents - total);
    expect(mid.reimbursed_cents).toBe(before.reimbursed_cents + total);

    // Can't reimburse twice, or reimburse an EOB line.
    expect(
      (await api.post('/reimbursements', { date: '2026-10-02', entry_ids: [pick[0]!.id] })).status,
    ).toBe(409);
    const eob = entries.find((e) => e.type === 'eob')!;
    expect(
      (await api.post('/reimbursements', { date: '2026-10-02', entry_ids: [eob.id] })).status,
    ).toBe(400);

    // Per-receipt toggle, then undo the rest.
    await api.post('/entries/unreimburse', { ids: [pick[0]!.id] });
    expect((await sum()).reimbursed_cents).toBe(before.reimbursed_cents + pick[1]!.amount_cents!);
    expect((await api.del(`/reimbursements/${r.data.id}`)).status).toBe(200);
    expect(await sum()).toEqual(before);
  });

  it('approving a review entry moves it into outstanding', async () => {
    const api = await session();
    const { entries } = (await api.get<{ entries: LedgerEntry[] }>('/review')).data;
    const e = entries.find((x) => x.review_reasons.includes('low_confidence'))!;
    const before = (await api.get<{ totals: Totals }>('/summary')).data.totals;
    await api.post(`/entries/${e.id}/approve`);
    const after = (await api.get<{ totals: Totals }>('/summary')).data.totals;
    expect(after.outstanding_cents - before.outstanding_cents).toBe(e.amount_cents);
    expect(before.pending_review_cents - after.pending_review_cents).toBe(e.amount_cents);
  });

  it('exports a CSV that respects filters', async () => {
    const api = await session();
    const all = await api.get<string>('/export/ledger.csv');
    const eobOnly = await api.get<string>('/export/ledger.csv?type=eob');
    expect(all.data.split('\r\n')[0]).toMatch(/^Document Type,Flag for Review,Appointment Date/);
    expect(eobOnly.data.trim().split('\r\n')).toHaveLength(5);
  });

  it('backs up and restores', async () => {
    const api = await session();
    const backup = (
      await api.get<{ tables: Record<string, unknown[]>; files: string[] }>('/export')
    ).data;
    expect(JSON.stringify(backup.tables.settings)).not.toMatch(/session_salt|inbox_token/);
    expect(backup.files.length).toBeGreaterThan(0);
    const count = backup.tables.entries!.length;
    const r = await api.post<{ missing_files: number }>('/import', backup);
    expect(r.status).toBe(200);
    expect(r.data.missing_files).toBe(0);
    expect((await api.get<{ entries: unknown[] }>('/entries')).data.entries).toHaveLength(count);
    expect((await api.get('/session')).status).toBe(200);
    expect((await api.post('/import', { hello: 1 })).status).toBe(400);
  });
});
