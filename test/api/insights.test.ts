import { beforeAll, describe, expect, it } from 'vitest';
import type { AppState } from '../../src/shared/types';
import { session, type Api } from './helpers';

let api: Api;

beforeAll(async () => {
  api = await session();
});

const state = async () => (await api.get<AppState>('/state')).data;

describe('Insights layout', () => {
  it('starts empty, so the board uses its default order', async () => {
    expect((await state()).settings.insights_layout).toEqual([]);
  });

  it('saves order, width and visibility, and reads them back', async () => {
    const layout = [
      { id: 'balance', size: 'full', hidden: false },
      { id: 'glance', size: 'full', hidden: false },
      { id: 'aging', size: 'half', hidden: true },
    ];
    const res = await api.patch('/settings', { insights_layout: layout });
    expect(res.status).toBe(200);
    expect((await state()).settings.insights_layout).toEqual(layout);
  });

  it('rejects a malformed layout and keeps the saved one', async () => {
    const before = (await state()).settings.insights_layout;
    const res = await api.patch('/settings', {
      insights_layout: [{ id: 'balance', size: 'huge', hidden: false }],
    });
    expect(res.status).toBe(400);
    expect((await state()).settings.insights_layout).toEqual(before);
  });
});
