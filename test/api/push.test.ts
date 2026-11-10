// Push notifications in workerd: the Selfhost Kit's crypto (RFC 8291 / RFC 8292), its timing,
// the /api/push routes, and HSA Locker's kinds end to end: "Needs review" (reading a document
// triggers it, once per document, held overnight, batched, with the Review count as the badge),
// "Couldn't read a document", the Reimbursable milestone, Year-end, the Weekly summary and
// Email inbox problems.
import { createExecutionContext, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atOrAfterLocalHour,
  b64url,
  encryptPayload,
  fromB64url,
  listDevices,
  localDate,
  saveDevice,
  vapidAuth,
  vapidKeys,
  type PushDevice,
} from '../../src/worker/kit/push';
import worker from '../../src/worker/index';
import { processDocument } from '../../src/worker/extract/pipeline';
import { runNotifications } from '../../src/worker/notifications';
import { storeDocument } from '../../src/worker/store';
import { fakePdf, ORIGIN, receiptExtraction, session } from './helpers';

const txt = new TextDecoder();
const u8 = (s: string) => new Uint8Array(new TextEncoder().encode(s));

// ---- A receiving browser: its keys, and decrypting what it's sent (RFC 8291 §3) ----

async function browser() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, p256dh: b64url(pub), auth: b64url(auth) };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) {
  const k = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, [
    'deriveBits',
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
      k,
      n * 8,
    ),
  );
}

async function decrypt(b: Awaited<ReturnType<typeof browser>>, body: Uint8Array) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  expect(rs).toBe(4096);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey(
    'raw',
    asPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: asKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0],
      b.pair.privateKey,
      256,
    ),
  );
  const ua = fromB64url(b.p256dh);
  const info = new Uint8Array([...u8('WebPush: info\0'), ...ua, ...asPublic]);
  const ikm = await hkdf(fromB64url(b.auth), ecdh, info, 32);
  const cek = await hkdf(salt, ikm, u8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, u8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)),
  );
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
  return JSON.parse(txt.decode(plain.slice(0, -1))) as Record<string, unknown>;
}

/** A fake push service: records each request, answers with `status`. */
function pushService(status = 201) {
  const got: { url: string; headers: Headers; body: Uint8Array }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    got.push({
      url: String(url),
      headers: new Headers(init.headers),
      body: new Uint8Array(init.body as Uint8Array),
    });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { got, fetcher };
}

/** Every kind but Needs review off, so each test hears only the kinds it switches on. */
const ONLY_REVIEW = {
  failed: false,
  milestone: false,
  year_end: false,
  inbox: false,
  weekly: false,
};
const NONE = { review: false, ...ONLY_REVIEW };

async function device(tz: string, prefs: Record<string, boolean> = ONLY_REVIEW) {
  const b = await browser();
  const d = await saveDevice(env.DB, {
    subscription: {
      endpoint: `https://push.example.test/${crypto.randomUUID()}`,
      keys: { p256dh: b.p256dh, auth: b.auth },
    },
    tz,
    prefs: { enabled: true, ...prefs },
  });
  return { b, d };
}

async function clearDevices() {
  for (const d of await listDevices(env.DB))
    await env.DB.prepare('DELETE FROM selfhost_push_devices WHERE id = ?').bind(d.id).run();
  await env.DB.prepare('DELETE FROM selfhost_push_sent').run();
}

/** Stores a fake receipt the fake model reads as needing review (a patient nobody knows). */
async function receipt(label: string, provider = 'Lakeside Pediatrics') {
  const r = await storeDocument(env, {
    bytes: new TextEncoder().encode(
      fakePdf(
        `${label} Amount paid $45.00`,
        // A placeholder for the patient: no person, so it lands in Review.
        receiptExtraction({ patient_name: 'Patient', provider_name: provider }),
      ),
    ),
    filename: `${label}.pdf`,
    mime: 'application/pdf',
    source: 'upload',
  });
  if (!r.ok) throw new Error('duplicate');
  return r.id;
}

