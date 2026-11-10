// MCP server: lets any MCP-capable assistant read this household's HSA ledger and record
// reimbursements. Tools call the same REST API the app uses, marked internal because
// OAuthProvider has already checked the assistant's token. No file access in v1.
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { centsToDecimal, entryStatus, filterLedger, type LedgerFilter } from '@shared/logic';
import { EXCLUDED_REASONS, reviewLabel } from '@shared/lookups';
import type { AppState, LedgerEntry, Reimbursement } from '@shared/types';
import type { Totals, YearTotals } from '@shared/logic';
import { EXAMPLE_PROMPTS, MCP_PROMPTS } from '@shared/examples';
import pkg from '../../package.json';
import { app } from './app';
import { INTERNAL } from './auth';

type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;

class ToolError extends Error {}

function apiCaller(origin: string, env: Cloudflare.Env, ctx: ExecutionContext): Call {
  const internalEnv = { ...env, [INTERNAL]: true };
  return async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.fetch(
      new Request(`${origin}/api${path}`, {
        method,
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      }),
      internalEnv,
      ctx,
    );
    const data = (await res.json().catch(() => null)) as T & { message?: string };
    if (!res.ok) throw new ToolError(data?.message ?? `Request failed (${res.status}).`);
    return data;
  };
}

const text = (v: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) },
  ],
});
const fail = (e: unknown) => ({
  content: [
    { type: 'text' as const, text: e instanceof Error ? e.message : 'Something went wrong.' },
  ],
  isError: true,
});

const MONEY_NOTE =
  'Amounts are exact: *_cents fields are integer cents and amount strings are dollars to the cent. Only receipts count toward reimbursable totals; EOB lines are reference only and never count.';

const dollars = (c: number | null) => (c === null ? null : centsToDecimal(c));

function totalsView(t: Totals | YearTotals) {
  return {
    ...('year' in t ? { year: t.year ?? 'undated' } : {}),
    documented: dollars(t.documented_cents),
    reimbursed: dollars(t.reimbursed_cents),
    reimbursable: dollars(t.outstanding_cents),
    pending_review: dollars(t.pending_review_cents),
    not_claimable: dollars(t.excluded_cents),
    receipts: t.receipt_count,
    eob_documents: t.eob_document_count,
    eob_lines: t.eob_line_count,
  };
}

function entryView(e: LedgerEntry, s: AppState) {
  const person = s.people.find((p) => p.id === e.person_id)?.name;
  const provider = s.providers.find((p) => p.id === e.provider_id)?.name;
  const category = s.categories.find((c) => c.id === e.category_id)?.name;
  return {
    id: e.id,
    type: e.type,
    status: entryStatus(e),
    service_date: e.service_date,
    payment_date: e.payment_date,
    patient: person ?? e.patient_name_raw,
    provider: provider ?? e.provider_name_raw,
    description: e.description,
    category: category ?? null,
    ...(e.type === 'receipt'
      ? { amount: dollars(e.amount_cents), amount_cents: e.amount_cents, card_last4: e.card_last4 }
      : {
          billed: dollars(e.billed_cents),
          allowed: dollars(e.allowed_cents),
          plan_paid: dollars(e.plan_paid_cents),
          patient_responsibility: dollars(e.patient_resp_cents),
        }),
    ...(e.excluded_reason ? { excluded_reason: e.excluded_reason } : {}),
    ...(e.reimbursement_id ? { reimbursement_id: e.reimbursement_id } : {}),
    ...(e.review_reasons.length ? { needs_review: e.review_reasons.map(reviewLabel) } : {}),
    ...(e.notes ? { notes: e.notes } : {}),
    document: e.doc_filename,
  };
}

const statusEnum = z.enum(['all', 'outstanding', 'reimbursed', 'excluded', 'needs_review']);
const excludedEnum = z.enum(EXCLUDED_REASONS.map(([k]) => k) as [string, ...string[]]);

