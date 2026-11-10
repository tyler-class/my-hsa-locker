// HSA Locker's push notifications on top of the Selfhost Kit's push (src/worker/kit/push.ts):
// Needs review, Couldn't read a document, the Reimbursable milestone, Year-end, Email inbox
// problems and the Weekly summary, and the app-icon count. The words and rules are in
// src/shared/logic/notify.ts; this file loads what they need. (The daily email is ./notify.ts.)
import {
  failedNotice,
  inboxKeyProblem,
  inboxNotices,
  inboxProblem,
  localDay,
  milestoneNotice,
  milestoneStep,
  notifiedIds,
  NOTIFY_FROM_HOUR,
  NOTIFY_KINDS,
  NOTIFY_LOOKBACK_DAYS,
  NOTIFY_UNTIL_HOUR,
  pendingInbox,
  pendingReview,
  reviewNotice,
  summarize,
  weekday,
  weeklyNotice,
  yearEndNotice,
  type InboxEvent,
  type MilestoneState,
  type Notice,
  type ReviewDoc,
} from '@shared/logic';
import type { DocKind, LedgerEntry } from '@shared/types';
import { all, first, getSetting, loadSettings, REVIEW_DOC_WHERE } from './db';
import {
  pushRoutes,
  runPushJob,
  wants,
  type PushCandidate,
  type PushDevice,
  type PushJobOptions,
} from './kit/push';
import { loadLedger } from './routes/entries';

const ICON = '/pwa-192x192.png';

