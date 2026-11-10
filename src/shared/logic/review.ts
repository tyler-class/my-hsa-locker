// Sanity checks on extracted entries. These are where quality comes from: anything doubtful
// goes to Review instead of into the totals.
import type { EntryType } from '../types';
import { amountInSource } from './money';
import { dateProblem } from './dates';

export const LOW_CONFIDENCE = 0.6;

export interface CheckInput {
  type: EntryType;
  amount_cents: number | null;
  /** True when the model gave an amount string that didn't parse as money. */
  amount_unparsed?: boolean;
  service_date: string | null;
  payment_date: string | null;
  /** True when the model gave a date string that didn't parse. */
  date_unparsed?: boolean;
  patient_name_raw: string | null;
  person_id: string | null;
  provider_name_raw: string | null;
  provider_id: string | null;
  provider_suggested?: boolean;
  confidence: number | null;
  dup_of_entry_id: string | null;
}

export interface CheckContext {
  /** The document's own text (text-layer PDFs and email bodies). Absent for images. */
  sourceText?: string | null;
  now?: Date;
}

/** Review reasons for one entry; [] when clean. Order is stable for display. */
export function reviewReasons(e: CheckInput, ctx: CheckContext = {}): string[] {
  const out: string[] = [];
  const add = (r: string) => !out.includes(r) && out.push(r);

  if (e.type === 'receipt') {
    if (e.amount_unparsed) add('bad_amount');
    else if (e.amount_cents === null || e.amount_cents === 0) add('missing_amount');
    else if (e.amount_cents < 0) add('bad_amount');
    else if (ctx.sourceText && !amountInSource(e.amount_cents, ctx.sourceText))
      add('amount_not_in_source');
  }

  if (e.date_unparsed) add('missing_date');
  const dates = [e.service_date, e.payment_date].filter((d): d is string => !!d);
  if (!dates.length) add('missing_date');
  for (const d of dates) {
    const p = dateProblem(d, ctx.now);
    if (p) add(p);
  }

  if (!e.person_id) add(e.patient_name_raw?.trim() ? 'unknown_patient' : 'missing_patient');
  if (!e.provider_id && e.provider_suggested) add('provider_suggestion');

  if (e.confidence !== null && e.confidence < LOW_CONFIDENCE) add('low_confidence');
  if (e.dup_of_entry_id) add('possible_duplicate');
  return out;
}

/** Removes reasons that no longer apply after an edit (e.g. a person was chosen). */
export function resolvedReasons(reasons: string[], e: CheckInput): string[] {
  return reasons.filter((r) => {
    if (r === 'unknown_patient' || r === 'missing_patient') return !e.person_id;
    if (r === 'provider_suggestion' || r === 'unknown_provider') return !e.provider_id;
    if (r === 'missing_amount' || r === 'bad_amount')
      return e.type === 'receipt' && !(e.amount_cents && e.amount_cents > 0);
    if (r === 'missing_date') return !e.service_date && !e.payment_date;
    if (r === 'possible_duplicate') return !!e.dup_of_entry_id;
    return true;
  });
}
