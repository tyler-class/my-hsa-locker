import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DocumentSummary, Entry, LedgerEntry } from '../../src/shared/types';
import { processDocument } from '../../src/worker/extract/pipeline';
import { Api, ORIGIN, fakePdf, receiptExtraction, session, upload } from './helpers';

let api: Api;

/** Waits for background processing, then makes sure it ran (idempotent). */
async function settle(id: string): Promise<{ document: DocumentSummary; entries: Entry[] }> {
  for (let i = 0; i < 40; i++) {
    const r = await api.get<{ document: DocumentSummary; entries: Entry[] }>(`/documents/${id}`);
    if (!['pending', 'processing'].includes(r.data.document.status)) return r.data;
    if (r.data.document.status === 'pending') await processDocument(env, id);
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('document never settled');
}

beforeAll(async () => {
  api = await session();
  await api.post('/people', { name: 'Sam Example', relationship: 'Self' });
  await api.post('/people', { name: 'Alex', relationship: 'Spouse' });
  await api.patch('/settings', { family_names: ['Example'], hsa_cards: ['4242'] });
});

describe('upload and extraction', () => {
  it('reads a clean receipt into an outstanding entry', async () => {
    const up = await upload(
      api,
      fakePdf('Lakeside Clinic. Amount paid $45.00', receiptExtraction()),
      'visit.pdf',
    );
    expect(up.status).toBe(201);
    const { document, entries } = await settle(up.data.document.id);
    expect(document.status).toBe('processed');
    expect(document.kind).toBe('receipt');
    expect(document.extraction_provider).toBe('fake');
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.amount_cents).toBe(4500);
    expect(e.person_id).toBeTruthy();
    expect(e.provider_id).toBeTruthy();
    expect(e.review_reasons).toEqual([]);
    // List endpoints never include the raw model output.
    const list = await api.get<{ documents: Record<string, unknown>[] }>('/documents');
    expect(JSON.stringify(list.data)).not.toMatch(/extraction_json|FAKE_EXTRACTION/);
  });

  it('stores identical bytes once', async () => {
    const bytes = fakePdf(
      'Same file twice $45.00',
      receiptExtraction({ appointment_date: '2024-01-01' }),
    );
    const a = await upload(api, bytes, 'a.pdf');
    const b = await upload(api, bytes, 'b.pdf');
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.data.duplicate).toBe(true);
    expect(b.data.document.id).toBe(a.data.document.id);
  });

  it('flags an amount that is not printed in the document', async () => {
    const up = await upload(
      api,
      fakePdf(
        'Lakeside Clinic. Amount paid $54.00',
        receiptExtraction({ amount: '45.00', appointment_date: '2024-04-01' }),
      ),
      'typo.pdf',
    );
    const { document, entries } = await settle(up.data.document.id);
    expect(document.status).toBe('needs_review');
    expect(entries[0]!.review_reasons).toContain('amount_not_in_source');
  });

  it('normalizes legacy-style names and flags strangers', async () => {
    const up = await upload(
      api,
      fakePdf('two lines $10.00 $20.00', {
        document_type: 'Receipt',
        line_items: [
          {
            ...receiptExtraction().line_items[0],
            patient_name: 'Example, Alex',
            amount: '10.00',
            appointment_date: '2024-05-01',
          },
          {
            ...receiptExtraction().line_items[0],
            patient_name: 'Sammy Example',
            amount: '20.00',
            appointment_date: '2024-05-02',
          },
        ],
      }),
      'names.pdf',
    );
    const { entries } = await settle(up.data.document.id);
    const state = await api.get<{ people: { id: string; name: string }[] }>('/state');
    const alex = state.data.people.find((p) => p.name === 'Alex')!;
    expect(entries[0]!.person_id).toBe(alex.id);
    // Close to Sam Example: not a new person, so it goes to Review.
    expect(entries[1]!.person_id).toBeNull();
    expect(entries[1]!.review_reasons).toContain('unknown_patient');
    expect(state.data.people.map((p) => p.name)).not.toContain('Sammy Example');

    // "Add as alias to X" resolves it.
    const sam = state.data.people.find((p) => p.name === 'Sam Example')!;
    const r = await api.post<{ resolved: number }>(`/people/${sam.id}/alias`, {
      alias: 'Sammy Example',
    });
    expect(r.data.resolved).toBe(1);
  });

  it('adds a new person for a new name, once, and the next receipt finds them', async () => {
    type Person = { id: string; name: string; aliases: string[]; color: string };
    const people = async () =>
      (await api.get<{ people: Person[] }>('/state')).data.people.filter((p) =>
        p.name.startsWith('Jordan'),
      );
    const line = (patient_name: string, amount: string, appointment_date: string) => ({
      ...receiptExtraction().line_items[0],
      patient_name,
      amount,
      appointment_date,
      payment_date: appointment_date,
    });
    // Two lines for the same new name, printed in capitals: one person, both lines theirs.
    const up = await upload(
      api,
      fakePdf('Jordan Rivera $31.00 $32.00', {
        document_type: 'Receipt',
        line_items: [
          line('JORDAN  RIVERA', '31.00', '2024-07-01'),
          line(' Jordan Rivera ', '32.00', '2024-07-02'),
        ],
      }),
      'new-person.pdf',
    );
    const { document, entries } = await settle(up.data.document.id);
    const [jordan, ...others] = await people();
    expect(others).toEqual([]);
    expect(jordan).toMatchObject({ name: 'Jordan Rivera', aliases: [] });
    expect(jordan!.color).toBeTruthy();
    expect(entries.map((e) => e.person_id)).toEqual([jordan!.id, jordan!.id]);
    expect(entries.flatMap((e) => e.review_reasons)).toEqual([]);
    expect(document.status).toBe('processed');

    // A second receipt for them reuses the person.
    const again = await upload(
      api,
      fakePdf('Jordan Rivera $33.00', {
        document_type: 'Receipt',
        line_items: [line('Jordan Rivera', '33.00', '2024-07-09')],
      }),
      'new-person-again.pdf',
    );
    const second = await settle(again.data.document.id);
    expect(second.entries[0]!.person_id).toBe(jordan!.id);
    expect(await people()).toHaveLength(1);
  });

  it('adds nobody for a near match or a placeholder; those go to Review', async () => {
    const before = (await api.get<{ people: unknown[] }>('/state')).data.people.length;
    await api.post('/people', { name: 'William Smith' });
    const names = ['Wm. Smith', 'Patient', 'GUARANTOR', 'Self', 'N/A', 'Unknown', 'J', 'Child 2'];
    const up = await upload(
      api,
      fakePdf('Placeholders $41.00', {
        document_type: 'Receipt',
        line_items: names.map((patient_name, i) => ({
          ...receiptExtraction().line_items[0],
          patient_name,
          amount: '41.00',
          appointment_date: `2024-08-${String(i + 1).padStart(2, '0')}`,
          payment_date: `2024-08-${String(i + 1).padStart(2, '0')}`,
        })),
      }),
      'placeholders.pdf',
    );
    const { document, entries } = await settle(up.data.document.id);
    expect(entries).toHaveLength(names.length);
    for (const e of entries) {
      expect(e.person_id).toBeNull();
      expect(e.review_reasons).toContain('unknown_patient');
    }
    expect(document.status).toBe('needs_review');
    expect((await api.get<{ people: unknown[] }>('/state')).data.people).toHaveLength(before + 1);
  });

  it('keeps EOB lines out of the money and marks HSA-card receipts', async () => {
    const eob = await upload(
      api,
      fakePdf('EOB', {
        document_type: 'EOB',
        line_items: [
          {
            appointment_date: '2024-06-01',
            patient_name: 'Sam Example',
            provider_name: 'Lakeside Physical Ther',
            description: 'NEUROMUSCULAR REEDUCATION 97112',
            amount: '99.00',
            billed: '150.00',
            confidence: 0.9,
          },
          {
            appointment_date: '2024-06-08',
            patient_name: 'Sam Example',
            provider_name: 'Lakeside Physical Ther',
            description: 'THERAPEUTIC EXERCISE 97110',
            billed: '120.00',
            confidence: 0.9,
          },
        ],
      }),
      'eob.pdf',
    );
    const e = await settle(eob.data.document.id);
    expect(e.document.kind).toBe('eob');
    expect(e.entries.map((x) => x.amount_cents)).toEqual([null, null]);
    expect(e.entries[0]!.billed_cents).toBe(15000);

    const hsa = await upload(
      api,
      fakePdf(
        'Paid $80.00 with card 4242',
        receiptExtraction({ amount: '80.00', card_last4: '4242', appointment_date: '2024-07-01' }),
      ),
      'hsa.pdf',
    );
    const h = await settle(hsa.data.document.id);
    expect(h.entries[0]!.excluded_reason).toBe('paid_with_hsa');
    expect(h.entries[0]!.excluded_auto).toBe(true);

    // Removing the card from the list makes it reimbursable again.
    await api.patch('/settings', { hsa_cards: [] });
    const after = await api.get<LedgerEntry>(`/entries/${h.entries[0]!.id}`);
    expect(after.data.excluded_reason).toBeNull();
    await api.patch('/settings', { hsa_cards: ['4242'] });
  });

  it('flags the same visit arriving in a second document', async () => {
    const x = receiptExtraction({ appointment_date: '2024-08-01', amount: '60.00' });
    const a = await upload(api, fakePdf('Visit $60.00 copy A', x), 'a1.pdf');
    await settle(a.data.document.id);
    const b = await upload(api, fakePdf('Visit $60.00 copy B (different bytes)', x), 'a2.pdf');
    const r = await settle(b.data.document.id);
    expect(r.entries[0]!.review_reasons).toContain('possible_duplicate');
    expect(r.entries[0]!.dup_of_entry_id).toBeTruthy();
    // Merge drops the second copy.
    expect((await api.post(`/entries/${r.entries[0]!.id}/merge`)).status).toBe(200);
    expect((await api.get(`/entries/${r.entries[0]!.id}`)).status).toBe(404);
  });

  it('sends unknown documents to review instead of dropping them', async () => {
    const up = await upload(
      api,
      fakePdf('Newsletter', {
        document_type: 'Unknown',
        line_items: [{ flag_for_review: true, additional_notes: 'Marketing' }],
      }),
      'news.pdf',
    );
    const { document, entries } = await settle(up.data.document.id);
    expect(document.status).toBe('needs_review');
    expect(document.review_reasons).toEqual(['not_a_receipt']);
    expect(entries).toHaveLength(0);
  });

  it('reprocessing replaces entries instead of duplicating them', async () => {
    const up = await upload(
      api,
      fakePdf('Again $45.00', receiptExtraction({ appointment_date: '2024-09-09' })),
      'again.pdf',
    );
    await settle(up.data.document.id);
    expect((await api.post(`/documents/${up.data.document.id}/reprocess`)).status).toBe(200);
    const r = await settle(up.data.document.id);
    expect(r.entries).toHaveLength(1);
    expect(await processDocument(env, up.data.document.id)).toBe('skipped');
  });

  it('serves the original only to signed-in users, with safe headers', async () => {
    const up = await upload(
      api,
      fakePdf('File $45.00', receiptExtraction({ appointment_date: '2024-10-10' })),
      'file.pdf',
    );
    const id = up.data.document.id;
    expect((await SELF.fetch(`${ORIGIN}/api/files/${id}`)).status).toBe(401);
    const res = await SELF.fetch(`${ORIGIN}/api/files/${id}`, { headers: { Cookie: api.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Disposition')).toMatch(/^inline/);
    await res.arrayBuffer();
  });

  it('refuses files it cannot read', async () => {
    const r = await upload(api, 'hello world', 'notes.txt', 'text/plain');
    expect(r.status).toBe(415);
  });

  it('lets a scanned document be typed in by hand', async () => {
    // A PDF with no text layer and no vision fallback in the fake provider's eyes: no marker.
    const up = await upload(api, '%PDF-1.4\n', 'scan.pdf');
    const r = await settle(up.data.document.id);
    expect(r.document.status).toBe('needs_review');
    const add = await api.post<Entry>(`/documents/${up.data.document.id}/entries`, {
      type: 'receipt',
      service_date: '2024-11-11',
      amount_cents: 2500,
    });
    expect(add.status).toBe(201);
    await api.post(`/documents/${up.data.document.id}/approve`);
    const after = await api.get<{ document: DocumentSummary }>(`/documents/${up.data.document.id}`);
    expect(after.data.document.status).toBe('processed');
  });
});
