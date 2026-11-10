import { describe, expect, it } from 'vitest';
import {
  csvCell,
  detectVerification,
  exportFilename,
  keepPart,
  ledgerCsv,
  parseCsv,
  sniffMime,
  stripLegacyPrefixes,
  uniqueNames,
} from '../../src/shared/logic';
import { draftsFrom, extractionSchema, parseModelJson } from '../../src/shared/extraction';

describe('forwarding verification', () => {
  it('recognizes Gmail and pulls the code and link', () => {
    const hit = detectVerification({
      from: 'forwarding-noreply@google.com',
      subject: '(#123456789) Gmail Forwarding Confirmation - Receive Mail from sam@example.com',
      text: 'Confirmation code: 123456789\nTo allow, click https://mail-settings.google.com/mail/vf-%5BABC%5D-xyz\n',
    });
    expect(hit).toEqual({
      provider: 'Gmail',
      code: '123456789',
      link: 'https://mail-settings.google.com/mail/vf-%5BABC%5D-xyz',
    });
    expect(
      detectVerification({
        from: 'mail-noreply@google.com',
        subject: 'Gmail Forwarding Confirmation',
      })?.provider,
    ).toBe('Gmail');
  });
  it('ignores ordinary mail, even from Google', () => {
    expect(
      detectVerification({ from: 'billing@clinic.example', subject: 'Your receipt' }),
    ).toBeNull();
    expect(
      detectVerification({ from: 'no-reply@google.com', subject: 'Security alert' }),
    ).toBeNull();
  });
});

describe('email parts', () => {
  const opts = { minBytes: 25 * 1024, referencedCids: new Set(['logo1']) };
  it('keeps PDFs whatever their size, and big enough images', () => {
    expect(
      keepPart(
        { filename: 'r.pdf', mimeType: 'application/pdf', disposition: 'attachment', size: 900 },
        opts,
      ).keep,
    ).toBe(true);
    expect(
      keepPart(
        { filename: 'IMG_1.jpg', mimeType: 'image/jpeg', disposition: 'attachment', size: 300_000 },
        opts,
      ).keep,
    ).toBe(true);
  });
  it('skips small images, referenced inline images, logos and unreadable types', () => {
    expect(
      keepPart(
        { filename: 'a.png', mimeType: 'image/png', disposition: 'attachment', size: 2000 },
        opts,
      ),
    ).toEqual({ keep: false, reason: 'too_small' });
    expect(
      keepPart(
        {
          filename: 'x.png',
          mimeType: 'image/png',
          disposition: 'inline',
          contentId: '<logo1>',
          size: 90_000,
        },
        opts,
      ).reason,
    ).toBe('inline_image');
    expect(
      keepPart(
        {
          filename: 'company-logo.png',
          mimeType: 'image/png',
          disposition: 'attachment',
          size: 90_000,
        },
        opts,
      ).reason,
    ).toBe('logo');
    expect(
      keepPart(
        {
          filename: 'a.docx',
          mimeType: 'application/msword',
          disposition: 'attachment',
          size: 90_000,
        },
        opts,
      ).reason,
    ).toBe('unsupported_type');
  });
  it('sniffs real types', () => {
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7 ...'))).toBe('application/pdf');
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(new TextEncoder().encode('<html>'))).toBeNull();
  });
});

describe('file names', () => {
  it('strips HSA Wizard prefixes', () => {
    expect(stripLegacyPrefixes('[LOGGED] [DUPE SET 3] Receipt_2024.pdf')).toBe('Receipt_2024.pdf');
    expect(stripLegacyPrefixes('[LOGGED] [ORIG. DUPE SET 12] a.pdf')).toBe('a.pdf');
    expect(stripLegacyPrefixes('plain.pdf')).toBe('plain.pdf');
  });
  it('builds export names and keeps them unique', () => {
    expect(
      exportFilename({
        date: '2024-03-05',
        person: 'Sam Example',
        provider: 'Lakeside P.T.',
        amount_cents: 12500,
        ext: 'pdf',
      }),
    ).toBe('2024-03-05_Sam-Example_Lakeside-P-T_125.00.pdf');
    expect(uniqueNames(['a.pdf', 'A.pdf', 'b.pdf', 'a.pdf'])).toEqual([
      'a.pdf',
      'A (2).pdf',
      'b.pdf',
      'a (3).pdf',
    ]);
  });
});

describe('csv', () => {
  it('escapes and defuses formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-12.00')).toBe('-12.00');
  });
  it('round-trips through the parser', () => {
    const csv = ledgerCsv([
      {
        type: 'receipt',
        flagged: false,
        service_date: '2024-01-02',
        payment_date: null,
        person: 'Sam',
        provider: 'Clinic, "North"',
        description: 'Visit\nline 2',
        category: 'Doctor',
        amount_cents: 4500,
        card_last4: '4242',
        status: 'outstanding',
        excluded_reason: null,
        reimbursement_date: null,
        filename: 'a.pdf',
        notes: null,
        processed_at: '2024-01-03T00:00:00Z',
        billed_cents: null,
        allowed_cents: null,
        plan_paid_cents: null,
        patient_resp_cents: null,
        id: 'e1',
        document_id: 'd1',
      },
    ]);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[1]![5]).toBe('Clinic, "North"');
    expect(rows[1]![6]).toBe('Visit\nline 2');
    expect(rows[1]![8]).toBe('45.00');
  });
});

describe('extraction output', () => {
  it('tolerates fences and chatter', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Here you go: {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(() => parseModelJson('nope')).toThrow();
  });
  it('follows the legacy rules: EOB lines carry no paid amount, Unknown has no entries', () => {
    const eob = extractionSchema.parse({
      document_type: 'EOB',
      line_items: [
        {
          appointment_date: '2024-02-01',
          patient_name: 'Sam',
          amount: '50.00',
          card_last4: '4242',
          billed: '$200.00',
          payment_date: '2024-02-05',
        },
      ],
    });
    const { kind, drafts } = draftsFrom(eob);
    expect(kind).toBe('eob');
    expect(drafts[0]).toMatchObject({
      type: 'eob',
      amount_cents: null,
      card_last4: null,
      payment_date: null,
      billed_cents: 20000,
    });
    expect(
      draftsFrom(extractionSchema.parse({ document_type: 'Unknown', line_items: [{}] })).drafts,
    ).toEqual([]);
  });
  it('marks amounts and dates it could not parse', () => {
    const r = draftsFrom(
      extractionSchema.parse({
        document_type: 'Receipt',
        line_items: [
          { amount: 'about forty', appointment_date: 'last Tuesday', card_last4: 'xx4242' },
        ],
      }),
    ).drafts[0]!;
    expect(r.amount_unparsed).toBe(true);
    expect(r.date_unparsed).toBe(true);
    expect(r.card_last4).toBe('4242');
  });
});