const arr = (s: unknown): string[] => {
  try {
    const v = JSON.parse(String(s ?? '[]')) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** The documents in Review (what the Review screen shows), with their reasons and provider. */
export async function loadReviewDocs(db: D1Database): Promise<ReviewDoc[]> {
  const docs = await all<{
    id: string;
    kind: DocKind | null;
    filename: string;
    processed_at: string | null;
    review_reasons_json: string;
    extraction_provider: string | null;
  }>(
    db,
    `SELECT d.id, d.kind, d.filename, d.processed_at, d.review_reasons_json, d.extraction_provider
     FROM documents d WHERE ${REVIEW_DOC_WHERE} ORDER BY d.received_at`,
  );
  const entries = await all<{ document_id: string; review_reasons_json: string; provider: string }>(
    db,
    `SELECT e.document_id, e.review_reasons_json, COALESCE(p.name, e.provider_name_raw) AS provider
     FROM entries e LEFT JOIN providers p ON p.id = e.provider_id
     WHERE e.document_id IN (SELECT d.id FROM documents d WHERE ${REVIEW_DOC_WHERE})
     ORDER BY e.document_id, e.sort_order`,
  );
  const byDoc = new Map<string, typeof entries>();
  for (const e of entries) byDoc.set(e.document_id, [...(byDoc.get(e.document_id) ?? []), e]);
  return docs.map((d) => {
    const es = byDoc.get(d.id) ?? [];
    return {
      id: d.id,
      kind: d.kind,
      filename: d.filename,
      // Imported from HSA Wizard: never read here, so never "just processed".
      processed_at: d.extraction_provider === 'hsa-wizard' ? null : d.processed_at,
      reasons: [...arr(d.review_reasons_json), ...es.flatMap((e) => arr(e.review_reasons_json))],
      provider: es.find((e) => e.provider)?.provider ?? null,
      failed: arr(d.review_reasons_json).includes('extraction_failed'),
    };
  });
}

/** Forwarding problems and waiting forwarding codes from the last few days. */
export async function loadInboxEvents(db: D1Database, now: Date): Promise<InboxEvent[]> {
  const since = new Date(now.getTime() - NOTIFY_LOOKBACK_DAYS * 86_400_000).toISOString();
  const [log, codes] = await Promise.all([
    all<{ id: string; received_at: string; outcome: string; reason: string | null }>(
      db,
      `SELECT id, received_at, outcome, reason FROM inbox_log
       WHERE received_at >= ? AND outcome IN ('rejected', 'failed')`,
      since,
    ),
    all<{ id: string; received_at: string; provider: string; code: string | null }>(
      db,
      `SELECT id, received_at, provider, code FROM inbox_verifications
       WHERE dismissed_at IS NULL AND received_at >= ?`,
      since,
    ),
  ]);
  const out: InboxEvent[] = [];
  for (const r of log) {
    const problem = inboxProblem(r.outcome, r.reason);
    if (problem) out.push({ id: r.id, at: r.received_at, problem });
  }
  for (const v of codes)
    out.push({
      id: v.id,
      at: v.received_at,
      problem: 'verification',
      provider: v.provider,
      code: !!v.code,
    });
  return out;
}

const MILESTONE_STATE = 'notify_milestone_state';

/**
 * Looks at Home's Reimbursable total and moves the milestone along (see milestoneStep). Only
 * the run that changes the stored state wins, so two runs at once can't start two crossings.
 */
async function milestone(db: D1Database, totalCents: number, now: Date): Promise<MilestoneState> {
  const [raw, settings] = await Promise.all([getSetting(db, MILESTONE_STATE), loadSettings(db)]);
  let prev: MilestoneState | null;
  try {
    prev = raw ? (JSON.parse(raw) as MilestoneState) : null;
  } catch {
    prev = null;
  }
  const next = milestoneStep(prev, totalCents, settings.notify_milestone_cents, now);
  if (raw && JSON.stringify(next) === raw) return next;
  const value = JSON.stringify(next);
  const res = raw
    ? await db
        .prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
        .bind(value, MILESTONE_STATE, raw)
        .run()
    : await db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .bind(MILESTONE_STATE, value)
        .run();
  if (res.meta.changes) return next;
  // Another run got there first: use what it stored.
  const won = await getSetting(db, MILESTONE_STATE);
  return won ? (JSON.parse(won) as MilestoneState) : next;
}

/** What this device has been sent (the kit's sent log; see the README). */
async function sentLog(db: D1Database, device: PushDevice) {
  return all<{ kind: string; key: string; date: string }>(
    db,
    `SELECT kind, key, date FROM selfhost_push_sent WHERE device_id = ?`,
    device.id,
  );
}

const candidate = (n: Notice): PushCandidate => ({
  kind: n.kind,
  key: n.key,
  message: { title: n.title, body: n.body, url: n.url, tag: n.tag },
});

/** The notifications a device could get now, and its badge count. */
export function hsaPush(db: D1Database): Pick<PushJobOptions, 'build' | 'badge'> {
  // Each loaded once per run (or request), not once per device, and only if a device wants it.
  let docs: Promise<ReviewDoc[]> | null = null;
  let ledger: Promise<LedgerEntry[]> | null = null;
  let inbox: Promise<InboxEvent[]> | null = null;
  let mile: Promise<{ state: MilestoneState; total: number }> | null = null;
  const loadDocs = () => (docs ??= loadReviewDocs(db));
  const loadAll = () => (ledger ??= loadLedger(db));
  const loadInbox = (now: Date) => (inbox ??= loadInboxEvents(db, now));
  const loadMilestone = (now: Date) =>
    (mile ??= loadAll().then(async (l) => {
      // Home's Reimbursable: summarize() over the same ledger the Home screen reads.
      const total = summarize(l, 'service_date').all.outstanding_cents;
      return { state: await milestone(db, total, now), total };
    }));

  return {
    async build(device, now) {
      const out: Notice[] = [];
      const log = await sentLog(db, device);
      const keys = (kind: string) => log.filter((r) => r.kind === kind).map((r) => r.key);
      const today = localDay(now, device.tz);
      const since = device.created_at;

      if (wants(device, 'review') || wants(device, 'failed')) {
        const d = await loadDocs();
        const review = pendingReview(
          d.filter((x) => !x.failed),
          { notified: notifiedIds(keys('review')), deviceSince: since, now },
        );
        // A document already announced as Needs review (before this kind existed) isn't repeated.
        const failed = pendingReview(
          d.filter((x) => x.failed),
          {
            notified: notifiedIds([...keys('failed'), ...keys('review')]),
            deviceSince: since,
            now,
          },
        );
        const r = wants(device, 'review') && reviewNotice(review);
        const f = wants(device, 'failed') && failedNotice(failed);
        if (r) out.push(r);
        if (f) out.push(f);
      }

      if (wants(device, 'milestone')) {
        const m = await loadMilestone(now);
        const n = milestoneNotice(m.state, {
          totalCents: m.total,
          sentKeys: new Set(keys('milestone')),
          deviceSince: since,
          now,
        });
        if (n) out.push(n);
      }

      if (wants(device, 'year_end') && today.slice(5) === '12-01') {
        const n = yearEndNotice(today, summarize(await loadAll(), 'service_date').years);
        if (n) out.push(n);
      }

      if (wants(device, 'weekly') && weekday(today) === 0) {
        const n = weeklyNotice(await loadAll(), { now, tz: device.tz });
        if (n) out.push(n);
      }

      if (wants(device, 'inbox')) {
        const sentToday = new Set(
          log
            .filter((r) => r.kind === 'inbox' && r.date === today)
            .map((r) => inboxKeyProblem(r.key)),
        );
        const pending = pendingInbox(await loadInbox(now), {
          notified: notifiedIds(keys('inbox')),
          sentToday,
          deviceSince: since,
          now,
        });
        out.push(...inboxNotices(pending, { now, tz: device.tz }));
      }

      return out.map(candidate);
    },
    async badge() {
      return (await loadDocs()).length;
    },
  };
}

/**
 * Sends what's due: from the cron (every 10 minutes; it also lets notifications held overnight
 * out at 8 a.m.) and right after documents are read. Between 9 p.m. and 8 a.m. on a device,
 * nothing goes out; what's waiting then goes as one notification at 8. Never throws.
 */
export function runNotifications(db: D1Database, o: Partial<PushJobOptions> = {}) {
  return runPushJob(db, {
    ...hsaPush(db),
    icon: ICON,
    hour: NOTIFY_FROM_HOUR,
    until: NOTIFY_UNTIL_HOUR,
    ...o,
  });
}

/**
 * After a document is read, or the inbox records a problem: notify now, unless more documents
 * are being read or are queued, so a batch (an email with several attachments, a multi-file
 * upload, a sweep) becomes one notification sent when the last one finishes. The cron catches
 * anything left over.
 */
export async function notifyWhenIdle(db: D1Database, o: Partial<PushJobOptions> = {}) {
  try {
    const now = new Date().toISOString();
    // 10 minutes: the pipeline's STALE_MINUTES (a claim older than that is abandoned).
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const busy = await first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM documents WHERE
         (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (status = 'processing' AND updated_at >= ?)`,
      now,
      stale,
    );
    if (Number(busy?.n ?? 0) > 0) return null;
    return await runNotifications(db, o);
  } catch (e) {
    console.warn('push: after-reading run failed', e);
    return null;
  }
}

/** /api/push/*: behind HSA Locker's sign-in (mounted after the guard in app.ts). */
export const push = pushRoutes({
  title: 'HSA Locker',
  kinds: NOTIFY_KINDS.map((k) => k.id),
  icon: ICON,
  fallbackSubject: 'mailto:hsalocker@tylerclass.net',
  badge: (device, now, db) => hsaPush(db).badge!(device, now, db),
});
