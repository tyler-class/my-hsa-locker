// Reads one document into entries. D1 is the work queue: documents.status + attempts +
// next_attempt_at. Processing is idempotent per document: it replaces that document's entries.
import { draftsFrom, extractionSchema, parseModelJson, type EntryDraft } from '@shared/extraction';
import {
  applyHsaCards,
  findDuplicate,
  matchPerson,
  matchProvider,
  nameKey,
  newPersonName,
  reviewReasons,
  suggestPerson,
  withAlias,
} from '@shared/logic';
import { PERSON_COLORS } from '@shared/lookups';
import type { DocKind, Entry, Person } from '@shared/types';
import {
  all,
  first,
  insertStmt,
  loadCategories,
  loadPeople,
  loadProviders,
  loadSettings,
  newId,
  nowIso,
  toEntry,
} from '../db';
import { filePrompt, MAX_TEXT_CHARS, REPAIR_PROMPT, systemPrompt, textPrompt } from './prompt';
import {
  getProvider,
  ProviderError,
  toBase64,
  type LlmProvider,
  type ModelCall,
} from './providers';
import { htmlToText, MIN_TEXT_CHARS, pdfText } from './text';
import { notifyWhenIdle } from '../notifications';

export const MAX_ATTEMPTS = 5;
export const STALE_MINUTES = 10;
/** Largest file sent to a model as an image/PDF. */
export const MAX_MODEL_FILE_BYTES = 10 * 1024 * 1024;

/** Minutes to wait before attempt n+1 (2, 4, 8, 16). */
export function backoffMinutes(attempts: number): number {
  return 2 ** Math.max(1, attempts);
}

interface DocRow {
  id: string;
  file_key: string;
  filename: string;
  mime: string;
  attempts: number;
  status: string;
}

/**
 * Takes the document for processing if it's due (pending, failed with attempts left, or stuck in
 * processing). Returns null if someone else has it or it's done.
 */
async function claim(db: D1Database, id: string): Promise<DocRow | null> {
  const now = nowIso();
  const stale = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
  return first<DocRow>(
    db,
    `UPDATE documents SET status = 'processing', attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND (
       (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
       OR (status = 'failed' AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
       OR (status = 'processing' AND updated_at < ?)
     )
     RETURNING id, file_key, filename, mime, attempts, status`,
    now,
    id,
    now,
    MAX_ATTEMPTS,
    now,
    stale,
  );
}

/** Ids due for processing, oldest first. */
export async function dueDocuments(db: D1Database, limit: number): Promise<string[]> {
  const now = nowIso();
  const stale = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
  return (
    await all<{ id: string }>(
      db,
      `SELECT id FROM documents WHERE
         (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (status = 'failed' AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (status = 'processing' AND updated_at < ?)
       ORDER BY received_at LIMIT ?`,
      now,
      MAX_ATTEMPTS,
      now,
      stale,
      limit,
    )
  ).map((r) => r.id);
}

type Outcome =
  | { kind: 'review'; reasons: string[]; textChars: number | null }
  | {
      kind: 'extracted';
      raw: string;
      model: string;
      sourceText: string | null;
      textChars: number | null;
    };

async function ask(provider: LlmProvider, call: ModelCall) {
  const first = await provider.complete(call);
  try {
    return {
      json: extractionSchema.parse(parseModelJson(first.text)),
      raw: first.text,
      model: first.model,
    };
  } catch {
    // One repair-and-retry, as the brief asks for models without strict structured output.
    const second = await provider.complete({
      ...call,
      repair: { previous: first.text.slice(0, 8000), ask: REPAIR_PROMPT },
    });
    return {
      json: extractionSchema.parse(parseModelJson(second.text)),
      raw: second.text,
      model: second.model,
    };
  }
}

