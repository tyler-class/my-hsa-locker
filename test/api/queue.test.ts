import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, processDocument, sweep } from '../../src/worker/extract/pipeline';
import { storeDocument } from '../../src/worker/store';
import { fakePdf, receiptExtraction } from './helpers';

const row = (id: string) =>
  env.DB.prepare('SELECT status, attempts, next_attempt_at, error FROM documents WHERE id = ?')
    .bind(id)
    .first<{
      status: string;
      attempts: number;
      next_attempt_at: string | null;
      error: string | null;
    }>();

async function store(text: string) {
  const r = await storeDocument(env, {
    bytes: new TextEncoder().encode(text),
    filename: 'q.pdf',
    mime: 'application/pdf',
    source: 'upload',
  });
  if (!r.ok) throw new Error('dup');
  return r.id;
}

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
