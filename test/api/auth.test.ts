import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../../src/worker/app';
import { getSalt, makeToken, verifyToken } from '../../src/worker/auth';
import { ORIGIN, PASSWORD, cookieFrom, login } from './helpers';

describe('auth', () => {
  it('health is public', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
  });

  it('requires a session for the API', async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/state`)).status).toBe(401);
    expect((await SELF.fetch(`${ORIGIN}/api/session`)).status).toBe(401);
  });

  it('rejects a wrong password and accepts the right one', async () => {
    expect((await login('nope', '192.0.2.10')).status).toBe(401);
    const ok = await login(PASSWORD, '192.0.2.10');
    expect(ok.status).toBe(200);
    const set = ok.headers.get('Set-Cookie')!;
    expect(set).toMatch(/hsa_locker_session=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Max-Age=7776000/);
    const s = await SELF.fetch(`${ORIGIN}/api/session`, { headers: { Cookie: cookieFrom(ok) } });
    expect(s.status).toBe(200);
  });

  it('rate-limits after 10 failures per IP', async () => {
    const ip = '192.0.2.99';
    for (let i = 0; i < 10; i++) expect((await login('wrong', ip)).status).toBe(401);
    const blocked = await login(PASSWORD, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('900');
    expect((await login(PASSWORD, '192.0.2.100')).status).toBe(200);
  });

  it('rejects forged and expired cookies', async () => {
    const forged = await SELF.fetch(`${ORIGIN}/api/state`, {
      headers: { Cookie: 'hsa_locker_session=eyJpYXQiOjB9.AAAA' },
    });
    expect(forged.status).toBe(401);
    const salt = await getSalt(env.DB);
    const old = await makeToken(PASSWORD, salt, Date.now() - 91 * 86_400_000);
    const expired = await SELF.fetch(`${ORIGIN}/api/state`, {
      headers: { Cookie: `hsa_locker_session=${old}` },
    });
    expect(expired.status).toBe(401);
  });

  it('changing the password invalidates existing sessions', async () => {
    const salt = await getSalt(env.DB);
    const token = await makeToken(PASSWORD, salt);
    expect(await verifyToken(token, PASSWORD, salt)).toBe(true);
    expect(await verifyToken(token, 'a new password', salt)).toBe(false);
    const res = await app.request(
      '/api/state',
      { headers: { Cookie: `hsa_locker_session=${token}` } },
      { ...env, APP_PASSWORD: 'a new password' },
    );
    expect(res.status).toBe(401);
  });

  it('refuses to run without a password', async () => {
    const res = await app.request('/api/state', {}, { ...env, APP_PASSWORD: undefined });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('setup');
    expect((await app.request('/api/health', {}, { ...env, APP_PASSWORD: undefined })).status).toBe(
      200,
    );
  });

  it('blocks cross-site and non-JSON writes', async () => {
    const res = await login();
    const cookie = cookieFrom(res);
    const cross = await SELF.fetch(`${ORIGIN}/api/categories`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(cross.status).toBe(403);
    const form = await SELF.fetch(`${ORIGIN}/api/categories`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(form.status).toBe(415);
  });
});
