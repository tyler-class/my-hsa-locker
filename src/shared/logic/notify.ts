// What HSA Locker's push notifications say and when, as pure functions: "Needs review" and
// "Couldn't read a document" once per document, the Reimbursable milestone, Year-end, Email inbox
// problems and the Weekly summary, plus the app-icon count (documents in Review, the same number
// as the Review tab). Sending, the 8 a.m. to 9 p.m. window and the sent log are the Selfhost
// Kit's (src/worker/kit/push.ts); loading is src/worker/notifications.ts. The daily email is
// src/worker/notify.ts.
import { reviewLabel } from '../lookups';
import type { DocKind } from '../types';
import { formatCents } from './money';
import { summarize } from './summary';

/** The kinds of notification, each with its own switch in Settings. */
export const NOTIFY_KINDS = [
  {
    id: 'review',
    label: 'Needs review',
    description: 'When a document needs a look after it’s read.',
  },
  {
    id: 'failed',
    label: 'Couldn’t read a document',
    description: 'When a document can’t be read after retries.',
  },
  {
    id: 'milestone',
    label: 'Reimbursable milestone',
    description: 'When Reimbursable reaches the amount below.',
  },
  {
    id: 'year_end',
    label: 'Year-end',
    description: 'December 1: what’s still reimbursable this year.',
  },
  {
    id: 'inbox',
    label: 'Email inbox problem',
    description: 'Rejected mail, or a forwarding code to enter.',
  },
  {
    id: 'weekly',
    label: 'Weekly summary',
    description: 'Sunday morning: what was added that week.',
  },
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number]['id'];

/** What the app-icon count counts, for the ⓘ in Settings. */
export const BADGE_MEANS = 'how many documents are waiting in Review';

/** Notifications wait outside these hours (local time on each device): 8 a.m. to 9 p.m. */
export const NOTIFY_FROM_HOUR = 8;
export const NOTIFY_UNTIL_HOUR = 21;

/** Documents read longer ago than this never notify (a device turned back on, a cron outage). */
export const NOTIFY_LOOKBACK_DAYS = 3;

/** A document in Review, as the notification needs it. */
export interface ReviewDoc {
  id: string;
  kind: DocKind | null;
  filename: string;
  /** When reading it finished (ISO). Null: never read (imported, typed in). */
  processed_at: string | null;
  /** The document's own reasons, then each entry's, in order. */
  reasons: string[];
  /** The provider on its first entry that has one. */
  provider: string | null;
  /** Reading gave up on it (the document's own reasons include extraction_failed). */
  failed?: boolean;
}

export interface Notice {
  kind: NotifyKind;
  /** The documents it's about, sorted and joined: the kit's sent log keeps it, once per document. */
  key: string;
  title: string;
  body: string;
  url: string;
  tag: string;
}

const KEY_SEP = ' ';

/** The sent-log key for a set of documents. */
export const reviewKey = (ids: readonly string[]) => [...ids].sort().join(KEY_SEP);

/** Every document id already in a device's sent-log keys. */
export function notifiedIds(keys: readonly string[]): Set<string> {
  return new Set(keys.flatMap((k) => k.split(KEY_SEP)).filter(Boolean));
}

/**
 * The documents a device hasn't heard about yet: read after the device signed up (and within
 * the last few days), and not in an earlier notification to it.
 */
export function pendingReview(
  docs: readonly ReviewDoc[],
  o: { notified: ReadonlySet<string>; deviceSince: string; now: Date },
): ReviewDoc[] {
  const lookback = new Date(o.now.getTime() - NOTIFY_LOOKBACK_DAYS * 86_400_000).toISOString();
  const since = o.deviceSince > lookback ? o.deviceSince : lookback;
  const until = o.now.toISOString();
  return docs.filter(
    (d) =>
      d.processed_at && d.processed_at >= since && d.processed_at <= until && !o.notified.has(d.id),
  );
}

const KIND_WORD: Record<DocKind, string> = { receipt: 'Receipt', eob: 'EOB', unknown: 'Document' };

