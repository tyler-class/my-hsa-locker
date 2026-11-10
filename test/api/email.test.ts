import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../../src/worker/index';
import { processDocument } from '../../src/worker/extract/pipeline';
import { fakePdf, receiptExtraction, session, type Api } from './helpers';

let api: Api;
let address: string;

function b64(s: string) {
  return btoa(s).replace(/(.{76})/g, '$1\r\n');
}

function mime(opts: {
  to: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  parts?: { name: string; type: string; body: string; inline?: boolean; cid?: string }[];
  forwarded?: string;
}): string {
  const boundary = 'BOUNDARY42';
  const lines = [
    `From: ${opts.from ?? 'billing@clinic.example'}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject ?? 'Your receipt'}`,
    'Message-ID: <test@example>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
  ];
  const add = (headers: string[], body: string) =>
    lines.push(`--${boundary}`, ...headers, '', body);
  if (opts.html) add(['Content-Type: text/html; charset=utf-8'], opts.html);
  else add(['Content-Type: text/plain; charset=utf-8'], opts.text ?? 'See attached.');
  for (const p of opts.parts ?? [])
    add(
      [
        `Content-Type: ${p.type}; name="${p.name}"`,
        `Content-Disposition: ${p.inline ? 'inline' : 'attachment'}; filename="${p.name}"`,
        'Content-Transfer-Encoding: base64',
        ...(p.cid ? [`Content-ID: <${p.cid}>`] : []),
      ],
      b64(p.body),
    );
  if (opts.forwarded)
    add(
      ['Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="fwd.eml"'],
      opts.forwarded,
    );
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

async function deliver(raw: string, to = address, from = 'billing@clinic.example') {
  const bytes = new TextEncoder().encode(raw);
  let rejected: string | null = null;
  const message = {
    from,
    to,
    headers: new Headers({ subject: /Subject: (.*)/.exec(raw)?.[1] ?? '' }),
    raw: new Blob([bytes]).stream(),
    rawSize: bytes.byteLength,
    setReject: (r: string) => (rejected = r),
  };
  const ctx = createExecutionContext();
  await worker.email(message as never, env, ctx);
  await waitOnExecutionContext(ctx);
  return { rejected };
}

async function lastLog() {
  const r = await api.get<{
    log: {
      outcome: string;
      reason: string | null;
      document_count: number;
      attachment_count: number;
    }[];
  }>('/inbox');
  return r.data.log[0]!;
}

beforeAll(async () => {
  api = await session();
  await api.post('/people', { name: 'Sam Example' });
  const s = await api.patch<{ inbox_address: string }>('/settings', {
    inbox_domain: 'hsa-in.example.com',
  });
  address = s.data.inbox_address;
});

describe('email intake', () => {
  it('rejects unknown recipients without storing anything', async () => {
    const r = await deliver(
      mime({ to: 'receipts@hsa-in.example.com' }),
      'receipts@hsa-in.example.com',
    );
    expect(r.rejected).toBe('unknown recipient');
    expect((await lastLog()).outcome).toBe('rejected');
  });

  it('turns a PDF attachment into a processed document and keeps the .eml', async () => {
    const pdf = fakePdf('Paid $45.00', receiptExtraction({ appointment_date: '2024-02-02' }));
    const r = await deliver(
      mime({ to: address, parts: [{ name: 'receipt.pdf', type: 'application/pdf', body: pdf }] }),
    );
    expect(r.rejected).toBeNull();
    const log = await lastLog();
    expect(log.outcome).toBe('accepted');
    expect(log.document_count).toBe(1);
    const docs = (
      await api.get<{
        documents: { id: string; status: string; has_eml: boolean; source: string }[];
      }>('/documents')
    ).data.documents;
    const d = docs.find((x) => x.source === 'email')!;
    expect(d.has_eml).toBe(true);
    await processDocument(env, d.id);
    const after = (await api.get<{ document: { status: string } }>(`/documents/${d.id}`)).data
      .document;
    expect(after.status).toBe('processed');
    // The kept email reads back for the app's email view.
    const view = (
      await api.get<{
        from: string;
        subject: string;
        text: string;
        attachments: { filename: string }[];
      }>(`/documents/${d.id}/email`)
    ).data;
    expect(view.from).toContain('billing@clinic.example');
    expect(view.subject).toBe('Your receipt');
    expect(view.text).toContain('See attached.');
    expect(view.attachments.map((a) => a.filename)).toEqual(['receipt.pdf']);
  });

  it('skips inline logos and tiny images, keeps real photos', async () => {
    const big = 'x'.repeat(40 * 1024);
    await deliver(
      mime({
        to: address,
        html: '<p>Receipt</p><img src="cid:logo1">',
        parts: [
          {
            name: 'logo.png',
            type: 'image/png',
            body: '\x89PNG' + big,
            inline: true,
            cid: 'logo1',
          },
          { name: 'tiny.png', type: 'image/png', body: '\x89PNG small' },
          {
            name: 'photo.jpg',
            type: 'image/jpeg',
            body: '\xff\xd8\xff' + big + 'FAKE_EXTRACTION:{}',
          },
        ],
      }),
    );
    const log = await lastLog();
    expect(log.attachment_count).toBe(3);
    expect(log.document_count).toBe(1);
  });

  it('descends into forwarded-as-attachment messages', async () => {
    const inner = mime({
      to: 'someone@else.example',
      parts: [
        {
          name: 'inner.pdf',
          type: 'application/pdf',
          body: fakePdf(
            'Inner $12.00',
            receiptExtraction({ amount: '12.00', appointment_date: '2024-03-03' }),
          ),
        },
      ],
    });
    await deliver(mime({ to: address, subject: 'Fwd: receipt', forwarded: inner }));
    expect((await lastLog()).document_count).toBe(1);
  });

  it('reads body-only receipts as documents', async () => {
    await deliver(
      mime({
        to: address,
        subject: 'Your order',
        html: '<table><tr><td>Prescription</td><td>$15.50</td></tr></table><p>Thank you for your order from Test Pharmacy.</p>',
      }),
    );
    const log = await lastLog();
    expect(log.outcome).toBe('accepted');
    expect(log.document_count).toBe(1);
  });

  it('surfaces Gmail forwarding confirmations instead of processing them', async () => {
    await deliver(
      mime({
        to: address,
        from: 'forwarding-noreply@google.com',
        subject: '(#987654321) Gmail Forwarding Confirmation - Receive Mail from sam@example.com',
        text: 'Confirmation code: 987654321\nhttps://mail-settings.google.com/mail/vf-abc123',
      }),
      address,
      'forwarding-noreply@google.com',
    );
    const r = await api.get<{
      verifications: { code: string; provider: string; link: string; id: string }[];
    }>('/inbox');
    expect(r.data.verifications[0]).toMatchObject({ provider: 'Gmail', code: '987654321' });
    expect((await lastLog()).outcome).toBe('verification');
    await api.post(`/inbox/verifications/${r.data.verifications[0]!.id}/dismiss`);
    expect((await api.get<{ verifications: unknown[] }>('/inbox')).data.verifications).toHaveLength(
      0,
    );
  });

  it('rejects oversize mail, honours the pause switch, and rotates the address', async () => {
    await api.patch('/settings', { inbox_max_mb: 1 });
    const huge = mime({ to: address, text: 'x'.repeat(1_100_000) });
    expect((await deliver(huge)).rejected).toBe('message too large');
    await api.patch('/settings', { inbox_max_mb: 20, inbox_paused: true });
    expect((await deliver(mime({ to: address }))).rejected).toBe('mailbox unavailable');
    await api.patch('/settings', { inbox_paused: false });

    const old = address;
    const r = await api.post<{ address: string }>('/inbox/rotate');
    address = r.data.address;
    expect(address).not.toBe(old);
    expect(address).toMatch(/^hsa-[a-z2-7]{10}@hsa-in\.example\.com$/);
    expect((await deliver(mime({ to: old }), old)).rejected).toBe('unknown recipient');
  });

  it('accepts a chosen address name instead of the random one', async () => {
    const random = address;
    const s = await api.patch<{ inbox_address: string }>('/settings', { inbox_local: 'Receipts' });
    expect(s.data.inbox_address).toBe('receipts@hsa-in.example.com');
    expect(
      (await deliver(mime({ to: s.data.inbox_address }), s.data.inbox_address)).rejected,
    ).toBeNull();
    expect((await deliver(mime({ to: random }), random)).rejected).toBe('unknown recipient');
    expect((await api.patch('/settings', { inbox_local: 'no spaces' })).status).toBe(400);
    expect((await api.patch('/settings', { inbox_local: 'a@b' })).status).toBe(400);
  });
});
