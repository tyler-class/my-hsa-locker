// What the model must return, and how it becomes entry drafts. Field names follow HSA Wizard's
// Gemini prompt (document_type, line_items, appointment_date…) so the legacy rules port as-is;
// confidence, source_quote and the EOB amounts are additions.
import { z } from 'zod';
import type { DocKind, EntryType } from './types';
import { parseDate } from './logic/dates';
import { parseMoney } from './logic/money';
import { last4 } from './logic/summary';

const str = z.string().nullable().optional();

export const lineItemSchema = z.object({
  appointment_date: str,
  payment_date: str,
  patient_name: str,
  provider_name: str,
  description: str,
  category: str,
  amount: z.union([z.string(), z.number()]).nullable().optional(),
  card_last4: z.union([z.string(), z.number()]).nullable().optional(),
  billed: z.union([z.string(), z.number()]).nullable().optional(),
  allowed: z.union([z.string(), z.number()]).nullable().optional(),
  plan_paid: z.union([z.string(), z.number()]).nullable().optional(),
  patient_responsibility: z.union([z.string(), z.number()]).nullable().optional(),
  additional_notes: str,
  flag_for_review: z.boolean().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  source_quote: str,
});

export const extractionSchema = z.object({
  document_type: z.string(),
  line_items: z.array(lineItemSchema).max(200).default([]),
});

export type Extraction = z.infer<typeof extractionSchema>;
export type LineItem = z.infer<typeof lineItemSchema>;

/** JSON Schema for providers that support structured output. Kept small and flat on purpose. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['document_type', 'line_items'],
  properties: {
    document_type: { type: 'string', enum: ['Receipt', 'EOB', 'Unknown'] },
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'appointment_date',
          'payment_date',
          'patient_name',
          'provider_name',
          'description',
          'category',
          'amount',
          'card_last4',
          'billed',
          'allowed',
          'plan_paid',
          'patient_responsibility',
          'additional_notes',
          'flag_for_review',
          'confidence',
          'source_quote',
        ],
        properties: {
          appointment_date: { type: ['string', 'null'] },
          payment_date: { type: ['string', 'null'] },
          patient_name: { type: ['string', 'null'] },
          provider_name: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] },
          category: { type: ['string', 'null'] },
          amount: { type: ['string', 'null'] },
          card_last4: { type: ['string', 'null'] },
          billed: { type: ['string', 'null'] },
          allowed: { type: ['string', 'null'] },
          plan_paid: { type: ['string', 'null'] },
          patient_responsibility: { type: ['string', 'null'] },
          additional_notes: { type: ['string', 'null'] },
          flag_for_review: { type: 'boolean' },
          confidence: { type: 'number' },
          source_quote: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

/** Pulls the first JSON object out of model text (tolerates ```json fences and chatter). */
export function parseModelJson(text: string): unknown {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('no_json');
  }
}

export function docKindOf(t: string): DocKind {
  const k = t.trim().toLowerCase();
  if (k === 'receipt') return 'receipt';
  if (k === 'eob' || k.includes('explanation of benefits')) return 'eob';
  return 'unknown';
}

/** One line item, normalized: dates parsed, money in cents. Matching to people etc. happens later. */
export interface EntryDraft {
  type: EntryType;
  service_date: string | null;
  payment_date: string | null;
  date_unparsed: boolean;
  patient_name_raw: string | null;
  provider_name_raw: string | null;
  description: string | null;
  category_name: string | null;
  amount_cents: number | null;
  amount_unparsed: boolean;
  card_last4: string | null;
  billed_cents: number | null;
  allowed_cents: number | null;
  plan_paid_cents: number | null;
  patient_resp_cents: number | null;
  notes: string | null;
  flagged: boolean;
  confidence: number | null;
  source_quote: string | null;
}

const clean = (v: string | null | undefined, max = 500) => {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return s && s.toLowerCase() !== 'null' ? s.slice(0, max) : null;
};
const money = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? null : parseMoney(v);

/**
 * Turns a validated extraction into drafts. Mirrors the legacy rules: EOB lines never carry a
 * paid amount, payment date or card; an Unknown document produces no entries.
 */
export function draftsFrom(x: Extraction): { kind: DocKind; drafts: EntryDraft[] } {
  const kind = docKindOf(x.document_type);
  if (kind === 'unknown') return { kind, drafts: [] };
  const type: EntryType = kind;
  const drafts = x.line_items.map((li): EntryDraft => {
    const sd = clean(li.appointment_date);
    const pd = clean(li.payment_date);
    const service_date = parseDate(sd);
    const payment_date = type === 'eob' ? null : parseDate(pd);
    const rawAmount = type === 'receipt' ? li.amount : null;
    const amount_cents = money(rawAmount);
    return {
      type,
      service_date,
      payment_date,
      date_unparsed: (!!sd && !service_date) || (type === 'receipt' && !!pd && !payment_date),
      patient_name_raw: clean(li.patient_name, 120),
      provider_name_raw: clean(li.provider_name, 160),
      description: clean(li.description, 300),
      category_name: clean(li.category, 60),
      amount_cents,
      amount_unparsed:
        rawAmount !== null && rawAmount !== undefined && rawAmount !== '' && amount_cents === null,
      card_last4:
        type === 'eob' ? null : last4(li.card_last4 === null ? null : String(li.card_last4 ?? '')),
      billed_cents: type === 'eob' ? money(li.billed) : null,
      allowed_cents: type === 'eob' ? money(li.allowed) : null,
      plan_paid_cents: type === 'eob' ? money(li.plan_paid) : null,
      patient_resp_cents: type === 'eob' ? money(li.patient_responsibility) : null,
      notes: clean(li.additional_notes, 200),
      flagged: li.flag_for_review === true,
      confidence: typeof li.confidence === 'number' ? li.confidence : null,
      source_quote: clean(li.source_quote, 300),
    };
  });
  return { kind, drafts };
}
