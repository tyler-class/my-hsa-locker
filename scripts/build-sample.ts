// Builds seed/sample.json: a clearly synthetic household (the Example family) with ~25 entries
// across two years, one EOB, a reimbursement and a few entries waiting for review.
// No real people, providers or amounts. Run: npm run sample:build
import { writeFileSync } from 'node:fs';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type ExportRow,
  type HsaExport,
} from '../src/shared/exportFormat';

const T = '2026-01-01T00:00:00.000Z';
let seq = 0;
const id = (p: string) => `sample-${p}-${String(++seq).padStart(3, '0')}`;

const people: ExportRow[] = [
  ['Sam Example', 'Self', 'blue'],
  ['Alex Example', 'Spouse', 'violet'],
  ['Mia Example', 'Child', 'green'],
  ['Leo Example', 'Child', 'amber'],
].map(([name, rel, color], i) => ({
  id: `sample-person-${i + 1}`,
  name: name!,
  relationship: rel!,
  aliases_json: JSON.stringify([name!.split(' ')[0]]),
  color: color!,
  sort_order: i,
  created_at: T,
  updated_at: T,
}));
const P = Object.fromEntries(people.map((p) => [String(p.name).split(' ')[0]!, String(p.id)]));

const providerNames = [
  'Sample Family Medicine',
  'Example Physical Therapy',
  'Placeholder Dental Group',
  'Demo Vision Center',
  'Test Pharmacy',
  'Fictional Imaging Associates',
];
const providers: ExportRow[] = providerNames.map((name, i) => ({
  id: `sample-provider-${i + 1}`,
  name,
  aliases_json:
    name === 'Example Physical Therapy' ? JSON.stringify(['Example Physical Ther']) : '[]',
  created_at: T,
  updated_at: T,
}));
const V = (name: string) => String(providers.find((p) => p.name === name)!.id);
const C = (name: string) => `cat-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const documents: ExportRow[] = [];
const entries: ExportRow[] = [];
const reimbursements: ExportRow[] = [
  {
    id: 'sample-reimb-1',
    date: '2025-12-15',
    note: 'Year-end HSA withdrawal (sample)',
    created_at: T,
  },
];

function doc(kind: 'receipt' | 'eob', date: string, status = 'processed', reasons: string[] = []) {
  const docId = id('doc');
  documents.push({
    id: docId,
    kind,
    status,
    source: 'upload',
    source_meta_json: '{}',
    inbox_log_id: null,
    file_key: `sample/${docId}.txt`,
    eml_key: null,
    filename: `sample-${kind}-${date}.txt`,
    mime: 'text/plain',
    size_bytes: 120,
    sha256: `sample${String(seq).padStart(58, '0')}`,
    legacy_md5: null,
    text_layer_chars: 120,
    extraction_json: null,
    extraction_model: 'sample',
    extraction_provider: 'sample',
    review_reasons_json: JSON.stringify(reasons),
    error: null,
    attempts: 1,
    next_attempt_at: null,
    received_at: `${date}T15:00:00.000Z`,
    processed_at: `${date}T15:01:00.000Z`,
    created_at: `${date}T15:00:00.000Z`,
    updated_at: `${date}T15:01:00.000Z`,
  });
  return docId;
}

function receipt(
  date: string,
  who: string,
  provider: string,
  cat: string,
  cents: number,
  extra: Partial<ExportRow> = {},
) {
  const reasons = JSON.parse(String(extra.review_reasons_json ?? '[]')) as string[];
  const d = doc('receipt', date, reasons.length ? 'needs_review' : 'processed');
  entries.push({
    id: id('entry'),
    document_id: d,
    type: 'receipt',
    service_date: date,
    payment_date: date,
    person_id: P[who]!,
    patient_name_raw: `${who} Example`,
    provider_id: V(provider),
    provider_name_raw: provider,
    description: `${cat} visit (sample)`,
    category_id: C(cat),
    amount_cents: cents,
    card_last4: '1111',
    billed_cents: null,
    allowed_cents: null,
    plan_paid_cents: null,
    patient_resp_cents: null,
    notes: null,
    confidence: 0.95,
    source_quote: null,
    review_reasons_json: '[]',
    reviewed_at: null,
    excluded_reason: null,
    excluded_auto: 0,
    reimbursement_id: null,
    dup_of_entry_id: null,
    sort_order: 0,
    created_at: `${date}T15:01:00.000Z`,
    updated_at: `${date}T15:01:00.000Z`,
    ...extra,
  });
}

// 2025: mostly reimbursed at year end.
receipt('2025-01-14', 'Sam', 'Sample Family Medicine', 'Doctor', 4000, {
  reimbursement_id: 'sample-reimb-1',
});
receipt('2025-02-03', 'Mia', 'Placeholder Dental Group', 'Dental', 12500, {
  reimbursement_id: 'sample-reimb-1',
});
receipt('2025-03-11', 'Alex', 'Example Physical Therapy', 'Physical Therapy', 3500, {
  reimbursement_id: 'sample-reimb-1',
});
receipt('2025-03-18', 'Alex', 'Example Physical Therapy', 'Physical Therapy', 3500, {
  reimbursement_id: 'sample-reimb-1',
});
receipt('2025-03-25', 'Alex', 'Example Physical Therapy', 'Physical Therapy', 3500, {
  reimbursement_id: 'sample-reimb-1',
});
receipt('2025-05-07', 'Leo', 'Test Pharmacy', 'Prescription', 1299, {
  reimbursement_id: 'sample-reimb-1',
});
receipt('2025-06-20', 'Sam', 'Demo Vision Center', 'Vision', 22000, {
  card_last4: '4242',
  excluded_reason: 'paid_with_hsa',
  excluded_auto: 1,
});
receipt('2025-08-02', 'Mia', 'Sample Family Medicine', 'Doctor', 4000, {
  reimbursement_id: 'sample-reimb-1',
});
receipt('2025-09-15', 'Leo', 'Fictional Imaging Associates', 'Imaging', 18050);
receipt('2025-11-04', 'Alex', 'Test Pharmacy', 'Prescription', 899);

// One EOB with several lines (reference only: no amounts count).
const eob = doc('eob', '2025-04-10');
[
  ['2025-03-11', 'THERAPEUTIC EXERCISE 97110'],
  ['2025-03-11', 'NEUROMUSCULAR REEDUCATION 97112'],
  ['2025-03-18', 'THERAPEUTIC EXERCISE 97110'],
  ['2025-03-25', 'MANUAL THERAPY 97140'],
].forEach(([date, desc], i) =>
  entries.push({
    id: id('entry'),
    document_id: eob,
    type: 'eob',
    service_date: date!,
    payment_date: null,
    person_id: P.Alex!,
    patient_name_raw: 'Example, Alex',
    provider_id: V('Example Physical Therapy'),
    provider_name_raw: 'Example Physical Ther',
    description: desc!,
    category_id: C('Physical Therapy'),
    amount_cents: null,
    card_last4: null,
    billed_cents: 15000,
    allowed_cents: 9000,
    plan_paid_cents: 5500,
    patient_resp_cents: 3500,
    notes: null,
    confidence: 0.9,
    source_quote: null,
    review_reasons_json: '[]',
    reviewed_at: null,
    excluded_reason: null,
    excluded_auto: 0,
    reimbursement_id: null,
    dup_of_entry_id: null,
    sort_order: i,
    created_at: '2025-04-10T15:01:00.000Z',
    updated_at: '2025-04-10T15:01:00.000Z',
  }),
);

// 2026: outstanding, plus a few waiting for review.
receipt('2026-01-09', 'Sam', 'Sample Family Medicine', 'Doctor', 4000);
receipt('2026-02-12', 'Mia', 'Placeholder Dental Group', 'Dental', 9500);
receipt('2026-03-03', 'Leo', 'Sample Family Medicine', 'Urgent Care', 7500);
receipt('2026-04-21', 'Alex', 'Demo Vision Center', 'Vision', 15900);
receipt('2026-05-30', 'Sam', 'Test Pharmacy', 'Prescription', 1550);
receipt('2026-07-08', 'Mia', 'Example Physical Therapy', 'Physical Therapy', 3500);
receipt('2026-08-19', 'Leo', 'Placeholder Dental Group', 'Dental', 6000, {
  person_id: null,
  patient_name_raw: 'Leonardo Example',
  review_reasons_json: JSON.stringify(['unknown_patient']),
});
receipt('2026-09-02', 'Alex', 'Fictional Imaging Associates', 'Imaging', 31275, {
  review_reasons_json: JSON.stringify(['amount_not_in_source']),
  confidence: 0.55,
});
receipt('2026-09-02', 'Alex', 'Test Pharmacy', 'Prescription', 1200, {
  review_reasons_json: JSON.stringify(['low_confidence']),
  confidence: 0.4,
});

const data: HsaExport = {
  format: EXPORT_FORMAT,
  version: EXPORT_VERSION,
  exported_at: T,
  tables: {
    settings: [
      { key: 'family_names_json', value: JSON.stringify(['Example']) },
      { key: 'hsa_card_last4_json', value: JSON.stringify(['4242']) },
      { key: 'onboarded', value: '1' },
    ],
    people,
    providers,
    documents,
    reimbursements,
    entries,
  },
};

writeFileSync(
  new URL('../seed/sample.json', import.meta.url),
  JSON.stringify(data, null, 2) + '\n',
);
console.log(`seed/sample.json: ${entries.length} entries, ${documents.length} documents`);
