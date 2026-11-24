import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppState } from '../../src/shared/types';
import { checkKey, getProvider, loadKeyConfig } from '../../src/worker/extract/providers';
import { session } from './helpers';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const answer = (status: number) => {
  globalThis.fetch = (async () => new Response('{}', { status })) as typeof fetch;
};

describe('checking a key', () => {
  it('says whether the provider takes it', async () => {
    answer(200);
    expect(await checkKey('anthropic', 'sk-ant-good')).toBe('ok');
    answer(401);
    expect(await checkKey('openai', 'sk-bad')).toBe('refused');
    answer(400);
    expect(await checkKey('gemini', 'AIza-bad')).toBe('refused');
    answer(503);
    expect(await checkKey('anthropic', 'sk-ant-maybe')).toBe('unreachable');
  });
});

describe('a key saved in the app', () => {
  it('refuses to save a key the provider refuses', async () => {
    const api = await session();
    const r = await api.post('/ai/key', { provider: 'anthropic', key: 'sk-ant-refused-key' });
    // The worker under test can't reach the provider, or is refused: either way, not saved.
    expect([400, 503]).toContain(r.status);
    expect(await loadKeyConfig(env.DB)).toBeNull();
  });

  it('is used for reading and never leaves the worker', async () => {
    const db = env.DB;
    const put = (k: string, v: string) =>
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(k, v).run();
    await put('llm_provider', 'anthropic');
    await put('llm_api_key', 'sk-ant-secret-1234');
    await put('llm_model', '');

    const saved = await loadKeyConfig(db);
    // (Tests run with LLM_PROVIDER=fake, which always wins; without it the saved key is used.)
    expect(getProvider({ ...env, LLM_PROVIDER: '' } as Cloudflare.Env, saved).id).toBe('anthropic');

    const api = await session();
    const state = await api.get<AppState>('/state');
    expect(state.data.ai.key_source).toBe('app');
    expect(state.data.ai.key_hint).toBe('1234');
    expect(JSON.stringify(state.data)).not.toContain('sk-ant-secret');
    const backup = await api.get('/export');
    expect(JSON.stringify(backup.data)).not.toContain('sk-ant-secret');

    expect((await api.post('/ai/key/remove')).status).toBe(200);
    expect(await loadKeyConfig(db)).toBeNull();
    expect((await api.get<AppState>('/state')).data.ai.key_source).toBeNull();
  });
});
