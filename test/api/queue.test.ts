import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppState, DocumentSummary } from '../../src/shared/types';
import worker, { isTenthMinute } from '../../src/worker/index';
import {
  badReplyReason,
  describeFailure,
  MAX_ATTEMPTS,
  processDocument,
  readingCopyKey,
  STALE_MINUTES,
  sweep,
} from '../../src/worker/extract/pipeline';
import { errorKind, ProviderError, shortReason } from '../../src/worker/extract/providers';
import { storeDocument } from '../../src/worker/store';
import { fakeJpeg, fakePdf, ORIGIN, receiptExtraction, session, upload } from './helpers';

const row = (id: string) =>
  env.DB.prepare('SELECT status, attempts, next_attempt_at, error FROM documents WHERE id = ?')
    .bind(id)
    .first<{
      status: string;
      attempts: number;
      next_attempt_at: string | null;
      error: string | null;
    }>();

async function store(text: string | Uint8Array, mime = 'application/pdf') {
  const r = await storeDocument(env, {
    bytes: typeof text === 'string' ? new TextEncoder().encode(text) : text,
    filename: mime === 'application/pdf' ? 'q.pdf' : 'IMG_0001.jpg',
    mime,
    source: 'upload',
  });
  if (!r.ok) throw new Error('dup');
  return r.id;
}

