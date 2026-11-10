// Fixed vocabularies and their human labels.
import type { ExcludedReason } from './types';

export const EXCLUDED_REASONS: [ExcludedReason, string][] = [
  ['paid_with_hsa', 'Paid with the HSA card'],
  ['not_eligible', 'Not HSA-eligible'],
  ['reimbursed_elsewhere', 'Reimbursed another way'],
];
export const EXCLUDED_LABEL = Object.fromEntries(EXCLUDED_REASONS) as Record<
  ExcludedReason,
  string
>;

/** Why something is waiting in Review. Unknown codes fall back to the code itself. */
export const REVIEW_REASON_LABEL: Record<string, string> = {
  missing_amount: 'No amount found',
  bad_amount: 'Amount looks wrong',
  amount_not_in_source: 'Amount not found in the document',
  missing_date: 'No date found',
  date_in_future: 'Date is in the future',
  date_too_old: 'Date is before 2000',
  unknown_patient: 'Patient not recognized',
  missing_patient: 'No patient name',
  unknown_provider: 'New provider',
  provider_suggestion: 'Provider may match an existing one',
  possible_duplicate: 'Possible duplicate',
  low_confidence: 'Low confidence',
  unknown_kind: 'Not sure what this document is',
  not_a_receipt: 'Doesn’t look like a receipt or EOB',
  no_entries: 'Nothing found to log',
  scanned_pdf_unsupported: 'Scanned PDF: no text to read',
  unsupported_file: 'File type can’t be read',
  extraction_failed: 'Couldn’t read this document',
  legacy_flagged: 'Flagged in HSA Wizard',
  model_flagged: 'Flagged while reading',
  legacy_file_missing: 'File not found during import',
  body_only_email: 'Email without an attachment',
};

export function reviewLabel(code: string): string {
  return REVIEW_REASON_LABEL[code] ?? code.replace(/_/g, ' ');
}

/** Categories created on first run (the legacy prompt's list plus Imaging). Users can edit them. */
export const DEFAULT_CATEGORIES = [
  'Doctor',
  'Dental',
  'Vision',
  'Prescription',
  'Physical Therapy',
  'Chiropractor',
  'Acupuncture',
  'Therapy',
  'Mental Health',
  'Labs',
  'Imaging',
  'Urgent Care',
  'Emergency Room',
  'Hospital',
  'Surgery',
  'Medical Equipment',
  'Other',
];

export const PERSON_COLORS = [
  'blue',
  'violet',
  'coral',
  'amber',
  'green',
  'rose',
  'teal',
  'slate',
  'mist',
] as const;

export const RELATIONSHIPS = ['Self', 'Spouse', 'Child', 'Dependent', 'Other'];

/** Inbox defaults (legacy "Min Image Size (KB)" was 25). */
export const INBOX_DEFAULTS = {
  min_kb: 25,
  max_attachments: 10,
  max_mb: 20,
  daily_cap: 50,
};

/** Accepted upload and attachment types. */
export const ACCEPTED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
