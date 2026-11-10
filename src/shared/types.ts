// Shapes shared by the Worker API and the app.

export type DocKind = 'receipt' | 'eob' | 'unknown';
export type DocStatus =
  'pending' | 'processing' | 'processed' | 'needs_review' | 'failed' | 'discarded';
export type DocSource = 'email' | 'upload' | 'import';
export type EntryType = 'receipt' | 'eob';
export type ExcludedReason = 'paid_with_hsa' | 'not_eligible' | 'reimbursed_elsewhere';
export type YearBasis = 'service_date' | 'payment_date';

export interface Person {
  id: string;
  name: string;
  relationship: string | null;
  aliases: string[];
  color: string;
  sort_order: number;
}

export interface Provider {
  id: string;
  name: string;
  aliases: string[];
}

export interface Category {
  id: string;
  name: string;
  sort_order: number;
}

/** Settings → Providers: a provider and how many entries use it. */
export interface ProviderUsage extends Provider {
  entries: number;
  /** How many of its entries were printed with each other spelling (alias → count). */
  alias_entries: Record<string, number>;
}

/** A printed provider name that may be an existing provider, waiting for a decision. */
export interface ProviderSuggestion {
  raw: string;
  entries: number;
  /** The closest existing provider, if any. */
  suggested_id: string | null;
}

/** Settings → Categories: a category and how many entries use it. */
export interface CategoryUsage extends Category {
  entries: number;
  /** "Other", the AI's fallback: it can't be renamed, merged or deleted. */
  permanent: boolean;
}

export interface SourceMeta {
  from?: string;
  to?: string;
  subject?: string;
  message_id?: string;
  received_at?: string;
  part_name?: string;
}

export interface DocumentSummary {
  id: string;
  kind: DocKind;
  status: DocStatus;
  source: DocSource;
  source_meta: SourceMeta;
  filename: string;
  mime: string;
  size_bytes: number;
  has_eml: boolean;
  text_layer_chars: number | null;
  extraction_model: string | null;
  extraction_provider: string | null;
  review_reasons: string[];
  error: string | null;
  attempts: number;
  received_at: string;
  processed_at: string | null;
  entry_count: number;
}

export interface Entry {
  id: string;
  document_id: string;
  type: EntryType;
  service_date: string | null;
  payment_date: string | null;
  person_id: string | null;
  patient_name_raw: string | null;
  provider_id: string | null;
  provider_name_raw: string | null;
  description: string | null;
  category_id: string | null;
  amount_cents: number | null;
  card_last4: string | null;
  billed_cents: number | null;
  allowed_cents: number | null;
  plan_paid_cents: number | null;
  patient_resp_cents: number | null;
  notes: string | null;
  confidence: number | null;
  source_quote: string | null;
  review_reasons: string[];
  reviewed_at: string | null;
  excluded_reason: ExcludedReason | null;
  excluded_auto: boolean;
  reimbursement_id: string | null;
  dup_of_entry_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** An entry with the bits of its document the ledger shows. */
export interface LedgerEntry extends Entry {
  doc_kind: DocKind;
  doc_status: DocStatus;
  doc_filename: string;
  doc_received_at: string;
}

export interface Reimbursement {
  id: string;
  date: string;
  note: string | null;
  created_at: string;
  total_cents: number;
  entry_count: number;
}

/** One panel on the Insights board: order is the array order. */
export interface InsightsPanel {
  id: string;
  size: 'half' | 'full';
  hidden: boolean;
}

export interface Settings {
  year_basis: YearBasis;
  hsa_cards: string[];
  family_names: string[];
  inbox_domain: string | null;
  /** The part before the @ (random unless the person chose one). */
  inbox_local: string;
  inbox_address: string | null;
  inbox_paused: boolean;
  inbox_min_kb: number;
  inbox_max_attachments: number;
  inbox_max_mb: number;
  inbox_daily_cap: number;
  inbox_allowlist: string[];
  onboarded: boolean;
  /** Where the daily review reminder goes (verified in Email Routing → Destination Addresses). */
  notify_email: string | null;
  notify_daily: boolean;
  /** Push: the Reimbursable milestone, in cents (one amount for the household). */
  notify_milestone_cents: number;
  /** Insights panel order, width and visibility. Unknown or missing panels use defaults. */
  insights_layout: InsightsPanel[];
}

export interface AiInfo {
  provider: string;
  text_model: string;
  vision_model: string;
  /** True when documents leave Cloudflare for a third party. */
  third_party: boolean;
  gateway: string | null;
}

/** Everything the app shell needs at once. */
export interface AppState {
  settings: Settings;
  people: Person[];
  providers: Provider[];
  categories: Category[];
  counts: {
    review_documents: number;
    review_entries: number;
    in_flight: number;
    failed: number;
    documents: number;
  };
  ai: AiInfo;
  /** Selfhost Kit state: updates and the anonymous usage check-in. */
  kit: {
    /** Someone added the update workflow to this copy's GitHub repo (Settings → Updates). */
    updates_set_up: boolean;
    /** Send the anonymous daily check-in (counts only). */
    telemetry: boolean;
  };
}

export interface InboxLogRow {
  id: string;
  received_at: string;
  to_addr: string | null;
  from_addr: string | null;
  subject: string | null;
  outcome:
    'received' | 'accepted' | 'rejected' | 'duplicate' | 'verification' | 'ignored' | 'failed';
  reason: string | null;
  size_bytes: number | null;
  attachment_count: number;
  document_count: number;
}

export interface InboxVerification {
  id: string;
  received_at: string;
  provider: string;
  from_addr: string | null;
  subject: string | null;
  code: string | null;
  link: string | null;
}

/** GET /api/documents/:id/email: the kept original email, for reading in the app. */
export interface EmailView {
  from: string;
  to: string;
  cc: string;
  date: string | null;
  subject: string;
  text: string;
  attachments: { filename: string; mime: string; size: number }[];
}