const amounts = async (id: string) =>
  (
    await env.DB.prepare('SELECT amount_cents FROM entries WHERE document_id = ?')
      .bind(id)
      .all<{ amount_cents: number }>()
  ).results.map((r) => r.amount_cents);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('work queue', () => {
  it('backs off after a provider failure and gives up into review after the last attempt', async () => {
    const id = await store(`%PDF-1.7\n${'Provider outage. '.repeat(20)} FAKE_FAIL`);
    expect(await processDocument(env, id)).toBe('failed');
    let r = (await row(id))!;
    expect(r.status).toBe('failed');
    expect(r.attempts).toBe(1);
    expect(r.error).toBe('http_503');
    expect(r.next_attempt_at! > new Date().toISOString()).toBe(true);
    // Not due yet: a second call does nothing.
    expect(await processDocument(env, id)).toBe('skipped');

    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      await env.DB.prepare('UPDATE documents SET next_attempt_at = ? WHERE id = ?')
        .bind('2000-01-01T00:00:00.000Z', id)
        .run();
      await processDocument(env, id);
    }
    r = (await row(id))!;
    expect(r.attempts).toBe(MAX_ATTEMPTS);
    expect(r.status).toBe('needs_review');
  });

  it('reclaims documents stuck in processing and the sweeper picks up pending work', async () => {
    const stuck = await store(
      fakePdf(
        'Stuck $45.00',
        receiptExtraction({ appointment_date: '2024-12-01', patient_name: 'Patient' }),
      ),
    );
    await env.DB.prepare("UPDATE documents SET status = 'processing', updated_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 11 * 60_000).toISOString(), stuck)
      .run();
    const pending = await store(
      fakePdf(
        'Pending $45.00',
        receiptExtraction({ appointment_date: '2024-12-02', patient_name: 'Patient' }),
      ),
    );
    const n = await sweep(env, 10);
    expect(n).toBeGreaterThanOrEqual(2);
    // The patient is a placeholder, not a name, so both land in review (unknown patient).
    expect((await row(stuck))!.status).toBe('needs_review');
    expect((await row(pending))!.status).toBe('needs_review');
    expect((await row(stuck))!.attempts).toBe(1);
  });

  it('reclaims an abandoned read after a few minutes, not ten', async () => {
    expect(STALE_MINUTES).toBeLessThanOrEqual(3);
    const cut = await store(
      fakePdf('Cut off $45.00', receiptExtraction({ appointment_date: '2024-12-04' })),
    );
    await env.DB.prepare("UPDATE documents SET status = 'processing', updated_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - (STALE_MINUTES + 1) * 60_000).toISOString(), cut)
      .run();
    expect(await processDocument(env, cut)).not.toBe('skipped');
    expect((await row(cut))!.status).not.toBe('processing');
  });

  it('stops after the last attempt even when every read was cut off', async () => {
    const cut = await store(
      fakePdf('Cut off again $45.00', receiptExtraction({ appointment_date: '2024-12-05' })),
    );
    await env.DB.prepare(
      "UPDATE documents SET status = 'processing', attempts = ?, updated_at = ? WHERE id = ?",
    )
      .bind(MAX_ATTEMPTS, new Date(Date.now() - (STALE_MINUTES + 1) * 60_000).toISOString(), cut)
      .run();
    expect(await processDocument(env, cut)).toBe('skipped');
    await sweep(env, 5);
    const r = (await row(cut))!;
    expect(r.status).toBe('needs_review');
    expect(r.attempts).toBe(MAX_ATTEMPTS);
  });

  it('does not reclaim a document that is still being processed', async () => {
    const busy = await store(
      fakePdf('Busy $45.00', receiptExtraction({ appointment_date: '2024-12-03' })),
    );
    await env.DB.prepare("UPDATE documents SET status = 'processing', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), busy)
      .run();
    expect(await processDocument(env, busy)).toBe('skipped');
  });
});

describe('photos are read by the sweeper, not inside a request', () => {
  it('a quick read (upload, email) reads a text PDF but leaves a photo pending and due', async () => {
    const pdf = await store(
      fakePdf('Quick $45.00', receiptExtraction({ appointment_date: '2024-11-01' })),
    );
    expect(await processDocument(env, pdf, { quick: true })).not.toBe('skipped');
    expect((await row(pdf))!.status).not.toBe('pending');

    const photo = await store(
      fakeJpeg(receiptExtraction({ appointment_date: '2024-11-02', amount: '12.34' })),
      'image/jpeg',
    );
    expect(await processDocument(env, photo, { quick: true })).toBe('skipped');
    let r = (await row(photo))!;
    expect(r.status).toBe('pending');
    expect(r.attempts).toBe(0);
    // The sweeper (the cron, every minute) reads it.
    expect(await processDocument(env, photo)).not.toBe('skipped');
    r = (await row(photo))!;
    expect(['processed', 'needs_review']).toContain(r.status);
    expect(await amounts(photo)).toEqual([1234]);
  });

  it('a scanned PDF found in a quick read goes back to the queue, due now, without using an attempt', async () => {
    // Too little text for the text model: it needs the vision model.
    const scan = await store(`%PDF-1.7\nA scanned page ${Math.random()}\n`);
    expect(await processDocument(env, scan, { quick: true })).toBe('deferred');
    const r = (await row(scan))!;
    expect(r.status).toBe('pending');
    expect(r.attempts).toBe(0);
    expect(r.next_attempt_at).toBeNull();
    expect(await processDocument(env, scan)).not.toBe('skipped');
    expect((await row(scan))!.status).not.toBe('pending');
  });

  it('a model that never answers times out: retried later, or handed to the sweeper from a request', async () => {
    const slow = await store(`%PDF-1.7\n${'Slow model. '.repeat(30)} FAKE_HANG`);
    expect(await processDocument(env, slow, { quick: true, timeoutMs: 30 })).toBe('deferred');
    expect((await row(slow))!).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await processDocument(env, slow, { timeoutMs: 30 })).toBe('failed');
    expect((await row(slow))!).toMatchObject({ status: 'failed', attempts: 1, error: 'timeout' });
  });

  it('an uploaded photo waits for the cron, which reads it on any minute', async () => {
    const api = await session();
    const up = await upload(
      api,
      fakeJpeg(receiptExtraction({ appointment_date: '2024-11-04', amount: '23.45' })),
      'IMG_4821.jpg',
      'image/jpeg',
    );
    expect(up.status).toBe(201);
    const id = up.data.document.id;
    await sleep(100);
    expect((await row(id))!).toMatchObject({ status: 'pending', attempts: 0 });
    // A minute that isn't a tenth: the sweep still runs.
    const at = new Date('2026-11-24T15:43:00Z').getTime();
    expect(isTenthMinute(at)).toBe(false);
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: at, cron: '* * * * *' }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect((await row(id))!.status).not.toBe('pending');
    expect(await amounts(id)).toEqual([2345]);
  });

  it('runs the less urgent work every tenth minute only', () => {
    expect(isTenthMinute(new Date('2026-11-24T15:40:00Z').getTime())).toBe(true);
    expect(isTenthMinute(new Date('2026-11-24T15:40:59Z').getTime())).toBe(true);
    expect(isTenthMinute(new Date('2026-11-24T15:41:00Z').getTime())).toBe(false);
  });
});