async function readDocument(
  env: Cloudflare.Env,
  doc: DocRow,
  provider: LlmProvider,
  categories: string[],
): Promise<Outcome & { extraction?: ReturnType<typeof extractionSchema.parse> }> {
  const obj = await env.FILES.get(doc.file_key);
  if (!obj) return { kind: 'review', reasons: ['extraction_failed'], textChars: null };
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const system = systemPrompt(categories);

  let text: string | null = null;
  if (doc.mime === 'text/html' || doc.mime === 'text/plain') {
    const raw = new TextDecoder().decode(bytes);
    text = doc.mime === 'text/html' ? htmlToText(raw) : raw;
  } else if (doc.mime === 'application/pdf') {
    text = await pdfText(env, bytes, doc.filename);
  }
  const textChars = text === null ? null : text.length;

  if (text !== null && (text.length >= MIN_TEXT_CHARS || doc.mime.startsWith('text/'))) {
    const r = await ask(provider, {
      system,
      user: textPrompt(text.slice(0, MAX_TEXT_CHARS), doc.filename),
    });
    return {
      kind: 'extracted',
      raw: r.raw,
      model: r.model,
      sourceText: text,
      textChars,
      extraction: r.json,
    };
  }

  // Images, and PDFs with no usable text layer: send the file to a vision-capable model.
  if (!provider.accepts(doc.mime)) {
    const reason = doc.mime === 'application/pdf' ? 'scanned_pdf_unsupported' : 'unsupported_file';
    return { kind: 'review', reasons: [reason], textChars };
  }
  if (bytes.byteLength > MAX_MODEL_FILE_BYTES)
    return { kind: 'review', reasons: ['unsupported_file'], textChars };
  const r = await ask(provider, {
    system,
    user: filePrompt(doc.filename),
    file: { base64: toBase64(bytes), mime: doc.mime },
  });
  return {
    kind: 'extracted',
    raw: r.raw,
    model: r.model,
    sourceText: null,
    textChars,
    extraction: r.json,
  };
}

/**
 * The person for a printed patient name: a match, else a new person (created once per document)
 * when the name is clearly a name and isn't close to someone already there. A close match
 * ("Wm. Smith" for William Smith) or a placeholder ("Patient", "Self") gets no person, so the
 * entry goes to Review as an unknown patient.
 */
async function personFor(
  db: D1Database,
  raw: string | null,
  people: Person[],
  familyNames: string[],
  created: Map<string, string>,
  now: string,
): Promise<string | null> {
  const match = matchPerson(raw, people, familyNames);
  if (match) return match.id;
  const name = newPersonName(raw, familyNames);
  if (!name) return null;
  const key = nameKey(name);
  const made = created.get(key);
  if (made) return made;
  if (suggestPerson(raw, people, familyNames)) return null;
  // Like Settings → People: the next colour in turn, at the end of the list. The printed name is
  // kept as an alias when it differs ("JANE SMITH (DEPENDENT)"), so the next receipt matches it.
  const person: Person = {
    id: newId(),
    name,
    relationship: null,
    aliases: withAlias(name, [], raw!.trim()),
    color: PERSON_COLORS[people.length % PERSON_COLORS.length]!,
    sort_order: people.length,
  };
  const { aliases, ...cols } = person;
  await insertStmt(db, 'people', {
    ...cols,
    aliases_json: JSON.stringify(aliases),
    created_at: now,
    updated_at: now,
  }).run();
  people.push(person);
  created.set(key, person.id);
  return person.id;
}

