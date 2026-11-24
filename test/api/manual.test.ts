import { describe, expect, it } from 'vitest';
import type { Entry, LedgerEntry } from '../../src/shared/types';
import { session } from './helpers';

describe('an entry typed in by hand', () => {
  it('lands in the Ledger with no upload, and is never read by the model', async () => {
    const api = await session();
    const person = await api.post<{ id: string }>('/people', { name: 'Hand Entry Kid' });
    const provider = await api.post<{ id: string }>('/providers', { name: 'Corner Pharmacy' });
    const category = await api.post<{ id: string }>('/categories', { name: 'Hand typed' });
    expect([person.status, provider.status, category.status]).toEqual([201, 201, 201]);

    const r = await api.post<Entry>('/entries', {
      type: 'receipt',
      service_date: '2026-11-02',
      payment_date: '2026-11-02',
      person_id: person.data.id,
      provider_id: provider.data.id,
      category_id: category.data.id,
      description: 'Allergy medicine',
      amount_cents: 2399,
    });
    expect(r.status).toBe(201);
    expect(r.data.amount_cents).toBe(2399);
    expect(r.data.review_reasons).toEqual([]);

    const ledger = await api.get<{ entries: LedgerEntry[] }>('/entries');
    const row = ledger.data.entries.find((e) => e.id === r.data.id)!;
    expect(row.doc_status).toBe('processed');
    expect(row.provider_id).toBe(provider.data.id);

    const again = await api.post(`/documents/${r.data.document_id}/reprocess`);
    expect(again.status).toBe(409);
  });
});