/** "Amount looks wrong" → "amount looks wrong" (keeps "EOB", "PDF" and the like). */
function lower(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** "Receipt from Lakeside Pediatrics: amount looks wrong". */
export function docLine(d: ReviewDoc): string {
  const what = d.provider
    ? `${KIND_WORD[d.kind ?? 'unknown']} from ${d.provider}`
    : d.kind && d.kind !== 'unknown'
      ? KIND_WORD[d.kind]
      : d.filename;
  const [first, ...rest] = [...new Set(d.reasons)];
  if (!first) return `${what} needs review`;
  const more = rest.length ? `, and ${rest.length} more` : '';
  return `${what}: ${lower(reviewLabel(first))}${more}`;
}

/** One notification for the documents a device hasn't heard about, or null when there are none. */
export function reviewNotice(docs: readonly ReviewDoc[]): Notice | null {
  if (!docs.length) return null;
  const ids = docs.map((d) => d.id);
  const one = docs.length === 1 ? docs[0]! : null;
  return {
    kind: 'review',
    key: reviewKey(ids),
    title: 'Needs review',
    body: one ? docLine(one) : `${docs.length} documents need review`,
    url: one ? `/review/${one.id}` : '/review',
    tag: `review-${[...ids].sort()[0]}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Couldn't read a document: reading gave up on it after its retries (kept apart from Needs
// review; the Review screen is where these documents show).

/** One notification for documents reading gave up on, or null when there are none. */
export function failedNotice(docs: readonly ReviewDoc[]): Notice | null {
  if (!docs.length) return null;
  const ids = docs.map((d) => d.id);
  const one = docs.length === 1 ? docs[0]! : null;
  return {
    kind: 'failed',
    key: reviewKey(ids),
    title: one ? 'Couldn’t read a document' : 'Couldn’t read documents',
    body: one ? `Couldn’t read ${one.filename}.` : `Couldn’t read ${docs.length} documents.`,
    url: one ? `/review/${one.id}` : '/review',
    tag: `failed-${[...ids].sort()[0]}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Dates and money for the words

/** The date ("2026-12-01") in a time zone at an instant. */
export function localDay(at: Date, tz: string): string {
  let zone = tz;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-11-08" plus n days. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 for Sunday … 6 for Saturday. */
export const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

/** "$512" for whole dollars, "$213.40" otherwise: Home's amounts, without a bare ".00". */
export const notifyMoney = (cents: number) => formatCents(cents).replace(/\.00$/, '');

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

// ---------------------------------------------------------------------------------------------
// Reimbursable milestone: Home's Reimbursable total reaching an amount the household sets.
// Once per crossing from below to at or above it; dropping below (a reimbursement) re-arms it.

/** The amount, until someone changes it in Settings → Notifications. */
export const MILESTONE_DEFAULT_CENTS = 50_000;

/** Where the total was last seen: above the amount since when (null: already above at first look). */
export interface MilestoneState {
  above: boolean;
  since: string | null;
}

/**
 * The next state after seeing the total. Crossing up starts a crossing (since = now); dropping
 * below re-arms. The first look only records where it is: an install already over the amount
 * doesn't announce it.
 */
export function milestoneStep(
  prev: MilestoneState | null,
  totalCents: number,
  amountCents: number,
  now: Date,
): MilestoneState {
  const above = amountCents > 0 && totalCents >= amountCents;
  if (!prev) return { above, since: null };
  if (!above) return { above: false, since: null };
  if (prev.above) return prev;
  return { above: true, since: now.toISOString() };
}

/**
 * The milestone notification for a device: a crossing it hasn't heard about, that happened
 * after it signed up and within the last few days. Null otherwise.
 */
export function milestoneNotice(
  state: MilestoneState,
  o: { totalCents: number; sentKeys: ReadonlySet<string>; deviceSince: string; now: Date },
): Notice | null {
  if (!state.above || !state.since) return null;
  const lookback = new Date(o.now.getTime() - NOTIFY_LOOKBACK_DAYS * 86_400_000).toISOString();
  if (state.since < o.deviceSince || state.since < lookback || o.sentKeys.has(state.since))
    return null;
  return {
    kind: 'milestone',
    key: state.since,
    title: 'Reimbursable',
    body: `You have ${notifyMoney(o.totalCents)} reimbursable. Time to pay yourself back?`,
    url: '/ledger?status=outstanding',
    tag: 'milestone',
  };
}

// ---------------------------------------------------------------------------------------------
// Year-end: December 1, what's still reimbursable from this year (Home's per-year Reimbursable).

/** On December 1 (the device's date), if anything from that year is still reimbursable. */
export function yearEndNotice(
  today: string,
  years: readonly { year: number | null; outstanding_cents: number }[],
): Notice | null {
  if (today.slice(5) !== '12-01') return null;
  const year = Number(today.slice(0, 4));
  const cents = years.find((y) => y.year === year)?.outstanding_cents ?? 0;
  if (cents <= 0) return null;
  return {
    kind: 'year_end',
    key: String(year),
    title: 'Year-end',
    body: `You have ${notifyMoney(cents)} reimbursable from ${year}.`,
    url: `/ledger?year=${year}&status=outstanding`,
    tag: `year-end-${year}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Weekly summary: Sunday morning, receipts added the Sunday to Saturday before.

type WeekEntry = Parameters<typeof summarize>[0][number] & { created_at: string };

/** On Sundays (the device's date): receipts added last week and their total. Null otherwise. */
export function weeklyNotice(
  entries: readonly WeekEntry[],
  o: { now: Date; tz: string },
): Notice | null {
  const today = localDay(o.now, o.tz);
  if (weekday(today) !== 0) return null;
  const from = addDays(today, -7);
  const week = entries.filter((e) => {
    if (e.type !== 'receipt') return false;
    const d = localDay(new Date(e.created_at), o.tz);
    return d >= from && d < today;
  });
  const { all } = summarize(week, 'service_date');
  if (!all.receipt_count) return null;
  return {
    kind: 'weekly',
    key: today,
    title: 'Weekly summary',
    body: `This week: ${all.receipt_count} ${plural(all.receipt_count, 'receipt')} added, ${notifyMoney(all.documented_cents)}.`,
    url: '/ledger?sort=added_desc',
    tag: 'weekly',
  };
}

// ---------------------------------------------------------------------------------------------
// Email inbox problems: forwarded mail rejected or not saved, the daily limit, and forwarding
// codes waiting. One notification per problem a day, each email once.

export type InboxProblem =
  'verification' | 'daily_cap' | 'too_large' | 'sender_not_allowed' | 'failed';

/** An inbox log row or a waiting forwarding confirmation. */
export interface InboxEvent {
  id: string;
  /** When it arrived (ISO). */
  at: string;
  problem: InboxProblem;
  /** Forwarding confirmations: "Gmail". */
  provider?: string | null;
  /** Forwarding confirmations: whether there's a code (otherwise just a link). */
  code?: boolean;
}

/**
 * What an inbox log row's outcome means. Mail to a wrong address (spam) and a paused inbox
 * aren't problems to notify about.
 */
export function inboxProblem(outcome: string, reason: string | null): InboxProblem | null {
  if (outcome === 'failed') return 'failed';
  if (outcome !== 'rejected') return null;
  return reason === 'daily_cap' || reason === 'too_large' || reason === 'sender_not_allowed'
    ? reason
    : null;
}

/** The sent-log key for one problem's events: "daily_cap a b c". */
export const inboxKey = (problem: InboxProblem, ids: readonly string[]) =>
  `${problem}${KEY_SEP}${reviewKey(ids)}`;

/** The problem a sent-log key is about. */
export const inboxKeyProblem = (key: string) => key.split(KEY_SEP)[0] as InboxProblem;

/**
 * Inbox events a device hasn't heard about: after it signed up, within the last few days, not
 * in an earlier notification, and of a problem it hasn't already been told about today.
 */
export function pendingInbox(
  events: readonly InboxEvent[],
  o: {
    notified: ReadonlySet<string>;
    sentToday: ReadonlySet<InboxProblem>;
    deviceSince: string;
    now: Date;
  },
): InboxEvent[] {
  const lookback = new Date(o.now.getTime() - NOTIFY_LOOKBACK_DAYS * 86_400_000).toISOString();
  const since = o.deviceSince > lookback ? o.deviceSince : lookback;
  const until = o.now.toISOString();
  return events.filter(
    (e) => e.at >= since && e.at <= until && !o.notified.has(e.id) && !o.sentToday.has(e.problem),
  );
}

const REJECTED_WHY: Record<Exclude<InboxProblem, 'verification' | 'failed'>, string> = {
  daily_cap: 'daily limit reached',
  too_large: 'too large',
  sender_not_allowed: 'sender not on the allow list',
};

const INBOX_ORDER: InboxProblem[] = [
  'verification',
  'daily_cap',
  'too_large',
  'sender_not_allowed',
  'failed',
];

/** One notification per problem for a device's pending inbox events, in a fixed order. */
export function inboxNotices(
  events: readonly InboxEvent[],
  o: { now: Date; tz: string },
): Notice[] {
  const today = localDay(o.now, o.tz);
  const out: Notice[] = [];
  for (const problem of INBOX_ORDER) {
    const es = events.filter((e) => e.problem === problem);
    if (!es.length) continue;
    const n = es.length;
    // Held overnight, they arrive the next morning: "today" only when it was.
    const when = es.every((e) => localDay(new Date(e.at), o.tz) === today) ? ' today' : '';
    let body: string;
    if (problem === 'verification') {
      const latest = [...es].sort((a, b) => b.at.localeCompare(a.at))[0]!;
      const who = latest.provider || 'Your email provider';
      const where = latest.provider || 'your email settings';
      body = latest.code
        ? `${who} sent a forwarding code. Enter it in ${where} to finish setup.`
        : `${who} sent a forwarding confirmation. Open it in Settings to finish setup.`;
    } else if (problem === 'failed') {
      body = `${n === 1 ? 'An email' : `${n} emails`} couldn’t be read${when}.`;
    } else {
      body = `${n === 1 ? 'An email was' : `${n} emails were`} rejected${when}: ${REJECTED_WHY[problem]}.`;
    }
    out.push({
      kind: 'inbox',
      key: inboxKey(
        problem,
        es.map((e) => e.id),
      ),
      title: 'Email inbox',
      body,
      url: '/settings/inbox',
      tag: `inbox-${problem}`,
    });
  }
  return out;
}
