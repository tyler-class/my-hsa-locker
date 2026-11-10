import { describe, expect, it } from 'vitest';
import {
  draftMapping,
  importReasons,
  planDocuments,
  readLegacyCsv,
} from '../../src/shared/legacyImport';

// Synthetic rows in HSA Wizard's column order. No real people or providers.
const CSV = [
  'Document Type,Flag for Review,Appointment Date,Payment Date,Patient Name,Provider Name,Description of Services,Category,Amount,Payment Card Last 4 Digits,Link to Drive Document,Drive File ID,Drive File Name,Additional Notes,Last Processed Date,Content Hash',
  'Receipt,FALSE,2024-03-05,2024-03-05,Sam Example,Lakeside Physical Therapy,Visit,Physical Therapy,45.00,1234,https://drive/x,F1,[LOGGED] Receipt_2024-03-05_Sam.pdf,,2024-03-06,aaa',
  'EOB,FALSE,2024-03-05,,"Example, Alex",Lakeside Physical Ther,NEUROMUSCULAR REEDUCATION 97112,Physical Therapy,,,https://drive/y,F2,[LOGGED] EOB_2024.pdf,,2024-04-01,bbb',
  'EOB,FALSE,2024-03-05,,"Example, Alex",Lakeside Physical Ther,NEUROMUSCULAR REEDUCATION 97112,Physical Therapy,,,https://drive/y,F2,[LOGGED] EOB_2024.pdf,,2024-04-01,bbb',
  'EOB,TRUE,2024-03-12,,Alex,Lakeside Physical Ther,THERAPEUTIC EXERCISE 97110,Physical Therapy,,,https://drive/y,F2,[LOGGED] EOB_2024.pdf,,2024-04-01,bbb',
  'Receipt,TRUE,3/9/2024,,Alex Example,Downtown Dental,Cleaning,Dental,$1O.00,,https://drive/z,F3,Receipt_dental.pdf,check this,2024-03-10,ccc',
].join('\n');

describe('HSA Wizard import', () => {
  const rows = readLegacyCsv(CSV);

  it('reads the legacy columns', () => {
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      type: 'receipt',
      amount_cents: 4500,
      card_last4: '1234',
      file_name: 'Receipt_2024-03-05_Sam.pdf',
      md5: 'aaa',
    });
    expect(rows[1]).toMatchObject({ type: 'eob', amount_cents: null, payment_date: null });
    expect(rows[4]).toMatchObject({
      service_date: '2024-03-09',
      flagged: true,
      amount_cents: null,
      amount_raw: '$1O.00',
    });
  });

  it('drafts a mapping that collapses name variants and truncated providers', () => {
    const m = draftMapping(rows, ['Example']);
    expect(m.people['Example, Alex']).toBe('Alex Example');
    expect(m.people['Alex']).toBe('Alex Example');
    expect(m.people['Sam Example']).toBe('Sam Example');
    expect(m.providers['Lakeside Physical Ther']).toBe('Lakeside Physical Therapy');
    expect(m.providers['Downtown Dental']).toBe('Downtown Dental');
  });

  it('makes one document per Drive file and collapses identical rows', () => {
    const plan = planDocuments(rows, draftMapping(rows, ['Example']));
    expect(plan).toHaveLength(3);
    const eob = plan.find((d) => d.file_id === 'F2')!;
    expect(eob.kind).toBe('eob');
    expect(eob.rows).toHaveLength(2);
    expect(eob.collapsed).toBe(1);
  });

  it('keeps the legacy flag and catches bad amounts', () => {
    expect(importReasons(rows[3]!, true)).toEqual(['legacy_flagged']);
    expect(importReasons(rows[4]!, true)).toEqual(['legacy_flagged', 'bad_amount']);
    expect(importReasons(rows[0]!, false)).toEqual(['unknown_patient']);
  });

  it('refuses a CSV that is not the log tab', () => {
    expect(() => readLegacyCsv('Year,Receipts\n2024,3')).toThrow(/HSA Wizard/);
  });
});
