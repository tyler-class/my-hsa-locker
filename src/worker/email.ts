// Inbound email. The email() handler stays minimal (the free plan allows ~10 ms CPU): it checks
// the recipient and limits, streams the raw message to R2 and logs it as 'received'. Parsing
// (postal-mime), verification detection and creating documents happen afterwards in
// processInboxMessage, kicked with waitUntil and retried by the cron sweeper.
import PostalMime, { type Email } from 'postal-mime';
import { detectVerification, inboxProblem, keepPart, mimeFromName } from '@shared/logic';
import { all, first, getInboxToken, loadSettings, newId, nowIso } from './db';
import { processDocument } from './extract/pipeline';
import { htmlToText } from './extract/text';
import { notifyWhenIdle } from './notifications';
import { cleanFilename, storeDocument } from './store';

/** Cloudflare Email Routing's own limit is 25 MiB. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const MAX_PARSE_ATTEMPTS = 3;

export interface IncomingMessage {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  setReject(reason: string): void;
}

async function logInbox(
  db: D1Database,
  row: {
    to: string;
    from: string;
    subject: string | null;
    outcome: string;
    reason?: string | null;
    size?: number;
    emlKey?: string | null;
  },
): Promise<string> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO inbox_log (id, received_at, to_addr, from_addr, subject, outcome, reason, eml_key, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      nowIso(),
      row.to,
      row.from,
      row.subject?.slice(0, 300) ?? null,
      row.outcome,
      row.reason ?? null,
      row.emlKey ?? null,
      row.size ?? null,
    )
    .run();
  return id;
}

function startOfTodayIso(): string {
  return new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
}

/** The Worker's email() handler. */
export async function handleEmail(
  message: IncomingMessage,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): Promise<void> {
  const db = env.DB;
  const to = message.to.trim().toLowerCase();
  const from = message.from.trim().toLowerCase();
  const subject = message.headers.get('subject');
  const local = to.split('@')[0] ?? '';
  const [token, settings] = await Promise.all([getInboxToken(db), loadSettings(db)]);

  const reject = async (reason: string, smtp: string) => {
    await logInbox(db, { to, from, subject, outcome: 'rejected', reason, size: message.rawSize });
    message.setReject(smtp);
    // An Email inbox problem push (daily limit, too large, sender not allowed), once the reply's out.
    if (inboxProblem('rejected', reason)) ctx.waitUntil(notifyWhenIdle(db));
  };

  // The unguessable token is the gate; a catch-all is never relied on.
  if (local !== token) return reject('unknown_recipient', 'unknown recipient');
  if (settings.inbox_domain && !to.endsWith(`@${settings.inbox_domain}`))
    return reject('unknown_recipient', 'unknown recipient');
  if (settings.inbox_paused) return reject('paused', 'mailbox unavailable');
  if (message.rawSize > Math.min(MAX_MESSAGE_BYTES, settings.inbox_max_mb * 1024 * 1024))
    return reject('too_large', 'message too large');
  // Optional and secondary: auto-forwarded mail keeps the original sender, so it can't be the gate.
  if (settings.inbox_allowlist.length) {
    const ok = settings.inbox_allowlist.some((a) =>
      a.startsWith('@') ? from.endsWith(a) : from === a || from.endsWith(`@${a}`),
    );
    if (!ok) return reject('sender_not_allowed', 'sender not allowed');
  }
  const today = await first<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM inbox_log WHERE received_at >= ? AND outcome IN ('received', 'accepted', 'duplicate')",
    startOfTodayIso(),
  );
  if ((today?.n ?? 0) >= settings.inbox_daily_cap) return reject('daily_cap', 'try again tomorrow');

  // Log first, so a failure storing the message still shows up in Settings → Receipt forwarding address.
  const id = newId();
  const emlKey = `eml/${id}.eml`;
  await db
    .prepare(
      `INSERT INTO inbox_log (id, received_at, to_addr, from_addr, subject, outcome, eml_key, size_bytes)
       VALUES (?, ?, ?, ?, ?, 'received', ?, ?)`,
    )
    .bind(id, nowIso(), to, from, subject?.slice(0, 300) ?? null, emlKey, message.rawSize)
    .run();
  try {
    // Read the whole message (≤ 25 MiB) and store it; parsing happens afterwards.
    const raw = await new Response(message.raw).arrayBuffer();
    await env.FILES.put(emlKey, raw, { httpMetadata: { contentType: 'message/rfc822' } });
  } catch (e) {
    console.error(
      `inbox ${id}: storing the message failed (${e instanceof Error ? e.name : 'error'})`,
    );
    await db
      .prepare("UPDATE inbox_log SET outcome = 'failed', reason = 'store_failed' WHERE id = ?")
      .bind(id)
      .run();
    ctx.waitUntil(notifyWhenIdle(db));
    throw e;
  }
  ctx.waitUntil(processInboxMessage(env, id).catch(() => {}));
}

