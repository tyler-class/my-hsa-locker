// API input validation, shared with the app.
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const cents = z.number().int().min(-100_000_000).max(100_000_000).nullable().optional();

export const loginInput = z.object({ password: z.string().min(1).max(500) });

export const personInput = z.object({
  name: z.string().trim().min(1).max(80),
  relationship: nullableText(40),
  aliases: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  color: z.string().max(20).optional(),
  sort_order: z.number().int().optional(),
});
export const personPatch = personInput.partial();

export const providerInput = z.object({
  name: z.string().trim().min(1).max(160),
  aliases: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
});
export const providerPatch = providerInput.partial();
export const providerMerge = z.object({ into: z.string().min(1) });
export const providerAlias = z.object({ alias: z.string().trim().min(1) });
export const providerAliasMove = z.object({
  alias: z.string().trim().min(1),
  into: z.string().min(1),
});

export const categoryInput = z.object({
  name: z.string().trim().min(1).max(60),
  sort_order: z.number().int().optional(),
});
export const categoryPatch = categoryInput.partial();
export const categoryMerge = z.object({ into: z.string().min(1) });

export const settingsPatch = z.object({
  hsa_cards: z
    .array(z.string().regex(/^\d{4}$/, 'Card numbers are the last 4 digits.'))
    .max(20)
    .optional(),
  family_names: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  inbox_domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(
      /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      'Enter a domain name like hsa-in.example.com.',
    )
    .nullable()
    .optional(),
  /** The part before the @. Replaces the random name; Rotate goes back to a random one. */
  inbox_local: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/,
      'Use letters, numbers, dots, dashes or underscores.',
    )
    .optional(),
  inbox_paused: z.boolean().optional(),
  inbox_min_kb: z.number().int().min(0).max(5000).optional(),
  inbox_max_attachments: z.number().int().min(1).max(50).optional(),
  inbox_max_mb: z.number().int().min(1).max(25).optional(),
  inbox_daily_cap: z.number().int().min(1).max(1000).optional(),
  inbox_allowlist: z.array(z.string().trim().toLowerCase().min(3).max(254)).max(50).optional(),
  onboarded: z.boolean().optional(),
  notify_email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter an email address.')
    .nullable()
    .optional(),
  notify_daily: z.boolean().optional(),
  /** Push: the Reimbursable milestone, whole dollars in cents ($1 to $1,000,000). */
  notify_milestone_cents: z
    .number()
    .int()
    .min(100)
    .max(100_000_000)
    .refine((c) => c % 100 === 0, 'Use whole dollars.')
    .optional(),
  /** Insights panel order, width and visibility. */
  insights_layout: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        size: z.enum(['half', 'full']),
        hidden: z.boolean(),
      }),
    )
    .max(40)
    .optional(),
  /** Selfhost Kit: send the anonymous daily check-in (counts only). */
  telemetry: z.boolean().optional(),
  /** Selfhost Kit: the update workflow was added to this copy's GitHub repo. */
  updates_set_up: z.boolean().optional(),
});

export const entryFields = z.object({
  type: z.enum(['receipt', 'eob']).optional(),
  service_date: isoDate.nullable().optional(),
  payment_date: isoDate.nullable().optional(),
  person_id: z.string().nullable().optional(),
  provider_id: z.string().nullable().optional(),
  description: nullableText(300),
  category_id: z.string().nullable().optional(),
  amount_cents: cents,
  card_last4: z
    .string()
    .regex(/^\d{4}$/, 'Last 4 digits only.')
    .nullable()
    .optional(),
  billed_cents: cents,
  allowed_cents: cents,
  plan_paid_cents: cents,
  patient_resp_cents: cents,
  notes: nullableText(1000),
  excluded_reason: z
    .enum(['paid_with_hsa', 'not_eligible', 'reimbursed_elsewhere'])
    .nullable()
    .optional(),
});
export const entryPatch = entryFields;
export const entryCreate = entryFields.extend({ type: z.enum(['receipt', 'eob']) });

export const idList = z.array(z.string().min(1)).min(1).max(1000);

export const bulkEntries = z.object({
  ids: idList,
  action: z.enum(['approve', 'exclude', 'unexclude', 'delete']),
  reason: z.enum(['paid_with_hsa', 'not_eligible', 'reimbursed_elsewhere']).optional(),
});

export const reimbursementInput = z.object({
  date: isoDate,
  note: nullableText(300),
  entry_ids: idList,
});
export const reimbursementPatch = z.object({ date: isoDate.optional(), note: nullableText(300) });

export const deleteAllInput = z.object({ confirm: z.literal('DELETE EVERYTHING') });