export const INSTRUCTIONS = `HSA Locker keeps a household's medical receipts and EOBs (Explanations of Benefits) and tracks what they can still reimburse themselves from their HSA.

How to work with it:
- Receipts carry the amount the patient paid; only receipts count toward reimbursable totals. EOB lines are reference only and never count.
- An entry's status is reimbursable (status value "outstanding": can be reimbursed now), reimbursed, not claimable (status value "excluded": paid with the HSA card, not eligible, or reimbursed another way), or needs review. Amounts waiting for review are never part of reimbursable. Use the words reimbursable and not claimable with the user.
- Money in tool results is exact: *_cents fields are integer cents, amount strings are dollars to the cent. Add amounts as cents.
- Use list_entries (filters: year, person, category, provider, status, text) to find entries and their ids before changing anything.
- Ask before recording a reimbursement, marking receipts not claimable, or changing several entries at once. Show the list and total first.
- You can't see the documents themselves, only what was read from them.

When someone asks what you can do with HSA Locker (or seems unsure where to start), call get_started: it returns their current totals and open items and example requests to offer. Suggest two or three that fit, phrased for their data, rather than listing tools. Examples:
${EXAMPLE_PROMPTS.map((e) => `- "${e.prompt}"`).join('\n')}`;

function buildServer(call: Call) {
  const server = new McpServer(
    { name: 'hsa-locker', version: pkg.version },
    { instructions: INSTRUCTIONS },
  );
  const state = () => call<AppState>('GET', '/state');
  const ledger = async () => (await call<{ entries: LedgerEntry[] }>('GET', '/entries')).entries;
  const find = (
    list: { id: string; name: string; aliases?: string[] }[],
    key: string | undefined,
    what: string,
  ) => {
    if (!key) return null;
    const k = key.trim().toLowerCase();
    const hit =
      list.find((x) => x.id === key) ??
      list.find(
        (x) => x.name.toLowerCase() === k || x.aliases?.some((a) => a.toLowerCase() === k),
      ) ??
      (list.filter((x) => x.name.toLowerCase().includes(k)).length === 1
        ? list.find((x) => x.name.toLowerCase().includes(k))
        : undefined);
    if (!hit)
      throw new ToolError(
        `No ${what} matches “${key}”. Options: ${list.map((x) => x.name).join(', ') || 'none'}.`,
      );
    return hit.id;
  };

  server.registerTool(
    'get_summary',
    {
      description: `Totals for the household's HSA: documented, reimbursed, reimbursable and pending review, overall and per year. ${MONEY_NOTE} Reimbursable never includes amounts still waiting for review.`,
      inputSchema: z.object({ year: z.number().int().optional().describe('Only this year') }),
    },
    async ({ year }) => {
      try {
        const s = await call<{ totals: Totals; years: YearTotals[]; year_basis: string }>(
          'GET',
          '/summary',
        );
        const years = s.years.filter((y) => year === undefined || y.year === year).map(totalsView);
        return text({
          year_basis: s.year_basis,
          all_time: year === undefined ? totalsView(s.totals) : undefined,
          years,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'list_entries',
    {
      description: `List receipts and EOB lines. Filter by year, person, category, provider, status or text. ${MONEY_NOTE}`,
      inputSchema: z.object({
        year: z.number().int().optional(),
        person: z.string().optional().describe('Name or id'),
        category: z.string().optional(),
        provider: z.string().optional(),
        status: statusEnum
          .optional()
          .describe('outstanding = reimbursable now; excluded = not claimable'),
        type: z.enum(['all', 'receipt', 'eob']).optional(),
        text: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    },
    async (a) => {
      try {
        const s = await state();
        const f: LedgerFilter = {
          year: a.year ?? null,
          person: find(s.people, a.person, 'person'),
          category: find(s.categories, a.category, 'category'),
          provider: find(s.providers, a.provider, 'provider'),
          status: a.status ?? 'all',
          type: a.type ?? 'all',
          q: a.text,
        };
        const names = {
          person: new Map(s.people.map((p) => [p.id, p.name])),
          provider: new Map(s.providers.map((p) => [p.id, p.name])),
          category: new Map(s.categories.map((c) => [c.id, c.name])),
        };
        const rows = filterLedger(await ledger(), f, s.settings.year_basis, names);
        const receipts = rows.filter((e) => e.type === 'receipt');
        return text({
          count: rows.length,
          receipts_total: centsToDecimal(receipts.reduce((t, e) => t + (e.amount_cents ?? 0), 0)),
          entries: rows.slice(0, a.limit).map((e) => entryView(e, s)),
          ...(rows.length > a.limit ? { truncated: true } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_entry',
    { description: `One entry by id. ${MONEY_NOTE}`, inputSchema: z.object({ id: z.string() }) },
    async ({ id }) => {
      try {
        const [s, e] = await Promise.all([
          state(),
          call<LedgerEntry>('GET', `/entries/${encodeURIComponent(id)}`),
        ]);
        return text(entryView(e, s));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'list_review_queue',
    {
      description:
        'Entries waiting for review, with the reasons. Their amounts are not counted as reimbursable until approved.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const [s, r] = await Promise.all([
          state(),
          call<{ entries: LedgerEntry[]; document_ids: string[] }>('GET', '/review'),
        ]);
        return text({
          documents_waiting: r.document_ids.length,
          entries: r.entries.map((e) => entryView(e, s)),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'list_reimbursements',
    {
      description: 'Reimbursements recorded so far, newest first, with their totals.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const r = await call<{ reimbursements: Reimbursement[] }>('GET', '/reimbursements');
        return text(r.reimbursements.map((x) => ({ ...x, total: centsToDecimal(x.total_cents) })));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'mark_reimbursed',
    {
      description: `Record an HSA reimbursement covering these receipts (ids from list_entries). Only reimbursable receipts can be included; EOB lines can't. Returns the total, to compare with the HSA withdrawal. ${MONEY_NOTE}`,
      inputSchema: z.object({
        entry_ids: z.array(z.string()).min(1).max(500),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('Withdrawal date, YYYY-MM-DD'),
        note: z.string().max(300).optional(),
      }),
    },
    async (a) => {
      try {
        const r = await call<Reimbursement>('POST', '/reimbursements', {
          date: a.date,
          note: a.note ?? null,
          entry_ids: a.entry_ids,
        });
        return text({
          reimbursement_id: r.id,
          receipts: r.entry_count,
          total: centsToDecimal(r.total_cents),
          total_cents: r.total_cents,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'unmark_reimbursed',
    {
      description:
        'Take receipts out of their reimbursement (they become reimbursable again). A reimbursement left empty is removed.',
      inputSchema: z.object({ entry_ids: z.array(z.string()).min(1).max(500) }),
    },
    async ({ entry_ids }) => {
      try {
        const r = await call<{ changed: number }>('POST', '/entries/unreimburse', {
          ids: entry_ids,
        });
        return text(`Unmarked ${r.changed} receipt${r.changed === 1 ? '' : 's'}.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'update_entry',
    {
      description: `Correct an entry's fields. Money is given in integer cents (amount_cents: 4500 = $45.00). person, provider and category take a name or id. ${MONEY_NOTE}`,
      inputSchema: z.object({
        id: z.string(),
        service_date: z.string().nullable().optional(),
        payment_date: z.string().nullable().optional(),
        person: z.string().nullable().optional(),
        provider: z.string().nullable().optional(),
        category: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        amount_cents: z.number().int().nullable().optional(),
        card_last4: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    },
    async (a) => {
      try {
        const s = await state();
        const patch: Record<string, unknown> = {};
        for (const k of [
          'service_date',
          'payment_date',
          'description',
          'amount_cents',
          'card_last4',
          'notes',
        ] as const)
          if (a[k] !== undefined) patch[k] = a[k];
        if (a.person !== undefined)
          patch.person_id = a.person === null ? null : find(s.people, a.person, 'person');
        if (a.provider !== undefined)
          patch.provider_id =
            a.provider === null ? null : find(s.providers, a.provider, 'provider');
        if (a.category !== undefined)
          patch.category_id =
            a.category === null ? null : find(s.categories, a.category, 'category');
        await call('PATCH', `/entries/${encodeURIComponent(a.id)}`, patch);
        const e = await call<LedgerEntry>('GET', `/entries/${encodeURIComponent(a.id)}`);
        return text({ updated: entryView(e, s) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'approve_entry',
    {
      description:
        'Mark an entry in the review queue as checked. Its amount then counts as reimbursable (if it is an unreimbursed receipt that isn’t marked not claimable).',
      inputSchema: z.object({ id: z.string() }),
    },
    async ({ id }) => {
      try {
        await call('POST', `/entries/${encodeURIComponent(id)}/approve`);
        return text('Approved.');
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'exclude_entry',
    {
      description:
        'Mark a receipt not claimable (left out of reimbursable totals), with a reason: paid_with_hsa (already paid tax-free with the HSA card), not_eligible, or reimbursed_elsewhere. reason null makes it claimable again.',
      inputSchema: z.object({ id: z.string(), reason: excludedEnum.nullable() }),
    },
    async ({ id, reason }) => {
      try {
        await call('PATCH', `/entries/${encodeURIComponent(id)}`, { excluded_reason: reason });
        return text(reason ? `Marked not claimable (${reason}).` : 'Claimable again.');
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------------------------------------------------------- orientation

  server.registerTool(
    'get_started',
    {
      title: 'What can I do here?',
      description:
        'Call when someone asks what you can do with HSA Locker or how to start. Returns their current totals and open items, example requests that fit, and the ready-made prompts.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const [s, sum, review, reimb] = await Promise.all([
          state(),
          call<{ totals: Totals; this_year: YearTotals | null }>('GET', '/summary'),
          call<{ entries: LedgerEntry[]; document_ids: string[] }>('GET', '/review'),
          call<{ reimbursements: Reimbursement[] }>('GET', '/reimbursements'),
        ]);
        const t = sum.totals;
        const usd = (c: number) => `$${centsToDecimal(c)}`;
        const last = reimb.reimbursements[0];
        const lines = s.counts.documents
          ? [
              `${s.counts.documents} documents: ${t.receipt_count} receipts and ${t.eob_document_count} EOBs (${t.eob_line_count} EOB lines).`,
              `Reimbursable: ${usd(t.outstanding_cents)}. Reimbursed so far: ${usd(t.reimbursed_cents)}.`,
              sum.this_year
                ? `Documented in ${sum.this_year.year}: ${usd(sum.this_year.documented_cents)}.`
                : '',
              review.document_ids.length
                ? `Waiting for review: ${review.document_ids.length} document(s), ${usd(t.pending_review_cents)} not yet counted. Most common reasons: ${topReasons(review.entries)}.`
                : 'Nothing is waiting for review.',
              last
                ? `Last reimbursement: ${last.date}, ${usd(last.total_cents)}.`
                : 'No reimbursements recorded yet.',
              s.counts.in_flight ? `${s.counts.in_flight} document(s) are still being read.` : '',
              s.people.length ? `People: ${s.people.map((p) => p.name).join(', ')}.` : '',
              s.settings.hsa_cards.length
                ? `HSA cards on file (receipts paid with them are marked not claimable automatically): ${s.settings.hsa_cards.map((c) => `…${c}`).join(', ')}.`
                : 'No HSA card is on file in Settings.',
            ]
              .filter(Boolean)
              .join('\n')
          : 'Nothing is logged yet. The person adds receipts in the app (upload or email); then you can help with totals and reimbursements.';
        const examples = EXAMPLE_PROMPTS.map((e) => `- "${e.prompt}" — ${e.why}`).join('\n');
        const prompts = MCP_PROMPTS.map((p) => `- ${p.title} (${p.name}): ${p.does}`).join('\n');
        return text(
          `${lines}\n\nThings to offer (fill in <…> from the data above, and suggest the two or three that fit best):\n${examples}\n\nReady-made prompts the person can pick in their app's prompt menu:\n${prompts}`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------------------------------------------------------- prompts

  const ask = (t: string) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: t } }],
  });

  server.registerPrompt(
    'record_reimbursement',
    {
      title: 'Record a reimbursement',
      description:
        'Pick reimbursable receipts for an HSA withdrawal, confirm the list and total, then record it.',
      argsSchema: z.object({
        amount: z
          .string()
          .optional()
          .describe(
            'Optional: the withdrawal amount to match, e.g. 412.50. Leave empty to cover everything reimbursable.',
          ),
        date: z
          .string()
          .optional()
          .describe('Optional: the withdrawal date, YYYY-MM-DD (default today).'),
      }),
    },
    ({ amount, date }) =>
      ask(`Help me record an HSA reimbursement in HSA Locker${amount ? ` for $${amount}` : ''}${date ? ` dated ${date}` : ''}.

1. get_summary for the reimbursable total, then list_entries with status "outstanding" (reimbursable) and type "receipt" (limit 500).
2. ${amount ? `Pick receipts whose amounts add up exactly to $${amount}, oldest first. Add in cents. If no exact match exists, show the closest combinations and ask.` : 'Propose all reimbursable receipts, oldest first.'}
3. Show me the list (date, patient, provider, amount) and the total. Don't record anything until I confirm.
4. After I confirm, call mark_reimbursed with those entry ids and the date ${date || 'of today'}, then tell me the recorded total and the new reimbursable amount.`),
  );

  server.registerPrompt(
    'clear_review_queue',
    {
      title: 'Work through Review',
      description: 'Explain each flagged item, propose fixes, and approve them once you agree.',
      argsSchema: z.object({
        limit: z
          .string()
          .optional()
          .describe('Optional: how many items to go through (default 10).'),
      }),
    },
    ({ limit }) =>
      ask(`Help me clear the review queue in HSA Locker.

1. list_review_queue and take the first ${limit || '10'} entries.
2. For each, explain in one line what was flagged and why it matters (an amount not found in the document, an unknown patient, a possible duplicate…), and propose a fix: corrected fields, approve as is, or check it against the document in the app.
3. Show the proposals as a numbered list and ask which to apply. Don't change anything before I answer.
4. Apply the ones I accept with update_entry, then approve_entry. Tell me what's left and how much became reimbursable.`),
  );

  server.registerPrompt(
    'year_in_review',
    {
      title: 'Year in review',
      description:
        'Totals for a year by person, category and provider, plus what is still reimbursable.',
      argsSchema: z.object({ year: z.string().describe('The year to review, e.g. 2025.') }),
    },
    ({ year }) =>
      ask(`Give me a year in review for ${year} from HSA Locker.

1. get_summary with year ${year}.
2. list_entries with year ${year} and type "receipt" (limit 500). Total the amounts in cents by person, by category and by provider.
3. Report documented, reimbursed, not claimable, reimbursable and pending review; the top providers and categories; and the reimbursable receipts, oldest first.
4. End with one or two suggestions, such as reimbursing what's reimbursable or clearing Review. Don't change anything.`),
  );

  server.registerPrompt(
    'hsa_card_check',
    {
      title: 'Check HSA card receipts',
      description:
        'Find receipts paid with your HSA card that still count as reimbursable, and mark them not claimable after you confirm.',
      argsSchema: z.object({
        card_last4: z.string().describe('The last 4 digits of the HSA card.'),
      }),
    },
    ({ card_last4 }) =>
      ask(`Check HSA Locker for receipts paid with my HSA card ending ${card_last4}.

1. list_entries with text "${card_last4}" and type "receipt" (limit 500). Keep only receipts whose card_last4 is ${card_last4} and whose status is "outstanding" (reimbursable) or "needs_review".
2. Show me the list and the total. These were already paid from the HSA, so they shouldn't be reimbursed again. Ask before changing anything.
3. After I confirm, call exclude_entry for each with reason "paid_with_hsa".
4. Remind me to add ${card_last4} under Settings → Reimbursing → HSA cards so future receipts are marked not claimable automatically.`),
  );

  return server;
}

/** "unknown patient (3), possible duplicate (1)". */
function topReasons(entries: LedgerEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries)
    for (const r of e.review_reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return top.length
    ? top.map(([r, n]) => `${reviewLabel(r).toLowerCase()} (${n})`).join(', ')
    : 'document-level checks';
}

/** The OAuthProvider apiHandler for /mcp. Only reached with a valid token. */
export const mcpApiHandler = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const origin = new URL(request.url).origin;
    const call = apiCaller(origin, env, ctx);
    const handler = createMcpHandler(() => buildServer(call));
    return handler.fetch(request);
  },
};
