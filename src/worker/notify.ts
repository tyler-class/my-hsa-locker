// The optional daily review reminder. Sent with the Worker's send_email binding to an address the
// owner verified in Email Routing (Destination Addresses): free on every plan, no extra DNS. It
// comes from reminders@<inbox subdomain>, which already has Email Routing.
import { centsToDecimal } from '@shared/logic';
import { first, getSetting, loadSettings, REVIEW_DOC_WHERE, setSettingStmt } from './db';

/** Reminders go out after this hour (UTC), once a day: 13:00 UTC is 8–9am US Eastern. */
export const REMINDER_HOUR_UTC = 13;

export interface ReminderResult {
  sent: boolean;
  /** Why nothing was sent, or what went wrong. */
  reason?: string;
}

export function reminderMessage(o: {
  documents: number;
  pendingCents: number;
  origin: string | null;
  test?: boolean;
}) {
  const link = o.origin ? `${o.origin}/review` : null;
  const what = `${o.documents} document${o.documents === 1 ? '' : 's'}`;
  const subject = o.test
    ? 'HSA Locker: test reminder'
    : `HSA Locker: ${what} need${o.documents === 1 ? 's' : ''} review`;
  const lines = o.test
    ? ['This is a test of your daily HSA Locker review reminder. It works.']
    : [
        `${what} in HSA Locker need${o.documents === 1 ? 's' : ''} a quick look before ${o.documents === 1 ? 'it counts' : 'they count'} toward your totals.`,
        o.pendingCents > 0 ? `$${centsToDecimal(o.pendingCents)} is waiting for review.` : '',
      ].filter(Boolean);
  const text = [
    ...lines,
    '',
    link ? `Review: ${link}` : 'Open HSA Locker and go to Review.',
    '',
    'Turn these off in Settings → Daily reminder email.',
  ].join('\n');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<div style="font:15px/1.5 -apple-system,'Segoe UI',system-ui,sans-serif;color:#1a1a1a;max-width:480px">
${lines.map((l) => `<p style="margin:0 0 12px">${esc(l)}</p>`).join('\n')}
${link ? `<p style="margin:16px 0"><a href="${esc(link)}" style="display:inline-block;background:#2f5fd0;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px">Open Review</a></p>` : ''}
<p style="margin:16px 0 0;color:#8c8c8c;font-size:13px">Turn these off in HSA Locker → Settings → Daily reminder email.</p>
</div>`;
  return { subject, text, html };
}

/** Friendly words for the binding's error codes. */
function explain(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  const msg = e instanceof Error ? e.message : '';
  if (/RECIPIENT|destination/i.test(code + msg))
    return 'Cloudflare won’t send to that address yet. Add it in Email Routing under Destination Addresses and click the link in the verification email.';
  if (/SENDER|DOMAIN/i.test(code + msg))
    return 'Cloudflare won’t send from the inbox subdomain. Check that Email Routing is enabled for it.';
  if (/LIMIT/i.test(code)) return 'Cloudflare’s sending limit was reached. Try again later.';
  return 'Sending failed. Check Email Routing in the Cloudflare dashboard.';
}

/** Remembers the app's public address (seen on requests) for links in emails sent from cron. */
export async function rememberOrigin(db: D1Database, origin: string): Promise<void> {
  if (!origin.startsWith('https://')) return;
  if ((await getSetting(db, 'app_origin')) !== origin)
    await setSettingStmt(db, 'app_origin', origin).run();
}

/**
 * Sends the reminder if it's due: enabled, after the reminder hour, not sent yet today, and at
 * least one document needs review. `test` sends right away regardless.
 */
export async function sendReminder(
  env: Cloudflare.Env,
  { test = false, now = new Date() } = {},
): Promise<ReminderResult> {
  const db = env.DB;
  const s = await loadSettings(db);
  if (!s.notify_email) return { sent: false, reason: 'Add an email address first.' };
  if (!s.inbox_domain)
    return { sent: false, reason: 'Set up the email inbox first: reminders are sent from it.' };
  const today = now.toISOString().slice(0, 10);
  if (!test) {
    if (!s.notify_daily) return { sent: false, reason: 'off' };
    if (now.getUTCHours() < REMINDER_HOUR_UTC) return { sent: false, reason: 'not_yet' };
    if ((await getSetting(db, 'notify_last_sent')) === today)
      return { sent: false, reason: 'already_sent' };
  }
  const counts = await first<{ docs: number; cents: number }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM documents d WHERE ${REVIEW_DOC_WHERE}) AS docs,
       (SELECT COALESCE(SUM(e.amount_cents), 0) FROM entries e JOIN documents d ON d.id = e.document_id
          WHERE d.status != 'discarded' AND e.type = 'receipt' AND e.review_reasons_json != '[]'
            AND e.reimbursement_id IS NULL AND e.excluded_reason IS NULL) AS cents`,
  );
  const documents = Number(counts?.docs ?? 0);
  if (!test && documents === 0) return { sent: false, reason: 'nothing_to_review' };

  const msg = reminderMessage({
    documents,
    pendingCents: Number(counts?.cents ?? 0),
    origin: await getSetting(db, 'app_origin'),
    test,
  });
  try {
    await env.EMAIL.send({
      from: { name: 'HSA Locker', email: `reminders@${s.inbox_domain}` },
      to: s.notify_email,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
  } catch (e) {
    console.warn(`reminder: send failed (${(e as { code?: string })?.code ?? 'error'})`);
    return { sent: false, reason: explain(e) };
  }
  if (!test) await setSettingStmt(db, 'notify_last_sent', today).run();
  return { sent: true };
}
