// Ledger CSV. Columns follow HSA Wizard's "📄 HSA Document Log" where they still make sense,
// so the file opens the same way in a spreadsheet.
import { centsToDecimal } from './money';

export const LEDGER_CSV_COLUMNS = [
  'Document Type',
  'Flag for Review',
  'Appointment Date',
  'Payment Date',
  'Patient Name',
  'Provider Name',
  'Description of Services',
  'Category',
  'Amount',
  'Payment Card Last 4 Digits',
  'Status',
  'Excluded Reason',
  'Reimbursement Date',
  'File Name',
  'Additional Notes',
  'Processed Date',
  'Billed',
  'Allowed',
  'Plan Paid',
  'Patient Responsibility',
  'Entry ID',
  'Document ID',
] as const;

export interface CsvRow {
  type: 'receipt' | 'eob';
  flagged: boolean;
  service_date: string | null;
  payment_date: string | null;
  person: string | null;
  provider: string | null;
  description: string | null;
  category: string | null;
  amount_cents: number | null;
  card_last4: string | null;
  status: string;
  excluded_reason: string | null;
  reimbursement_date: string | null;
  filename: string | null;
  notes: string | null;
  processed_at: string | null;
  billed_cents: number | null;
  allowed_cents: number | null;
  plan_paid_cents: number | null;
  patient_resp_cents: number | null;
  id: string;
  document_id: string;
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Keep spreadsheets from treating text as a formula.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ledgerCsv(rows: CsvRow[]): string {
  const lines = [LEDGER_CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.type === 'eob' ? 'EOB' : 'Receipt',
        r.flagged ? 'TRUE' : 'FALSE',
        r.service_date,
        r.payment_date,
        r.person,
        r.provider,
        r.description,
        r.category,
        centsToDecimal(r.amount_cents),
        r.card_last4,
        r.status,
        r.excluded_reason,
        r.reimbursement_date,
        r.filename,
        r.notes,
        r.processed_at?.slice(0, 10) ?? '',
        centsToDecimal(r.billed_cents),
        centsToDecimal(r.allowed_cents),
        centsToDecimal(r.plan_paid_cents),
        centsToDecimal(r.patient_resp_cents),
        r.id,
        r.document_id,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF), for the legacy import. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}