describe('reading copies', () => {
  async function postCopy(cookie: string, id: string, bytes: Uint8Array, type = 'image/jpeg') {
    return SELF.fetch(`${ORIGIN}/api/documents/${id}/reading-copy`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': type },
      body: bytes,
    });
  }

  it('reads a photo from its smaller copy and keeps the original untouched', async () => {
    const api = await session();
    const original = fakeJpeg(
      receiptExtraction({ appointment_date: '2024-11-05', amount: '99.99' }),
    );
    const up = await upload(api, original, 'IMG_5000.jpg', 'image/jpeg');
    const id = up.data.document.id;
    const copy = fakeJpeg(receiptExtraction({ appointment_date: '2024-11-05', amount: '31.50' }));
    expect((await postCopy(api.cookie, id, copy)).status).toBe(200);
    expect(await env.FILES.head(readingCopyKey(id))).not.toBeNull();

    await sweep(env, 20);
    expect(await amounts(id)).toEqual([3150]);
    // The original is what the app serves.
    const file = await SELF.fetch(`${ORIGIN}/api/files/${id}`, { headers: { Cookie: api.cookie } });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(original);

    // Discarding removes the copy along with the original.
    expect((await api.post(`/documents/${id}/discard`)).status).toBe(200);
    expect(await env.FILES.head(readingCopyKey(id))).toBeNull();
  });

  it('a copy sent for a photo waiting on a retry makes it due now', async () => {
    const api = await session();
    const up = await upload(
      api,
      fakeJpeg(receiptExtraction({ appointment_date: '2024-11-08', amount: '12.00' })),
      'IMG_5002.jpg',
      'image/jpeg',
    );
    const id = up.data.document.id;
    // As if its first read had been cut off and failed: retry not due for another 8 minutes.
    const later = new Date(Date.now() + 8 * 60_000).toISOString();
    await env.DB.prepare(
      "UPDATE documents SET status = 'failed', attempts = 1, next_attempt_at = ? WHERE id = ?",
    )
      .bind(later, id)
      .run();
    const copy = fakeJpeg(receiptExtraction({ appointment_date: '2024-11-08', amount: '12.00' }));
    expect((await postCopy(api.cookie, id, copy)).status).toBe(200);
    expect((await row(id))!.next_attempt_at).toBeNull();
    await sweep(env, 20);
    expect(await amounts(id)).toEqual([1200]);
  });

  it('takes only a JPEG, only for a photo, and only from this origin', async () => {
    const api = await session();
    const up = await upload(
      api,
      fakeJpeg(receiptExtraction({ appointment_date: '2024-11-06' })),
      'IMG_5001.jpg',
      'image/jpeg',
    );
    const id = up.data.document.id;
    expect((await postCopy(api.cookie, id, new TextEncoder().encode('not a jpeg'))).status).toBe(
      415,
    );
    const noOrigin = await SELF.fetch(`${ORIGIN}/api/documents/${id}/reading-copy`, {
      method: 'POST',
      headers: { Cookie: api.cookie, 'Content-Type': 'image/jpeg' },
      body: fakeJpeg({}),
    });
    expect(noOrigin.status).toBe(403);
    const pdf = await upload(
      api,
      fakePdf('Copy $45.00', receiptExtraction({ appointment_date: '2024-11-07' })),
      'copy.pdf',
    );
    expect((await postCopy(api.cookie, pdf.data.document.id, fakeJpeg({}))).status).toBe(400);
  });
});

