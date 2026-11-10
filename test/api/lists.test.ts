import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CategoryUsage, ProviderSuggestion, ProviderUsage } from '../../src/shared/types';
import { session, type Api } from './helpers';

let api: Api;

beforeAll(async () => {
  api = await session();
  await api.post('/sample-data');
});

async function categories() {
  return (await api.get<{ categories: CategoryUsage[] }>('/categories')).data.categories;
}

async function providers() {
  return (
    await api.get<{ providers: ProviderUsage[]; suggestions: ProviderSuggestion[] }>('/providers')
  ).data;
}

describe('Settings → Categories', () => {
  it('lists every category with how many entries use it', async () => {
    const list = await categories();
    expect(list.length).toBeGreaterThan(10);
    const total = list.reduce((n, c) => n + c.entries, 0);
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM entries WHERE category_id IS NOT NULL',
    ).first<{ n: number }>();
    expect(total).toBe(row!.n);
    expect(list.some((c) => c.entries > 0)).toBe(true);
  });

  it('refuses to delete a category that entries use', async () => {
    const used = (await categories()).find((c) => c.entries > 0)!;
    const r = await api.del<{ error: string }>(`/categories/${used.id}`);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe('in_use');
    expect((await categories()).some((c) => c.id === used.id)).toBe(true);
  });

  it('deletes an unused category', async () => {
    const made = await api.post<{ id: string }>('/categories', { name: 'Test Unused' });
    expect(made.status).toBe(201);
    expect((await api.del(`/categories/${made.data.id}`)).status).toBe(200);
    expect((await categories()).some((c) => c.id === made.data.id)).toBe(false);
  });

  it('merges a category: its entries move, then it is deleted', async () => {
    const before = await categories();
    const from = before.find((c) => c.entries > 0)!;
    const into = before.find((c) => c.id !== from.id)!;
    const r = await api.post<{ moved: number }>(`/categories/${from.id}/merge`, { into: into.id });
    expect(r.status).toBe(200);
    expect(r.data.moved).toBe(from.entries);
    const after = await categories();
    expect(after.some((c) => c.id === from.id)).toBe(false);
    expect(after.find((c) => c.id === into.id)!.entries).toBe(into.entries + from.entries);
  });

  it('refuses a merge into itself or a missing category', async () => {
    const [a] = await categories();
    expect((await api.post(`/categories/${a!.id}/merge`, { into: a!.id })).status).toBe(400);
    expect((await api.post(`/categories/${a!.id}/merge`, { into: 'nope' })).status).toBe(404);
  });

  it('refuses to rename a category to another one’s name', async () => {
    const [a, b] = await categories();
    expect((await api.patch(`/categories/${a!.id}`, { name: b!.name })).status).toBe(409);
  });
});

describe('Settings → Providers', () => {
  it('lists providers with entry counts', async () => {
    const { providers: list } = await providers();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((p) => p.entries > 0)).toBe(true);
  });

  it('has no delete: providers are merged or renamed instead', async () => {
    const { providers: list } = await providers();
    const p = list[0]!;
    const r = await api.del(`/providers/${p.id}`);
    expect(r.status).toBe(404);
    expect((await providers()).providers.some((x) => x.id === p.id)).toBe(true);
  });

  it('merges a provider and keeps its name as a spelling', async () => {
    const a = await api.post<{ id: string }>('/providers', { name: 'Fakeville Clinic' });
    const b = await api.post<{ id: string }>('/providers', { name: 'Fakeville Clinic Inc' });
    const r = await api.post<{ aliases: string[] }>(`/providers/${b.data.id}/merge`, {
      into: a.data.id,
    });
    expect(r.status).toBe(200);
    expect(r.data.aliases).toContain('Fakeville Clinic Inc');
    expect((await providers()).providers.some((x) => x.id === b.data.id)).toBe(false);
  });

  it('shows printed names waiting on a provider suggestion', async () => {
    const { providers: list } = await providers();
    const doc = await env.DB.prepare('SELECT id FROM documents LIMIT 1').first<{ id: string }>();
    const e = await env.DB.prepare('SELECT * FROM entries WHERE document_id = ? LIMIT 1')
      .bind(doc!.id)
      .first<{ id: string }>();
    await env.DB.prepare(
      `UPDATE entries SET provider_id = NULL, provider_name_raw = ?, review_reasons_json = '["provider_suggestion"]' WHERE id = ?`,
    )
      .bind(`${list[0]!.name} Inc`, e!.id)
      .run();
    await env.DB.prepare("UPDATE documents SET status = 'needs_review' WHERE id = ?")
      .bind(doc!.id)
      .run();
    const { suggestions } = await providers();
    expect(suggestions).toContainEqual(
      expect.objectContaining({ raw: `${list[0]!.name} Inc`, entries: 1 }),
    );
  });
});

describe('domain check', () => {
  it('rejects something that is not a domain', async () => {
    expect((await api.get('/inbox/domain-check?domain=localhost')).status).toBe(400);
    expect((await api.get('/inbox/domain-check')).status).toBe(400);
  });
});

describe('Settings → Providers: other spellings', () => {
  it('removes an unused spelling, refuses a used one, and moves a used one with its receipts', async () => {
    const e = await env.DB.prepare(
      'SELECT provider_id AS pid, provider_name_raw AS raw FROM entries WHERE provider_id IS NOT NULL AND provider_name_raw IS NOT NULL LIMIT 1',
    ).first<{ pid: string; raw: string }>();
    const list = (await providers()).providers;
    const from = list.find((p) => p.id === e!.pid)!;
    const to = list.find((p) => p.id !== from.id)!;
    await api.patch(`/providers/${from.id}`, { aliases: [e!.raw, 'Zzz Typo Clinic'] });

    const counted = (await providers()).providers.find((p) => p.id === from.id)!;
    expect(counted.alias_entries[e!.raw]).toBeGreaterThan(0);
    expect(counted.alias_entries['Zzz Typo Clinic']).toBe(0);

    const ok = await api.post(`/providers/${from.id}/aliases/remove`, { alias: 'Zzz Typo Clinic' });
    expect(ok.status).toBe(200);

    const refused = await api.post<{ error: string }>(`/providers/${from.id}/aliases/remove`, {
      alias: e!.raw,
    });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toBe('in_use');

    const n = counted.alias_entries[e!.raw];
    const moved = await api.post<{ moved: number }>(`/providers/${from.id}/aliases/move`, {
      alias: e!.raw,
      into: to.id,
    });
    expect(moved.status).toBe(200);
    expect(moved.data.moved).toBe(n);
    const after = (await providers()).providers;
    expect(after.find((p) => p.id === from.id)!.aliases).toEqual([]);
    expect(after.find((p) => p.id === to.id)!.alias_entries[e!.raw]).toBe(n);
  });
});

describe('Settings → Categories: Other', () => {
  it('is permanent: no rename, merge or delete', async () => {
    const list = await categories();
    const other = list.find((c) => c.id === 'cat-other')!;
    expect(other.permanent).toBe(true);
    expect(list.filter((c) => c.permanent)).toHaveLength(1);
    const target = list.find((c) => c.id !== other.id)!;
    expect((await api.del(`/categories/${other.id}`)).status).toBe(409);
    expect((await api.patch(`/categories/${other.id}`, { name: 'Misc' })).status).toBe(409);
    expect((await api.post(`/categories/${other.id}/merge`, { into: target.id })).status).toBe(409);
    expect((await categories()).some((c) => c.id === other.id && c.name === 'Other')).toBe(true);
  });
});