async function parseNested(content: ArrayBuffer | Uint8Array | string): Promise<Email | null> {
  try {
    return await PostalMime.parse(content as ArrayBuffer);
  } catch {
    return null;
  }
}

interface Part {
  filename: string | null;
  mimeType: string;
  disposition: 'attachment' | 'inline' | null;
  contentId: string | null;
  bytes: Uint8Array;
}

const toBytes = (c: ArrayBuffer | Uint8Array | string): Uint8Array =>
  typeof c === 'string'
    ? new TextEncoder().encode(c)
    : c instanceof Uint8Array
      ? c
      : new Uint8Array(c);

/** All attachment parts, descending into forwarded messages (up to 3 levels). */
async function collectParts(email: Email, depth = 0): Promise<{ parts: Part[]; bodies: Email[] }> {
  const parts: Part[] = [];
  const bodies: Email[] = [email];
  for (const a of email.attachments) {
    if (a.mimeType === 'message/rfc822' && depth < 3) {
      const nested = await parseNested(a.content);
      if (nested) {
        const sub = await collectParts(nested, depth + 1);
        parts.push(...sub.parts);
        bodies.push(...sub.bodies);
      }
      continue;
    }
    parts.push({
      filename: a.filename ?? null,
      mimeType: (
        a.mimeType ||
        mimeFromName(a.filename ?? '') ||
        'application/octet-stream'
      ).toLowerCase(),
      disposition: (a.disposition as Part['disposition']) ?? null,
      contentId: a.contentId ?? null,
      bytes: toBytes(a.content),
    });
  }
  return { parts, bodies };
}