/** The Review tab's count. */
async function reviewCount() {
  const api = await session();
  return (await api.get<{ counts: { review_documents: number } }>('/state')).data.counts
    .review_documents;
}

/** A zone where it's around noon right now, so "now" is inside 8 a.m. to 9 p.m. */
function noonZone() {
  const h = new Date().getUTCHours();
  let off = 12 - h; // hours ahead of UTC
  if (off > 12) off -= 24;
  if (off < -11) off += 24;
  return off === 0 ? 'UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
}

/** Records what's sent to push services through the global fetch. */
function spyPush() {
  const sent: { url: string; body: Uint8Array }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    sent.push({ url: String(input), body: new Uint8Array(init!.body as Uint8Array) });
    return new Response(null, { status: 201 });
  });
  return sent;
}

afterEach(() => vi.restoreAllMocks());

describe('RFC 8291 payload encryption', () => {
  it('matches the RFC 8291 Appendix A example byte for byte', async () => {
    const body = await encryptPayload(
      u8('When I grow up, I want to be a watermelon'),
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'BTBZMqHH6r4Tts7J_aSIgg',
      {
        senderPrivate: fromB64url('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
        senderPublic: fromB64url(
          'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
        ),
        salt: fromB64url('DGv6ra1nlYgDCS1FRnbzlw'),
      },
    );
    expect(b64url(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
        'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
        'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('round-trips with fresh keys, and a browser can decrypt it', async () => {
    const b = await browser();
    const body = await encryptPayload(u8('{"title":"Hi"}'), b.p256dh, b.auth);
    expect(await decrypt(b, body)).toEqual({ title: 'Hi' });
  });
});

describe('VAPID (RFC 8292)', () => {
  it('makes keys once, stores them, and signs a JWT the public key verifies', async () => {
    const keys = await vapidKeys(env.DB);
    expect(await vapidKeys(env.DB)).toEqual(keys);
    const now = Date.UTC(2027, 0, 1, 12);
    const header = await vapidAuth(keys, 'https://web.push.apple.com/a', 'https://hsa.test', now);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(m[2]).toBe(keys.publicKey);
    const [h, c, s] = m[1]!.split('.');
    expect(JSON.parse(txt.decode(fromB64url(c!)))).toEqual({
      aud: 'https://web.push.apple.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'https://hsa.test',
    });
    const pub = await crypto.subtle.importKey(
      'raw',
      fromB64url(keys.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pub,
        fromB64url(s!),
        u8(`${h}.${c}`),
      ),
    ).toBe(true);
  });
});

describe('local time', () => {
  it('8 a.m. to 9 p.m. in each zone, across DST', () => {
    const NY = 'America/New_York';
    const at = (iso: string) => new Date(iso);
    expect(atOrAfterLocalHour(at('2027-03-13T12:59Z'), NY, 8, 21)).toBe(false); // 7:59 EST
    expect(atOrAfterLocalHour(at('2027-03-13T13:00Z'), NY, 8, 21)).toBe(true); // 8:00 EST
    expect(atOrAfterLocalHour(at('2027-03-14T12:00Z'), NY, 8, 21)).toBe(true); // 8:00 EDT
    expect(atOrAfterLocalHour(at('2027-03-15T00:59Z'), NY, 8, 21)).toBe(true); // 20:59 EDT
    expect(atOrAfterLocalHour(at('2027-03-15T01:00Z'), NY, 8, 21)).toBe(false); // 21:00 EDT
    expect(localDate(at('2027-06-01T02:00Z'), 'America/Los_Angeles')).toBe('2027-05-31');
  });
});

describe('Needs review', () => {
  it('reading a document sends it straight away, and a batch as one when the last finishes', async () => {
    await clearDevices();
    const { b } = await device(noonZone());
    const sent = spyPush();

    const one = await receipt('trigger-one');
    expect(await processDocument(env, one)).toBe('needs_review');
    expect(sent).toHaveLength(1);
    const count = await reviewCount();
    expect(await decrypt(b, sent[0]!.body)).toEqual({
      title: 'Needs review',
      body: 'Receipt from Lakeside Pediatrics: patient not recognized',
      url: `/review/${one}`,
      tag: `review-${one}`,
      icon: '/pwa-192x192.png',
      badge: count,
    });

    // Two at once (a multi-file upload, an email with two attachments): one notification.
    const x = await receipt('trigger-x');
    const y = await receipt('trigger-y', 'Harbor Dental');
    await processDocument(env, x); // y is still waiting: nothing yet
    expect(sent).toHaveLength(1);
    await processDocument(env, y);
    expect(sent).toHaveLength(2);
    expect(await decrypt(b, sent[1]!.body)).toMatchObject({
      body: '2 documents need review',
      url: '/review',
      badge: count + 2,
    });

    // Once per document: later runs (the cron, another upload) don't repeat them.
    await runNotifications(env.DB);
    expect(sent).toHaveLength(2);
  });

  it('holds them from 9 p.m. to 8 a.m. and sends one at 8, once per document', async () => {
    await clearDevices();
    const { b, d } = await device('America/New_York');
    await env.DB.prepare('UPDATE selfhost_push_devices SET created_at = ? WHERE id = ?')
      .bind('2027-03-01T00:00:00.000Z', d.id)
      .run();
    const a = await receipt('night-a');
    const c = await receipt('night-c', 'Harbor Dental');
    const late = await receipt('day-late', 'Northside Labs');
    for (const id of [a, c, late]) await processDocument(env, id);
    const at = (id: string, iso: string) =>
      env.DB.prepare('UPDATE documents SET processed_at = ? WHERE id = ?').bind(iso, id).run();
    await at(a, '2027-03-10T02:10:00.000Z'); // 21:10 EST on the 9th
    await at(c, '2027-03-10T09:00:00.000Z'); // 4:00 EST
    await at(late, '2027-03-20T00:00:00.000Z'); // not read yet at the times below

    const svc = pushService();
    const run = (iso: string) =>
      runNotifications(env.DB, { now: new Date(iso), fetcher: svc.fetcher });
    await run('2027-03-10T02:20:00.000Z'); // 21:20
    await run('2027-03-10T09:10:00.000Z'); // 4:10
    await run('2027-03-10T12:50:00.000Z'); // 7:50
    expect(svc.got).toHaveLength(0);
    await run('2027-03-10T13:00:00.000Z'); // 8:00
    expect(svc.got).toHaveLength(1);
    const count = await reviewCount();
    expect(await decrypt(b, svc.got[0]!.body)).toEqual({
      title: 'Needs review',
      body: '2 documents need review',
      url: '/review',
      tag: `review-${[a, c].sort()[0]}`,
      icon: '/pwa-192x192.png',
      badge: count,
    });
    await run('2027-03-10T13:10:00.000Z');
    await run('2027-03-11T13:10:00.000Z'); // the next day: still once per document
    expect(svc.got).toHaveLength(1);

    // A document read during the day goes out on the next run, on its own.
    await at(late, '2027-03-11T15:00:00.000Z');
    await run('2027-03-11T15:10:00.000Z');
    expect(svc.got).toHaveLength(2);
    expect(await decrypt(b, svc.got[1]!.body)).toMatchObject({
      body: 'Receipt from Northside Labs: patient not recognized',
      url: `/review/${late}`,
      badge: count,
    });

    // Reviewed: it leaves the badge count.
    const api = await session();
    expect((await api.post(`/documents/${late}/discard`)).status).toBeLessThan(300);
    expect(await reviewCount()).toBe(count - 1);
  });

  it('skips devices with Needs review switched off', async () => {
    await clearDevices();
    await device('UTC', NONE);
    const id = await receipt('switched-off');
    await processDocument(env, id);
    await env.DB.prepare('UPDATE documents SET processed_at = ? WHERE id = ?')
      .bind('2030-01-01T11:00:00.000Z', id)
      .run();
    const svc = pushService();
    const r = await runNotifications(env.DB, {
      now: new Date('2030-01-01T12:00:00Z'),
      fetcher: svc.fetcher,
    });
    expect(r.sent).toBe(0);
  });
});

describe('/api/push', () => {
  it('needs a session', async () => {
    const r = await SELF.fetch(`${ORIGIN}/api/push/key`);
    expect(r.status).toBe(401);
  });

  it('subscribes this device, keeps its choices, tests, badges and unsubscribes', async () => {
    await clearDevices();
    const api = await session();
    const { data: key } = await api.get<{ key: string }>('/push/key');
    expect(key.key).toBe((await vapidKeys(env.DB)).publicKey);

    const b = await browser();
    const endpoint = `https://push.example.test/${crypto.randomUUID()}`;
    const sub = { endpoint, keys: { p256dh: b.p256dh, auth: b.auth } };
    expect((await api.post('/push/device', { endpoint })).data).toEqual({ device: null });
    expect(
      (await api.post('/push/subscribe', { subscription: { endpoint: 'http://x' } })).status,
    ).toBe(400);
    const s = await api.post<{ device: Pick<PushDevice, 'tz' | 'prefs'> }>('/push/subscribe', {
      subscription: sub,
      tz: 'America/Chicago',
      prefs: { enabled: true, review: true },
    });
    expect(s.data.device).toMatchObject({
      tz: 'America/Chicago',
      prefs: { enabled: true, review: true },
    });
    const p = await api.patch<{ device: Pick<PushDevice, 'prefs'> }>('/push/prefs', {
      endpoint,
      prefs: { review: false },
    });
    // Every other kind is on by default.
    expect(p.data.device.prefs).toEqual({
      enabled: true,
      review: false,
      failed: true,
      milestone: true,
      year_end: true,
      inbox: true,
      weekly: true,
    });
    await api.patch('/push/prefs', { endpoint, prefs: { review: true } });

    const sent = spyPush();
    const t = await api.post<{ result: string }>('/push/test', { endpoint });
    expect(t).toEqual({ status: 200, data: { result: 'sent' } });
    expect(sent[0]!.url).toBe(endpoint);
    const count = await reviewCount();
    expect(count).toBeGreaterThan(0);
    expect(await decrypt(b, sent[0]!.body)).toMatchObject({
      title: 'HSA Locker notifications are on',
      url: '/settings',
      badge: count,
    });
    vi.restoreAllMocks();

    // The badge is the Review tab's count, and 0 once this device is switched off.
    expect((await api.post('/push/badge', { endpoint })).data).toEqual({ count });
    await api.patch('/push/prefs', { endpoint, prefs: { enabled: false } });
    expect((await api.post('/push/badge', { endpoint })).data).toEqual({ count: 0 });

    expect((await api.post('/push/unsubscribe', { endpoint })).data).toEqual({ ok: true });
    expect((await api.post('/push/device', { endpoint })).data).toEqual({ device: null });
    expect((await api.post('/push/test', { endpoint })).status).toBe(404);
  });
});

/** Home's numbers (/api/summary). */
async function home() {
  const api = await session();
  return (
    await api.get<{
      totals: { outstanding_cents: number };
      years: { year: number | null; outstanding_cents: number }[];
    }>('/summary')
  ).data;
}

/** A receipt that counts as Reimbursable: read, then its review reasons cleared. */
async function reimbursable(label: string, p: { service_date?: string; created_at?: string } = {}) {
  const id = await receipt(label);
  await processDocument(env, id);
  await env.DB.prepare(
    `UPDATE entries SET review_reasons_json = '[]', service_date = COALESCE(?, service_date),
       created_at = COALESCE(?, created_at) WHERE document_id = ?`,
  )
    .bind(p.service_date ?? null, p.created_at ?? null, id)
    .run();
  return id;
}

describe('Couldn’t read a document', () => {
  it('a document reading gives up on is its own notification, not Needs review', async () => {
    await clearDevices();
    const { b } = await device(noonZone(), { ...NONE, review: true, failed: true });
    const r = await storeDocument(env, {
      bytes: new TextEncoder().encode(fakePdf('FAKE_FAIL statement', receiptExtraction())),
      filename: 'statement.pdf',
      mime: 'application/pdf',
      source: 'upload',
    });
    if (!r.ok) throw new Error('duplicate');
    // Its last attempt.
    await env.DB.prepare('UPDATE documents SET attempts = 4 WHERE id = ?').bind(r.id).run();
    const sent = spyPush();
    expect(await processDocument(env, r.id)).toBe('needs_review');
    expect(sent).toHaveLength(1);
    expect(await decrypt(b, sent[0]!.body)).toMatchObject({
      title: 'Couldn’t read a document',
      body: 'Couldn’t read statement.pdf.',
      url: `/review/${r.id}`,
    });
    await runNotifications(env.DB);
    expect(sent).toHaveLength(1);
  });
});

describe('Reimbursable milestone', () => {
  it('once per crossing at the amount set in Settings, again after dropping below', async () => {
    await clearDevices();
    const api = await session();
    const { b } = await device(noonZone(), { ...NONE, milestone: true });
    const total = (await home()).totals.outstanding_cents;
    const amount = Math.floor(total / 100) * 100 + 100; // just above today's total
    expect((await api.patch('/settings', { notify_milestone_cents: amount })).status).toBe(200);
    expect((await api.patch('/settings', { notify_milestone_cents: 12_345 })).status).toBe(400);

    const sent = spyPush();
    await runNotifications(env.DB); // below: nothing
    expect(sent).toHaveLength(0);

    const id = await reimbursable('milestone-1');
    await runNotifications(env.DB);
    expect(sent).toHaveLength(1);
    const now = (await home()).totals.outstanding_cents;
    expect(now).toBeGreaterThanOrEqual(amount);
    expect(await decrypt(b, sent[0]!.body)).toMatchObject({
      title: 'Reimbursable',
      body: `You have $${(now / 100).toFixed(2).replace(/\.00$/, '')} reimbursable. Time to pay yourself back?`,
      url: '/ledger?status=outstanding',
    });
    await runNotifications(env.DB); // still above: not again
    expect(sent).toHaveLength(1);

    // Paid back (here: marked paid with the HSA card): below again, which re-arms it.
    await env.DB.prepare(
      `UPDATE entries SET excluded_reason = 'paid_with_hsa' WHERE document_id = ?`,
    )
      .bind(id)
      .run();
    await runNotifications(env.DB);
    expect(sent).toHaveLength(1);
    await env.DB.prepare(`UPDATE entries SET excluded_reason = NULL WHERE document_id = ?`)
      .bind(id)
      .run();
    // A new crossing needs a new instant (the key is when it crossed).
    await new Promise((r) => setTimeout(r, 5));
    await runNotifications(env.DB);
    expect(sent).toHaveLength(2);
  });
});

describe('Year-end and Weekly summary', () => {
  it('December 1 at 8 a.m.: what’s reimbursable from that year, once', async () => {
    await clearDevices();
    const { b, d } = await device('America/New_York', { ...NONE, year_end: true });
    await env.DB.prepare('UPDATE selfhost_push_devices SET created_at = ? WHERE id = ?')
      .bind('2030-01-01T00:00:00.000Z', d.id)
      .run();
    await reimbursable('year-end-1', { service_date: '2030-06-01' });
    await reimbursable('year-end-2', { service_date: '2030-09-15' });
    const cents = (await home()).years.find((y) => y.year === 2030)!.outstanding_cents;
    expect(cents).toBe(9_000);
    const svc = pushService();
    const run = (iso: string) =>
      runNotifications(env.DB, { now: new Date(iso), fetcher: svc.fetcher });
    await run('2030-11-30T15:00:00Z');
    await run('2030-12-01T12:50:00Z'); // 7:50 EST
    expect(svc.got).toHaveLength(0);
    await run('2030-12-01T13:00:00Z'); // 8:00
    await run('2030-12-01T18:00:00Z');
    await run('2030-12-02T13:00:00Z');
    expect(svc.got).toHaveLength(1);
    expect(await decrypt(b, svc.got[0]!.body)).toMatchObject({
      title: 'Year-end',
      body: 'You have $90 reimbursable from 2030.',
      url: '/ledger?year=2030&status=outstanding',
    });
    // Nothing reimbursable from 2031: no notification.
    await run('2031-12-01T13:00:00Z');
    expect(svc.got).toHaveLength(1);
  });

  it('Sunday at 8 a.m.: the week’s receipts, skipping empty weeks', async () => {
    await clearDevices();
    const { b } = await device('America/New_York', { ...NONE, weekly: true });
    await reimbursable('week-1', { created_at: '2031-01-07T15:00:00.000Z' });
    await reimbursable('week-2', { created_at: '2031-01-10T15:00:00.000Z' });
    const svc = pushService();
    const run = (iso: string) =>
      runNotifications(env.DB, { now: new Date(iso), fetcher: svc.fetcher });
    await run('2031-01-11T15:00:00Z'); // Saturday
    await run('2031-01-12T12:50:00Z'); // Sunday 7:50
    expect(svc.got).toHaveLength(0);
    await run('2031-01-12T13:00:00Z'); // Sunday 8:00
    await run('2031-01-12T16:00:00Z');
    expect(svc.got).toHaveLength(1);
    expect(await decrypt(b, svc.got[0]!.body)).toMatchObject({
      title: 'Weekly summary',
      body: 'This week: 2 receipts added, $90.',
      url: '/ledger?sort=added_desc',
    });
    await run('2031-01-19T13:00:00Z'); // nothing added that week
    expect(svc.got).toHaveLength(1);
  });
});

describe('Email inbox problem', () => {
  async function deliver(
    to: string,
    from = 'billing@clinic.example',
    subject = 'Receipt',
    text = 'See attached.',
    rawSize?: number,
  ) {
    const raw = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      '',
    ].join('\r\n');
    const bytes = new TextEncoder().encode(raw);
    let rejected: string | null = null;
    const message = {
      from,
      to,
      headers: new Headers({ subject }),
      raw: new Blob([bytes]).stream(),
      rawSize: rawSize ?? bytes.byteLength,
      setReject: (r: string) => (rejected = r),
    };
    const ctx = createExecutionContext();
    await worker.email(message as never, env, ctx);
    await waitOnExecutionContext(ctx);
    return rejected;
  }

  it('sends promptly, once a day per problem, with a forwarding code on its own', async () => {
    await clearDevices();
    const api = await session();
    const { b } = await device(noonZone(), { ...NONE, inbox: true });
    const s = await api.patch<{ inbox_address: string }>('/settings', {
      inbox_domain: 'hsa-in.example.com',
      inbox_max_mb: 1,
    });
    const to = s.data.inbox_address;
    const sent = spyPush();

    expect(await deliver('nobody@hsa-in.example.com')).toBe('unknown recipient'); // spam: quiet
    expect(sent).toHaveLength(0);

    expect(await deliver(to, undefined, 'Big', 'x', 2 * 1024 * 1024)).toBe('message too large');
    expect(sent).toHaveLength(1);
    expect(await decrypt(b, sent[0]!.body)).toMatchObject({
      title: 'Email inbox',
      body: 'An email was rejected today: too large.',
      url: '/settings/inbox',
    });
    await deliver(to, undefined, 'Big again', 'x', 2 * 1024 * 1024);
    expect(sent).toHaveLength(1); // once a day for this problem

    await deliver(
      to,
      'forwarding-noreply@google.com',
      '(#987654321) Gmail Forwarding Confirmation - Receive Mail from sam@example.com',
      'Confirmation code: 987654321',
    );
    expect(sent).toHaveLength(2);
    expect(await decrypt(b, sent[1]!.body)).toMatchObject({
      body: 'Gmail sent a forwarding code. Enter it in Gmail to finish setup.',
      url: '/settings/inbox',
    });
    await runNotifications(env.DB);
    expect(sent).toHaveLength(2);
    await api.patch('/settings', { inbox_max_mb: 20 });
  });
});
