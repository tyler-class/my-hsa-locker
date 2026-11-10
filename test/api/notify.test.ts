import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { reminderMessage, sendReminder } from '../../src/worker/notify';
import { session } from './helpers';

/** A stand-in for the send_email binding that records what would be sent. */
function fakeEmail(fail?: { code: string }) {
  const sent: { from: unknown; to: unknown; subject: string; text: string }[] = [];
  const binding = {
    send: async (m: (typeof sent)[number]) => {
      if (fail) throw Object.assign(new Error('nope'), fail);
      sent.push(m);
      return { messageId: 'x' };
    },
  };
  return { sent, env: { ...env, EMAIL: binding } as unknown as Cloudflare.Env };
}

const morning = new Date('2026-11-05T14:00:00Z');
const night = new Date('2026-11-05T05:00:00Z');

beforeAll(async () => {
  const api = await session();
  await api.post('/sample-data'); // has documents waiting for review
  await api.patch('/settings', { inbox_domain: 'hsa-in.example.com' });
});

describe('daily review reminder', () => {
  it('needs an address and the switch on', async () => {
    const f = fakeEmail();
    expect((await sendReminder(f.env, { now: morning })).sent).toBe(false);
    const api = await session();
    await api.patch('/settings', { notify_email: 'Me@Example.com' });
    expect((await sendReminder(f.env, { now: morning })).reason).toBe('off');
    expect(f.sent).toHaveLength(0);
  });

  it('sends once a day, after the reminder hour', async () => {
    const api = await session();
    await api.patch('/settings', { notify_daily: true });
    const f = fakeEmail();
    expect((await sendReminder(f.env, { now: night })).reason).toBe('not_yet');
    expect((await sendReminder(f.env, { now: morning })).sent).toBe(true);
    expect((await sendReminder(f.env, { now: morning })).reason).toBe('already_sent');
    expect(f.sent).toHaveLength(1);
    const m = f.sent[0]!;
    expect(m.to).toBe('me@example.com');
    expect(m.from).toEqual({ name: 'HSA Locker', email: 'reminders@hsa-in.example.com' });
    expect(m.subject).toMatch(/need.* review/);
  });

  it('explains a recipient that is not verified', async () => {
    const f = fakeEmail({ code: 'E_RECIPIENT_NOT_ALLOWED' });
    const r = await sendReminder(f.env, { test: true });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/Destination Addresses/);
  });

  it('writes a short, linked message', () => {
    const m = reminderMessage({ documents: 2, pendingCents: 4500, origin: 'https://hsa.test' });
    expect(m.subject).toBe('HSA Locker: 2 documents need review');
    expect(m.text).toContain('$45.00');
    expect(m.text).toContain('https://hsa.test/review');
    expect(m.html).toContain('href="https://hsa.test/review"');
    expect(reminderMessage({ documents: 1, pendingCents: 0, origin: null }).subject).toBe(
      'HSA Locker: 1 document needs review',
    );
  });
});
