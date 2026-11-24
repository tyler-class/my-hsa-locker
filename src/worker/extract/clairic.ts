// Clairic (Cloudflare's extraction model on Workers AI) as the first read of a receipt photo.
// It answers typed fields straight from the image, null where the photo doesn't say, with a
// confidence for each, and never generates text, so there's no JSON to repair. It reads one
// receipt; anything else (an EOB, several charges, no amount) is left to the general model.
import { ProviderError, shortReason } from './providers';

export const CLAIRIC_MODEL = '@cf/cloudflare/clairic';

/** Below this, the entry is flagged for a look in Review. */
const SURE = 0.8;

/** The fields asked for. Request shape per the Workers AI model page (2026-11). */
export const CLAIRIC_FIELDS = {
  is_receipt: {
    type: 'boolean',
    instructions:
      'True if this is a receipt, invoice or statement showing what the patient paid for medical, dental, vision or pharmacy care or products',
  },
  is_eob: {
    type: 'boolean',
    instructions: 'True if this is an Explanation of Benefits or claim summary from an insurer',
  },
  charge_count: {
    type: 'number',
    decimals: 0,
    instructions: 'How many separate visits or purchases this document shows payments for',
  },
  provider_name: { type: 'text', instructions: 'The pharmacy, practice or business that was paid' },
  patient_name: { type: 'text', instructions: 'The patient the care or purchase was for' },
  description: { type: 'text', instructions: 'The service or item paid for, in a few words' },
  card_last4: {
    type: 'text',
    instructions: 'The last four digits of the payment card, if printed',
  },
  service_date: { type: 'date', instructions: 'The date of the visit, service or purchase' },
  payment_date: { type: 'date', instructions: 'The date the payment was made' },
  amount_paid: {
    type: 'number',
    decimals: 2,
    unit: 'USD',
    instructions: 'The amount the patient paid, including tax',
  },
} as const;

type Field = keyof typeof CLAIRIC_FIELDS;
interface Answer {
  value?: unknown;
  confidence?: unknown;
}

export function clairicInput(file: { base64: string; mime: string }, today: string) {
  return {
    model: 'clairic',
    images: [`data:${file.mime};base64,${file.base64}`],
    reference_date: today,
    fields: CLAIRIC_FIELDS,
  };
}

/**
 * The reply as the app's extraction JSON (one receipt line), or a ProviderError naming why it
 * isn't one, so the general model reads it instead.
 */
export function clairicExtraction(out: unknown): string {
  const top = out as { result?: unknown } | null;
  const o = (top && typeof top === 'object' && 'result' in top ? top.result : out) as {
    answers?: Partial<Record<Field, Answer>>;
  } | null;
  const a = o?.answers;
  if (!a || typeof a !== 'object')
    throw new ProviderError('empty_reply', true, 'clairic: no answers');
  const val = (k: Field) => a[k]?.value ?? null;
  const str = (k: Field) => {
    const v = val(k);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const conf = (k: Field) => {
    const c = a[k]?.confidence;
    return typeof c === 'number' && Number.isFinite(c) ? c : null;
  };

  if (val('is_eob') === true) throw new ProviderError('clairic_skip', true, 'an EOB');
  if (val('is_receipt') !== true) throw new ProviderError('clairic_skip', true, 'not a receipt');
  const count = val('charge_count');
  if (typeof count === 'number' && count > 1)
    throw new ProviderError('clairic_skip', true, `${count} charges`);
  const amount = val('amount_paid');
  if (typeof amount !== 'number' || !Number.isFinite(amount))
    throw new ProviderError('clairic_skip', true, 'no amount');

  const date = str('service_date') ?? str('payment_date');
  const sure = [
    conf('amount_paid'),
    conf(date === str('service_date') ? 'service_date' : 'payment_date'),
  ]
    .filter((c): c is number => c !== null)
    .reduce((m, c) => Math.min(m, c), 1);
  return JSON.stringify({
    document_type: 'Receipt',
    line_items: [
      {
        appointment_date: str('service_date'),
        payment_date: str('payment_date'),
        patient_name: str('patient_name'),
        provider_name: str('provider_name'),
        description: str('description'),
        category: null,
        amount: amount.toFixed(2),
        card_last4: str('card_last4')?.replace(/\D/g, '').slice(-4) || null,
        billed: null,
        allowed: null,
        plan_paid: null,
        patient_responsibility: null,
        additional_notes: null,
        flag_for_review: sure < SURE || !date,
        confidence: Math.round(sure * 100) / 100,
        source_quote: null,
      },
    ],
  });
}

/** One Clairic read of a photo. */
export async function clairicRead(
  env: Cloudflare.Env,
  file: { base64: string; mime: string },
): Promise<{ text: string; model: string }> {
  let out: unknown;
  try {
    const run = env.AI.run as unknown as (m: string, i: unknown, o?: unknown) => Promise<unknown>;
    out = await run.call(
      env.AI,
      CLAIRIC_MODEL,
      clairicInput(file, new Date().toISOString().slice(0, 10)),
      env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined,
    );
  } catch (e) {
    throw new ProviderError('workers_ai_error', true, `clairic: ${shortReason(e) ?? 'error'}`);
  }
  return { text: clairicExtraction(out), model: CLAIRIC_MODEL };
}