/** Builds entry rows from drafts: people, providers, categories, HSA cards, duplicates, review. */
export async function buildEntries(
  db: D1Database,
  documentId: string,
  drafts: EntryDraft[],
  sourceText: string | null,
): Promise<Record<string, unknown>[]> {
  const [settings, people, providers, categories] = await Promise.all([
    loadSettings(db),
    loadPeople(db),
    loadProviders(db),
    loadCategories(db),
  ]);
  const catByKey = new Map(categories.map((c) => [nameKey(c.name), c.id]));
  const now = nowIso();
  const rows: Record<string, unknown>[] = [];
  const created = new Map<string, string>(); // provider key → id, within this document
  const createdPeople = new Map<string, string>(); // new person's name key → id, likewise

  for (const [i, d] of drafts.entries()) {
    const personId = await personFor(
      db,
      d.patient_name_raw,
      people,
      settings.family_names,
      createdPeople,
      now,
    );
    let providerId: string | null = null;
    let providerSuggested = false;
    if (d.provider_name_raw) {
      const m = matchProvider(d.provider_name_raw, providers);
      if (m.kind === 'exact') providerId = m.id;
      else if (m.kind === 'suggestion') providerSuggested = true;
      else {
        // A provider we've never seen becomes a new provider (a normalization target for later).
        const k = nameKey(d.provider_name_raw);
        providerId = created.get(k) ?? null;
        if (!providerId) {
          providerId = newId();
          created.set(k, providerId);
          await db
            .prepare(
              'INSERT INTO providers (id, name, aliases_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            )
            .bind(providerId, d.provider_name_raw, '[]', now, now)
            .run();
          providers.push({ id: providerId, name: d.provider_name_raw, aliases: [] });
        }
      }
    }

    const base = {
      type: d.type,
      service_date: d.service_date,
      payment_date: d.payment_date,
      person_id: personId,
      provider_id: providerId,
      provider_name_raw: d.provider_name_raw,
      description: d.description,
      amount_cents: d.amount_cents,
    };
    let dup: Entry | null = null;
    const date = d.service_date ?? d.payment_date;
    if (base.person_id && date) {
      const candidates = (
        await all(
          db,
          `SELECT * FROM entries WHERE person_id = ? AND document_id != ?
             AND (service_date = ? OR payment_date = ?) LIMIT 50`,
          base.person_id,
          documentId,
          date,
          date,
        )
      ).map(toEntry);
      dup = findDuplicate({ ...base, document_id: documentId }, candidates);
    }

    const reasons = reviewReasons(
      {
        ...base,
        amount_unparsed: d.amount_unparsed,
        date_unparsed: d.date_unparsed,
        patient_name_raw: d.patient_name_raw,
        provider_suggested: providerSuggested,
        confidence: d.confidence,
        dup_of_entry_id: dup?.id ?? null,
      },
      { sourceText },
    );
    if (d.flagged) reasons.push('model_flagged');

    const withCards = applyHsaCards(
      { type: d.type, card_last4: d.card_last4, excluded_reason: null, excluded_auto: false },
      settings.hsa_cards,
    );
    rows.push({
      id: newId(),
      document_id: documentId,
      ...base,
      patient_name_raw: d.patient_name_raw,
      category_id: d.category_name ? (catByKey.get(nameKey(d.category_name)) ?? null) : null,
      card_last4: d.card_last4,
      billed_cents: d.billed_cents,
      allowed_cents: d.allowed_cents,
      plan_paid_cents: d.plan_paid_cents,
      patient_resp_cents: d.patient_resp_cents,
      notes: d.notes,
      confidence: d.confidence,
      source_quote: d.source_quote,
      review_reasons_json: JSON.stringify(reasons),
      excluded_reason: withCards.excluded_reason,
      excluded_auto: withCards.excluded_auto ? 1 : 0,
      dup_of_entry_id: dup?.id ?? null,
      sort_order: i,
      created_at: now,
      updated_at: now,
    });
  }
  return rows;
}

function docReasons(kind: DocKind, entryCount: number, mime: string): string[] {
  if (kind === 'unknown') return [mime.startsWith('text/') ? 'body_only_email' : 'not_a_receipt'];
  if (!entryCount) return ['no_entries'];
  return [];
}

export type ProcessResult = 'processed' | 'needs_review' | 'failed' | 'skipped';

/**
 * Processes one document if it's due. Safe to call twice: the second call finds nothing to claim.
 * Afterwards, push notifications go out for what's now in Review (once nothing else is being read).
 */
export async function processDocument(env: Cloudflare.Env, id: string): Promise<ProcessResult> {
  const result = await readAndStore(env, id);
  if (result !== 'skipped') await notifyWhenIdle(env.DB);
  return result;
}

async function readAndStore(env: Cloudflare.Env, id: string): Promise<ProcessResult> {
  const db = env.DB;
  const doc = await claim(db, id);
  if (!doc) return 'skipped';
  const provider = getProvider(env);
  const now = nowIso();

  try {
    const categories = (await loadCategories(db)).map((c) => c.name);
    const out = await readDocument(env, doc, provider, categories);

    if (out.kind === 'review') {
      await db.batch([
        db
          .prepare('DELETE FROM entries WHERE document_id = ? AND reimbursement_id IS NULL')
          .bind(id),
        db
          .prepare(
            `UPDATE documents SET status = 'needs_review', review_reasons_json = ?, text_layer_chars = ?,
               error = NULL, next_attempt_at = NULL, processed_at = ?, updated_at = ?,
               extraction_provider = ?, extraction_model = NULL WHERE id = ?`,
          )
          .bind(JSON.stringify(out.reasons), out.textChars, now, now, provider.id, id),
      ]);
      return 'needs_review';
    }

    const { kind, drafts } = draftsFrom(out.extraction!);
    // The test provider carries its reply inside the document; keep that out of the amount check.
    const sourceText =
      provider.id === 'fake'
        ? (out.sourceText?.replace(/FAKE_EXTRACTION:.*$/gm, '') ?? null)
        : out.sourceText;
    const rows = await buildEntries(db, id, drafts, sourceText);
    const dReasons = docReasons(kind, rows.length, doc.mime);
    const anyEntryReview = rows.some((r) => r.review_reasons_json !== '[]');
    const status = dReasons.length || anyEntryReview ? 'needs_review' : 'processed';
    await db.batch([
      // Reprocessing replaces the document's entries (the API refuses while any are reimbursed).
      db.prepare('DELETE FROM entries WHERE document_id = ? AND reimbursement_id IS NULL').bind(id),
      ...rows.map((r) => insertStmt(db, 'entries', r)),
      db
        .prepare(
          `UPDATE documents SET status = ?, kind = ?, review_reasons_json = ?, text_layer_chars = ?,
             extraction_json = ?, extraction_model = ?, extraction_provider = ?, error = NULL,
             next_attempt_at = NULL, processed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(
          status,
          kind,
          JSON.stringify(dReasons),
          out.textChars,
          out.raw.slice(0, 100_000),
          out.model,
          provider.id,
          now,
          now,
          id,
        ),
    ]);
    return status;
  } catch (e) {
    // Log the error class only, never contents.
    const code =
      e instanceof ProviderError ? e.message : e instanceof Error ? e.name || 'error' : 'error';
    const retryable = !(e instanceof ProviderError) || e.retryable;
    const giveUp = !retryable || doc.attempts >= MAX_ATTEMPTS;
    console.warn(`document ${id}: attempt ${doc.attempts} failed (${code})`);
    if (giveUp) {
      await db
        .prepare(
          `UPDATE documents SET status = 'needs_review', review_reasons_json = ?, error = ?,
             next_attempt_at = NULL, processed_at = ?, updated_at = ?, extraction_provider = ? WHERE id = ?`,
        )
        .bind(JSON.stringify(['extraction_failed']), code, now, now, provider.id, id)
        .run();
      return 'needs_review';
    }
    const next = new Date(Date.now() + backoffMinutes(doc.attempts) * 60_000).toISOString();
    await db
      .prepare(
        `UPDATE documents SET status = 'failed', error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(code, next, now, id)
      .run();
    return 'failed';
  }
}

/** Processes due documents one at a time, within a budget. */
export async function sweep(env: Cloudflare.Env, limit = 5): Promise<number> {
  const ids = await dueDocuments(env.DB, limit);
  let done = 0;
  for (const id of ids) {
    if ((await processDocument(env, id)) !== 'skipped') done++;
  }
  return done;
}
