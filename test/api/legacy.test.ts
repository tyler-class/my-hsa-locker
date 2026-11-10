import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ORIGIN, session } from './helpers';

describe('legacy import endpoints', () => {
  it('stores a file once and adds its entries once', async () => {
    const api = await session();
    const put = () =>
      SELF.fetch(`${ORIGIN}/api/legacy-import/document`, {
        method: 'POST',
        headers: {
          Cookie: api.cookie,
          Origin: ORIGIN,
          'Content-Type': 'application/pdf',
          'X-File-Name': 'old.pdf',
          'X-Legacy-Md5': 'abc',
        },
        body: '%PDF-1.4 legacy synthetic file',
      }).then(async (r) => ({
        status: r.status,
        data: (await r.json()) as { id: string; duplicate: boolean },
      }));
    const a = await put();
    const b = await put();
    expect(a.status).toBe(201);
    expect(b.data).toEqual({ id: a.data.id, duplicate: true });

    const entries = {
      document_id: a.data.id,
      kind: 'receipt',
      entries: [
        {
          type: 'receipt',
          service_date: '2023-05-01',
          payment_date: null,
          person_id: null,
          patient_name_raw: 'Sam',
          provider_id: null,
          provider_name_raw: 'Clinic',
          description: null,
          category_id: null,
          amount_cents: 2500,
          card_last4: null,
          notes: null,
          review_reasons: ['unknown_patient'],
          processed_at: null,
        },
      ],
    };
    const first = await api.post<{ added: number }>('/legacy-import/entries', entries);
    const second = await api.post<{ skipped: boolean }>('/legacy-import/entries', entries);
    expect(first.data.added).toBe(1);
    expect(second.data.skipped).toBe(true);
    const doc = await api.get<{ document: { status: string; source: string } }>(
      `/documents/${a.data.id}`,
    );
    expect(doc.data.document).toMatchObject({ status: 'needs_review', source: 'import' });
  });
});
