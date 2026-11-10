-- HSA Locker schema v1.
-- ids are TEXT uuids; timestamps are ISO-8601 strings; dates are YYYY-MM-DD; money is INTEGER
-- cents; booleans are INTEGER 0/1; lists are JSON arrays stored as TEXT.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The people receipts are for. aliases_json holds other spellings seen on documents
-- ("Sam", "Example, Sam"); matching also uses the family names in settings.
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  relationship TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  color TEXT NOT NULL DEFAULT 'mist',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Providers are normalization targets: EOBs often truncate names ("Riverside Physical Ther").
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Every message that reached the inbox, accepted or not. Never holds document contents.
-- The email handler only stores the raw message ('received'); parsing it into documents
-- happens afterwards, so the handler stays within tight CPU limits.
CREATE TABLE inbox_log (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  to_addr TEXT,
  from_addr TEXT,
  subject TEXT,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('received', 'accepted', 'rejected', 'duplicate', 'verification', 'ignored', 'failed')),
  reason TEXT,
  eml_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  document_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_inbox_log_received ON inbox_log (received_at);

-- Forwarding confirmations (e.g. Gmail's) waiting for the user to finish setup.
CREATE TABLE inbox_verifications (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  from_addr TEXT,
  subject TEXT,
  code TEXT,
  link TEXT,
  dismissed_at TEXT
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'unknown' CHECK (kind IN ('receipt', 'eob', 'unknown')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'needs_review', 'failed', 'discarded')),
  source TEXT NOT NULL CHECK (source IN ('email', 'upload', 'import')),
  -- {from, to, subject, message_id, received_at, part_name}
  source_meta_json TEXT NOT NULL DEFAULT '{}',
  inbox_log_id TEXT REFERENCES inbox_log (id) ON DELETE SET NULL,
  file_key TEXT NOT NULL,
  -- The raw .eml, kept with the first document from each message.
  eml_key TEXT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  legacy_md5 TEXT,
  text_layer_chars INTEGER,
  -- Raw model output. Never returned by list endpoints.
  extraction_json TEXT,
  extraction_model TEXT,
  extraction_provider TEXT,
  -- Document-level review reasons (e.g. scanned_pdf_unsupported, not_a_receipt).
  review_reasons_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One stored copy per file. Discarded documents free their hash so the file can be re-added.
CREATE UNIQUE INDEX idx_documents_sha256 ON documents (sha256) WHERE status != 'discarded';
CREATE INDEX idx_documents_status ON documents (status, next_attempt_at);
CREATE INDEX idx_documents_received ON documents (received_at);

CREATE TABLE reimbursements (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

-- One row per receipt, or per EOB service line.
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('receipt', 'eob')),
  service_date TEXT,
  payment_date TEXT,
  person_id TEXT REFERENCES people (id) ON DELETE SET NULL,
  patient_name_raw TEXT,
  provider_id TEXT REFERENCES providers (id) ON DELETE SET NULL,
  provider_name_raw TEXT,
  description TEXT,
  category_id TEXT REFERENCES categories (id) ON DELETE SET NULL,
  -- Receipts: what the patient paid. The only amount that counts toward reimbursable totals.
  amount_cents INTEGER,
  card_last4 TEXT,
  -- EOB lines only, for reference. Never counted in reimbursable totals.
  billed_cents INTEGER,
  allowed_cents INTEGER,
  plan_paid_cents INTEGER,
  patient_resp_cents INTEGER,
  notes TEXT,
  confidence REAL,
  source_quote TEXT,
  review_reasons_json TEXT NOT NULL DEFAULT '[]',
  reviewed_at TEXT,
  excluded_reason TEXT
    CHECK (excluded_reason IS NULL OR excluded_reason IN ('paid_with_hsa', 'not_eligible', 'reimbursed_elsewhere')),
  -- Set automatically from the HSA card list, so it can be undone when the list changes.
  excluded_auto INTEGER NOT NULL DEFAULT 0,
  reimbursement_id TEXT REFERENCES reimbursements (id) ON DELETE SET NULL,
  dup_of_entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_entries_document ON entries (document_id, sort_order);
CREATE INDEX idx_entries_reimbursement ON entries (reimbursement_id);
CREATE INDEX idx_entries_dupkey ON entries (person_id, service_date, amount_cents);

CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX idx_login_attempts_ip ON login_attempts (ip, attempted_at);

-- The legacy HSA Wizard prompt's categories (so imported rows match), plus Imaging.
INSERT INTO categories (id, name, sort_order) VALUES
  ('cat-doctor', 'Doctor', 1),
  ('cat-dental', 'Dental', 2),
  ('cat-vision', 'Vision', 3),
  ('cat-prescription', 'Prescription', 4),
  ('cat-physical-therapy', 'Physical Therapy', 5),
  ('cat-chiropractor', 'Chiropractor', 6),
  ('cat-acupuncture', 'Acupuncture', 7),
  ('cat-therapy', 'Therapy', 8),
  ('cat-mental-health', 'Mental Health', 9),
  ('cat-labs', 'Labs', 10),
  ('cat-imaging', 'Imaging', 11),
  ('cat-urgent-care', 'Urgent Care', 12),
  ('cat-emergency-room', 'Emergency Room', 13),
  ('cat-hospital', 'Hospital', 14),
  ('cat-surgery', 'Surgery', 15),
  ('cat-medical-equipment', 'Medical Equipment', 16),
  ('cat-other', 'Other', 99);