/** Parses a stored message into documents. Idempotent: only 'received' messages are taken. */
export async function processInboxMessage(env: Cloudflare.Env, logId: string): Promise<void> {
  const db = env.DB;
  const claimed = await first<{
    id: string;
    eml_key: string;
    from_addr: string;
    to_addr: string;
    received_at: string;
    attempts: number;
  }>(
    db,
    `UPDATE inbox_log SET attempts = attempts + 1 WHERE id = ? AND outcome = 'received' AND attempts < ?
     RETURNING id, eml_key, from_addr, to_addr, received_at, attempts`,
    logId,
    MAX_PARSE_ATTEMPTS,
  );
  if (!claimed) return;
  const finish = (outcome: string, reason: string | null, attachments = 0, docs = 0) =>
    db
      .prepare(
        'UPDATE inbox_log SET outcome = ?, reason = ?, attachment_count = ?, document_count = ? WHERE id = ?',
      )
      .bind(outcome, reason, attachments, docs, logId)
      .run();

  try {
    const obj = await env.FILES.get(claimed.eml_key);
    if (!obj) return void (await finish('failed', 'eml_missing'));
    const raw = await obj.arrayBuffer();
    const email = await PostalMime.parse(raw);
    const settings = await loadSettings(db);
    const fromAddr = (email.from?.address ?? claimed.from_addr ?? '').toLowerCase();
    const subject = email.subject ?? '';

    // Forwarding confirmations are surfaced in Settings → Receipt forwarding address, never processed as documents.
    const verification = detectVerification({
      from: fromAddr,
      subject,
      text: email.text,
      html: email.html,
    });
    if (verification) {
      await db
        .prepare(
          'INSERT INTO inbox_verifications (id, received_at, provider, from_addr, subject, code, link) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          newId(),
          claimed.received_at,
          verification.provider,
          fromAddr,
          subject.slice(0, 300),
          verification.code,
          verification.link,
        )
        .run();
      await finish('verification', verification.provider);
      // "Gmail sent a forwarding code": an Email inbox problem push.
      return void (await notifyWhenIdle(db));
    }

    const { parts, bodies } = await collectParts(email);
    const html = bodies.map((b) => b.html ?? '').join('\n');
    const referencedCids = new Set([...html.matchAll(/cid:([^"'\s>)]+)/gi)].map((m) => m[1]!));
    const minBytes = settings.inbox_min_kb * 1024;
    const kept = parts.filter(
      (p) => keepPart({ ...p, size: p.bytes.byteLength }, { minBytes, referencedCids }).keep,
    );
    const limited = kept.slice(0, settings.inbox_max_attachments);

    const meta = {
      from: fromAddr,
      to: claimed.to_addr,
      subject: subject.slice(0, 300),
      message_id: email.messageId ?? undefined,
      received_at: claimed.received_at,
    };
    const created: string[] = [];
    let duplicates = 0;
    let emlAttached = false;

    for (const p of limited) {
      const name = cleanFilename(p.filename, `attachment.${p.mimeType.split('/')[1] ?? 'bin'}`);
      const r = await storeDocument(env, {
        bytes: p.bytes,
        filename: name,
        mime: p.mimeType,
        source: 'email',
        meta: { ...meta, part_name: name },
        inboxLogId: logId,
        // The raw .eml is kept with the first document from each message, for provenance.
        emlKey: emlAttached ? null : claimed.eml_key,
        receivedAt: claimed.received_at,
      });
      if (r.ok) {
        created.push(r.id);
        emlAttached = true;
      } else duplicates++;
    }

    // Body-only receipts (online pharmacy etc.): store the body and read it as a document.
    if (!limited.length) {
      const bodyHtml = email.html ?? null;
      const bodyText = (bodyHtml ? htmlToText(bodyHtml) : (email.text ?? '')).trim();
      if (bodyText.length >= 40) {
        const isHtml = !!bodyHtml;
        const r = await storeDocument(env, {
          bytes: new TextEncoder().encode(isHtml ? bodyHtml! : bodyText),
          filename: cleanFilename(subject, 'email') + (isHtml ? '.html' : '.txt'),
          mime: isHtml ? 'text/html' : 'text/plain',
          source: 'email',
          meta: { ...meta, part_name: 'body' },
          inboxLogId: logId,
          emlKey: claimed.eml_key,
          receivedAt: claimed.received_at,
        });
        if (r.ok) {
          created.push(r.id);
          emlAttached = true;
        } else duplicates++;
      }
    }

    if (!emlAttached && !duplicates) {
      // Nothing usable: keep the message for the log, mark why.
      await finish(
        'ignored',
        parts.length ? 'no_usable_attachments' : 'empty_message',
        parts.length,
        0,
      );
      return;
    }
    if (!emlAttached) await env.FILES.delete(claimed.eml_key);
    await finish(
      created.length ? 'accepted' : 'duplicate',
      kept.length > limited.length ? 'too_many_attachments' : null,
      parts.length,
      created.length,
    );
    for (const id of created) await processDocument(env, id);
  } catch (e) {
    const code = e instanceof Error ? e.name : 'error';
    console.warn(`inbox ${logId}: parse attempt ${claimed.attempts} failed (${code})`);
    if (claimed.attempts >= MAX_PARSE_ATTEMPTS) {
      await finish('failed', 'parse_failed');
      await notifyWhenIdle(db);
    }
  }
}

/** Messages still waiting to be parsed (for the sweeper). */
export async function dueInboxMessages(db: D1Database, limit = 5): Promise<string[]> {
  return (
    await all<{ id: string }>(
      db,
      "SELECT id FROM inbox_log WHERE outcome = 'received' AND attempts < ? ORDER BY received_at LIMIT ?",
      MAX_PARSE_ATTEMPTS,
      limit,
    )
  ).map((r) => r.id);
}