describe('what the app shows while reading', () => {
  it('a document still being read can be deleted, and is then never read', async () => {
    const api = await session();
    const up = await upload(
      api,
      fakeJpeg(receiptExtraction({ appointment_date: '2024-11-09', amount: '8.00' })),
      'IMG_5003.jpg',
      'image/jpeg',
    );
    const id = up.data.document.id;
    expect((await row(id))!.status).toBe('pending');
    expect((await api.post(`/documents/${id}/discard`)).status).toBe(200);
    const list = await api.get<{ documents: { id: string }[] }>('/documents?status=in_flight');
    expect(list.data.documents.map((d) => d.id)).not.toContain(id);
    await sweep(env, 20);
    expect((await row(id))!.status).toBe('discarded');
    expect(await amounts(id)).toEqual([]);
  });

  it('counts failed-and-retrying documents as in flight, and lists them with their retry time', async () => {
    const api = await session();
    const id = await store(`%PDF-1.7\n${'Provider outage again. '.repeat(20)} FAKE_FAIL`);
    expect(await processDocument(env, id)).toBe('failed');
    const state = await api.get<AppState>('/state');
    const list = await api.get<{ documents: DocumentSummary[] }>('/documents?status=in_flight');
    const doc = list.data.documents.find((d) => d.id === id)!;
    expect(doc.status).toBe('failed');
    expect(doc.next_attempt_at! > new Date().toISOString()).toBe(true);
    // The count and the Ledger's rows agree.
    expect(state.data.counts.in_flight).toBe(list.data.documents.length);
  });

  it('says which photos being read have a reading copy', async () => {
    const api = await session();
    const old = await store(fakeJpeg(receiptExtraction({ amount: '7.00' })), 'image/jpeg');
    const withCopy = await store(fakeJpeg(receiptExtraction({ amount: '8.00' })), 'image/jpeg');
    await env.FILES.put(readingCopyKey(withCopy), fakeJpeg(receiptExtraction({ amount: '8.00' })));
    const pdf = await store(`%PDF-1.7\n${'Still reading. '.repeat(20)} FAKE_FAIL`);
    const list = await api.get<{ documents: DocumentSummary[] }>('/documents?status=in_flight');
    const of = (id: string) => list.data.documents.find((d) => d.id === id)!;
    expect(of(old).has_reading_copy).toBe(false);
    expect(of(withCopy).has_reading_copy).toBe(true);
    expect(of(pdf).has_reading_copy).toBe(false);
    // Only the in-flight list carries it.
    const all = await api.get<{ documents: DocumentSummary[] }>('/documents');
    expect(all.data.documents.find((d) => d.id === old)!.has_reading_copy).toBeUndefined();
    // A copy sent while the original is mid-read doesn't start a second read of it.
    await env.DB.prepare("UPDATE documents SET status = 'processing', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), old)
      .run();
    const res = await SELF.fetch(`${ORIGIN}/api/documents/${old}/reading-copy`, {
      method: 'POST',
      headers: { Cookie: api.cookie, Origin: ORIGIN, 'Content-Type': 'image/jpeg' },
      body: fakeJpeg(receiptExtraction({ amount: '7.00' })),
    });
    expect(res.status).toBe(200);
    expect(await processDocument(env, old)).toBe('skipped');
    expect((await row(old))!.status).toBe('processing');
  });
});

describe('why a read failed', () => {
  it('stores the reason a reply couldn’t be used, without its contents', async () => {
    const id = await store(
      `%PDF-1.7\n${'Secret words here. '.repeat(20)}\nFAKE_EXTRACTION: Secret reply`,
    );
    expect(await processDocument(env, id)).toBe('failed');
    const r = (await row(id))!;
    expect(r.error).toBe('bad_reply: no JSON in the reply');
  });

  it('describes provider failures in a few content-free words', () => {
    expect(describeFailure(new ProviderError('http_529', true, 'overloaded_error'))).toBe(
      'http_529: overloaded_error',
    );
    expect(describeFailure(new ProviderError('timeout', true))).toBe('timeout');
    expect(errorKind({ error: { type: 'overloaded_error', message: 'the receipt says…' } })).toBe(
      'overloaded_error',
    );
    expect(errorKind({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } })).toBe('429');
    expect(errorKind({ nothing: true })).toBeUndefined();
    const ai = new Error('3040: Capacity temporarily exceeded, please try again.');
    ai.name = 'AiError';
    expect(shortReason(ai)).toBe('AiError: 3040: Capacity temporarily exceeded, please try again.');
    expect(shortReason(new Error('Bad input "Dr. Smith $45"\nmore'))).toBe('Bad input …');
    expect(describeFailure(new Error(''))).toBe('Error');
    expect(badReplyReason(new SyntaxError('Unexpected token D in "Dr. Smith"'))).toBe(
      'not valid JSON',
    );
    expect(
      badReplyReason({ issues: [{ path: ['line_items', 0, 'amount'], code: 'invalid_type' }] }),
    ).toBe('didn’t fit the form (line_items.0.amount invalid_type)');
  });
});
