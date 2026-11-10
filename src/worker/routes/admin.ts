// App state, settings, people, providers, categories, backup/restore, sample data, danger zone.
import { Hono } from 'hono';
import { applyHsaCards, matchProvider, nameKey, withAlias } from '@shared/logic';
import { PERSON_COLORS } from '@shared/lookups';
import {
  categoryInput,
  categoryMerge,
  categoryPatch,
  deleteAllInput,
  personInput,
  personPatch,
  providerInput,
  providerAlias,
  providerAliasMove,
  providerMerge,
  providerPatch,
  settingsPatch,
} from '@shared/schemas';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  PRIVATE_SETTINGS,
  TABLE_ORDER,
  isHsaExport,
  rowValues,
  type ExportRow,
  type HsaExport,
} from '@shared/exportFormat';
import type { AppState, CategoryUsage, ProviderSuggestion, ProviderUsage } from '@shared/types';
import {
  all,
  first,
  insertStmt,
  loadCategories,
  loadPeople,
  loadProviders,
  loadSettings,
  newId,
  nowIso,
  REVIEW_DOC_WHERE,
  setSettingStmt,
  toEntry,
  toPerson,
  toProvider,
  updateStmt,
} from '../db';
import { getProvider, providerMisconfigured } from '../extract/providers';
import { rememberOrigin, sendReminder } from '../notify';
import sample from '../../../seed/sample.json';
import { refreshDocs } from '../status';
import { ApiError, body, notFound, type AppEnv } from './util';
import { kitState, setKitState } from '../kit/telemetry';

export const admin = new Hono<AppEnv>();

admin.get('/state', async (c) => {
  const db = c.env.DB;
  // Remembered for links in emails sent from cron. Best-effort (tests have no execution context).
  try {
    c.executionCtx.waitUntil(rememberOrigin(db, new URL(c.req.url).origin).catch(() => {}));
  } catch {
    /* no execution context */
  }
  const [settings, people, providers, categories, counts, kit] = await Promise.all([
    loadSettings(db),
    loadPeople(db),
    loadProviders(db),
    loadCategories(db),
    first<Record<string, number>>(
      db,
      `SELECT
        (SELECT COUNT(*) FROM documents d WHERE ${REVIEW_DOC_WHERE}) AS review_documents,
        (SELECT COUNT(*) FROM entries e JOIN documents d ON d.id = e.document_id
           WHERE d.status != 'discarded' AND e.review_reasons_json != '[]') AS review_entries,
        (SELECT COUNT(*) FROM documents WHERE status IN ('pending', 'processing')) AS in_flight,
        (SELECT COUNT(*) FROM documents WHERE status = 'failed') AS failed,
        (SELECT COUNT(*) FROM documents WHERE status != 'discarded') AS documents`,
    ),
    kitState(db),
  ]);
  const p = getProvider(c.env);
  const state: AppState = {
    settings,
    people,
    providers,
    categories,
    counts: {
      review_documents: Number(counts?.review_documents ?? 0),
      review_entries: Number(counts?.review_entries ?? 0),
      in_flight: Number(counts?.in_flight ?? 0),
      failed: Number(counts?.failed ?? 0),
      documents: Number(counts?.documents ?? 0),
    },
    ai: {
      provider: providerMisconfigured(c.env) ? `${p.id} (LLM_API_KEY missing)` : p.id,
      text_model: p.textModel,
      vision_model: p.visionModel,
      third_party: p.thirdParty,
      gateway: c.env.AI_GATEWAY_ID || c.env.AI_GATEWAY_URL ? 'on' : null,
    },
    kit: { updates_set_up: kit.updates_set_up, telemetry: kit.telemetry },
  };
  return c.json(state);
});

admin.patch('/settings', async (c) => {
  const input = await body(c, settingsPatch);
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  const set = (k: string, v: string) => stmts.push(setSettingStmt(db, k, v));
  if (input.hsa_cards) set('hsa_card_last4_json', JSON.stringify([...new Set(input.hsa_cards)]));
  if (input.family_names) set('family_names_json', JSON.stringify(input.family_names));
  if (input.inbox_domain !== undefined) set('inbox_domain', input.inbox_domain ?? '');
  // The address's local part is the inbox token; a chosen one replaces the random one.
  if (input.inbox_local !== undefined) set('inbox_token', input.inbox_local);
  if (input.inbox_paused !== undefined) set('inbox_paused', input.inbox_paused ? '1' : '0');
  if (input.inbox_min_kb !== undefined) set('inbox_min_kb', String(input.inbox_min_kb));
  if (input.inbox_max_attachments !== undefined)
    set('inbox_max_attachments', String(input.inbox_max_attachments));
  if (input.inbox_max_mb !== undefined) set('inbox_max_mb', String(input.inbox_max_mb));
  if (input.inbox_daily_cap !== undefined) set('inbox_daily_cap', String(input.inbox_daily_cap));
  if (input.inbox_allowlist) set('inbox_allowlist_json', JSON.stringify(input.inbox_allowlist));
  if (input.onboarded !== undefined) set('onboarded', input.onboarded ? '1' : '0');
  if (input.notify_email !== undefined) set('notify_email', input.notify_email ?? '');
  if (input.notify_daily !== undefined) set('notify_daily', input.notify_daily ? '1' : '0');
  if (input.notify_milestone_cents !== undefined)
    set('notify_milestone_cents', String(input.notify_milestone_cents));
  if (input.insights_layout) set('insights_layout_json', JSON.stringify(input.insights_layout));
  if (stmts.length) await db.batch(stmts);
  if (input.telemetry !== undefined || input.updates_set_up !== undefined)
    await setKitState(db, { telemetry: input.telemetry, updates_set_up: input.updates_set_up });

  // A changed card list re-applies paid_with_hsa to receipts (automatic exclusions only).
  if (input.hsa_cards) {
    const rows = (
      await all(
        db,
        "SELECT * FROM entries WHERE type = 'receipt' AND (card_last4 IS NOT NULL OR excluded_auto = 1)",
      )
    ).map(toEntry);
    const updates = rows
      .map((e) => ({ e, next: applyHsaCards(e, input.hsa_cards!) }))
      .filter(({ e, next }) => next.excluded_reason !== e.excluded_reason);
    if (updates.length)
      await db.batch(
        updates.map(({ e, next }) =>
          updateStmt(db, 'entries', e.id, {
            excluded_reason: next.excluded_reason,
            excluded_auto: next.excluded_auto ? 1 : 0,
          }),
        ),
      );
  }
  return c.json(await loadSettings(db));
});

// ---------- people ----------

admin.post('/people', async (c) => {
  const input = await body(c, personInput);
  const db = c.env.DB;
  const count = (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM people'))?.n ?? 0;
  const now = nowIso();
  const id = newId();
  await insertStmt(db, 'people', {
    id,
    name: input.name,
    relationship: input.relationship ?? null,
    aliases_json: JSON.stringify(input.aliases ?? []),
    color: input.color ?? PERSON_COLORS[count % PERSON_COLORS.length],
    sort_order: input.sort_order ?? count,
    created_at: now,
    updated_at: now,
  }).run();
  return c.json(toPerson((await first(db, 'SELECT * FROM people WHERE id = ?', id))!), 201);
});

admin.patch('/people/:id', async (c) => {
  const input = await body(c, personPatch);
  const db = c.env.DB;
  const id = c.req.param('id');
  if (!(await first(db, 'SELECT 1 FROM people WHERE id = ?', id))) throw notFound('Person');
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.relationship !== undefined) fields.relationship = input.relationship;
  if (input.aliases !== undefined) fields.aliases_json = JSON.stringify(input.aliases);
  if (input.color !== undefined) fields.color = input.color;
  if (input.sort_order !== undefined) fields.sort_order = input.sort_order;
  if (Object.keys(fields).length) await updateStmt(db, 'people', id, fields).run();
  return c.json(toPerson((await first(db, 'SELECT * FROM people WHERE id = ?', id))!));
});

/**
 * Adds an alias to a person and resolves every unknown_patient entry whose printed name it now
 * matches (the "add as alias to X" action in Review).
 */
admin.post('/people/:id/alias', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const { alias } = (await c.req.json().catch(() => ({}))) as { alias?: string };
  if (!alias?.trim()) throw new ApiError(400, 'invalid', 'alias: Required');
  const row = await first(db, 'SELECT * FROM people WHERE id = ?', id);
  if (!row) throw notFound('Person');
  const p = toPerson(row);
  await updateStmt(db, 'people', id, {
    aliases_json: JSON.stringify(withAlias(p.name, p.aliases, alias)),
  }).run();
  const resolved = await assignPersonByName(db, id, alias);
  return c.json({
    person: toPerson((await first(db, 'SELECT * FROM people WHERE id = ?', id))!),
    resolved,
  });
});

/** Points unassigned entries printed with this name at the person and clears that reason. */
async function assignPersonByName(db: D1Database, personId: string, name: string): Promise<number> {
  const rows = (
    await all(
      db,
      'SELECT * FROM entries WHERE person_id IS NULL AND lower(trim(patient_name_raw)) = lower(trim(?))',
      name,
    )
  ).map(toEntry);
  if (!rows.length) return 0;
  await db.batch(
    rows.map((e) =>
      updateStmt(db, 'entries', e.id, {
        person_id: personId,
        review_reasons_json: JSON.stringify(
          e.review_reasons.filter((r) => r !== 'unknown_patient' && r !== 'missing_patient'),
        ),
      }),
    ),
  );
  await refreshDocs(
    db,
    rows.map((e) => e.document_id),
  );
  return rows.length;
}

admin.post('/people/from-name', async (c) => {
  // "Add as new person" from Review: creates the person and assigns matching entries.
  const input = await body(c, personInput);
  const db = c.env.DB;
  const now = nowIso();
  const count = (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM people'))?.n ?? 0;
  const id = newId();
  await insertStmt(db, 'people', {
    id,
    name: input.name,
    relationship: input.relationship ?? null,
    aliases_json: JSON.stringify(input.aliases ?? []),
    color: PERSON_COLORS[count % PERSON_COLORS.length],
    sort_order: count,
    created_at: now,
    updated_at: now,
  }).run();
  let resolved = await assignPersonByName(db, id, input.name);
  for (const a of input.aliases ?? []) resolved += await assignPersonByName(db, id, a);
  return c.json(
    { person: toPerson((await first(db, 'SELECT * FROM people WHERE id = ?', id))!), resolved },
    201,
  );
});

admin.delete('/people/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM people WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---------- providers ----------

/**
 * Settings → Providers: every provider with how many entries use it, plus printed names that
 * may be an existing provider (entries waiting with a provider suggestion), grouped by name.
 */
admin.get('/providers', async (c) => {
  const db = c.env.DB;
  const [providers, counts, printed, pending] = await Promise.all([
    loadProviders(db),
    all<{ id: string; n: number }>(
      db,
      'SELECT provider_id AS id, COUNT(*) AS n FROM entries WHERE provider_id IS NOT NULL GROUP BY provider_id',
    ),
    all<{ id: string; raw: string; n: number }>(
      db,
      `SELECT provider_id AS id, provider_name_raw AS raw, COUNT(*) AS n FROM entries
        WHERE provider_id IS NOT NULL AND provider_name_raw IS NOT NULL
        GROUP BY provider_id, provider_name_raw`,
    ),
    all<{ raw: string; n: number }>(
      db,
      `SELECT e.provider_name_raw AS raw, COUNT(*) AS n FROM entries e
         JOIN documents d ON d.id = e.document_id
        WHERE e.provider_id IS NULL AND e.provider_name_raw IS NOT NULL
          AND d.status != 'discarded' AND e.review_reasons_json LIKE '%provider_suggestion%'
        GROUP BY lower(trim(e.provider_name_raw)) ORDER BY n DESC`,
    ),
  ]);
  const used = new Map(counts.map((r) => [r.id, Number(r.n)]));
  const list: ProviderUsage[] = providers.map((p) => {
    const alias_entries: Record<string, number> = {};
    for (const a of p.aliases) {
      const k = nameKey(a);
      alias_entries[a] = printed
        .filter((r) => r.id === p.id && nameKey(r.raw) === k)
        .reduce((n, r) => n + Number(r.n), 0);
    }
    return { ...p, entries: used.get(p.id) ?? 0, alias_entries };
  });
  const suggestions: ProviderSuggestion[] = pending.map((r) => {
    const m = matchProvider(r.raw, providers);
    return { raw: r.raw, entries: Number(r.n), suggested_id: m.kind === 'none' ? null : m.id };
  });
  return c.json({ providers: list, suggestions });
});

admin.post('/providers', async (c) => {
  const input = await body(c, providerInput);
  const now = nowIso();
  const id = newId();
  await insertStmt(c.env.DB, 'providers', {
    id,
    name: input.name,
    aliases_json: JSON.stringify(input.aliases ?? []),
    created_at: now,
    updated_at: now,
  }).run();
  return c.json(
    toProvider((await first(c.env.DB, 'SELECT * FROM providers WHERE id = ?', id))!),
    201,
  );
});

admin.patch('/providers/:id', async (c) => {
  const input = await body(c, providerPatch);
  const db = c.env.DB;
  const id = c.req.param('id');
  if (!(await first(db, 'SELECT 1 FROM providers WHERE id = ?', id))) throw notFound('Provider');
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.aliases !== undefined) fields.aliases_json = JSON.stringify(input.aliases);
  if (Object.keys(fields).length) await updateStmt(db, 'providers', id, fields).run();
  return c.json(toProvider((await first(db, 'SELECT * FROM providers WHERE id = ?', id))!));
});

/**
 * Merges a provider into another: its name becomes an alias of the target and its entries move.
 * This is the explicit "same provider" decision the app never makes on its own.
 */
admin.post('/providers/:id/merge', async (c) => {
  const db = c.env.DB;
  const { into } = await body(c, providerMerge);
  const fromId = c.req.param('id');
  if (fromId === into) throw new ApiError(400, 'invalid', 'Pick a different provider.');
  const [from, to] = await Promise.all([
    first(db, 'SELECT * FROM providers WHERE id = ?', fromId),
    first(db, 'SELECT * FROM providers WHERE id = ?', into),
  ]);
  if (!from || !to) throw notFound('Provider');
  const f = toProvider(from);
  const t = toProvider(to);
  let aliases = withAlias(t.name, t.aliases, f.name);
  for (const a of f.aliases) aliases = withAlias(t.name, aliases, a);
  await db.batch([
    updateStmt(db, 'providers', t.id, { aliases_json: JSON.stringify(aliases) }),
    db
      .prepare('UPDATE entries SET provider_id = ?, updated_at = ? WHERE provider_id = ?')
      .bind(t.id, nowIso(), f.id),
    db.prepare('DELETE FROM providers WHERE id = ?').bind(f.id),
  ]);
  return c.json(toProvider((await first(db, 'SELECT * FROM providers WHERE id = ?', t.id))!));
});

/** "Add provider alias" from Review: the printed name becomes an alias; matching entries resolve. */
admin.post('/providers/:id/alias', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const { alias } = (await c.req.json().catch(() => ({}))) as { alias?: string };
  if (!alias?.trim()) throw new ApiError(400, 'invalid', 'alias: Required');
  const row = await first(db, 'SELECT * FROM providers WHERE id = ?', id);
  if (!row) throw notFound('Provider');
  const p = toProvider(row);
  await updateStmt(db, 'providers', id, {
    aliases_json: JSON.stringify(withAlias(p.name, p.aliases, alias)),
  }).run();
  const rows = (
    await all(
      db,
      'SELECT * FROM entries WHERE provider_id IS NULL AND lower(trim(provider_name_raw)) = lower(trim(?))',
      alias,
    )
  ).map(toEntry);
  if (rows.length) {
    await db.batch(
      rows.map((e) =>
        updateStmt(db, 'entries', e.id, {
          provider_id: id,
          review_reasons_json: JSON.stringify(
            e.review_reasons.filter((r) => r !== 'provider_suggestion' && r !== 'unknown_provider'),
          ),
        }),
      ),
    );
    await refreshDocs(
      db,
      rows.map((e) => e.document_id),
    );
  }
  return c.json({
    provider: toProvider((await first(db, 'SELECT * FROM providers WHERE id = ?', id))!),
    resolved: rows.length,
  });
});

/** Entries of a provider that were printed with this spelling. */
async function aliasEntries(db: D1Database, providerId: string, alias: string) {
  const k = nameKey(alias);
  return (
    await all<{ id: string; raw: string; document_id: string }>(
      db,
      'SELECT id, provider_name_raw AS raw, document_id FROM entries WHERE provider_id = ? AND provider_name_raw IS NOT NULL',
      providerId,
    )
  ).filter((e) => nameKey(e.raw) === k);
}

/** Removes a wrong spelling. Only while no receipt was printed with it; otherwise move it. */
admin.post('/providers/:id/aliases/remove', async (c) => {
  const db = c.env.DB;
  const { alias } = await body(c, providerAlias);
  const row = await first(db, 'SELECT * FROM providers WHERE id = ?', c.req.param('id'));
  if (!row) throw notFound('Provider');
  const p = toProvider(row);
  const k = nameKey(alias);
  if (!p.aliases.some((a) => nameKey(a) === k)) throw notFound('Spelling');
  const n = (await aliasEntries(db, p.id, alias)).length;
  if (n > 0)
    throw new ApiError(
      409,
      'in_use',
      `${n} receipt${n === 1 ? ' uses' : 's use'} this spelling. Move it to the right provider instead.`,
    );
  await updateStmt(db, 'providers', p.id, {
    aliases_json: JSON.stringify(p.aliases.filter((a) => nameKey(a) !== k)),
  }).run();
  return c.json(toProvider((await first(db, 'SELECT * FROM providers WHERE id = ?', p.id))!));
});

/** Moves a spelling, and the receipts printed with it, to the provider it really belongs to. */
admin.post('/providers/:id/aliases/move', async (c) => {
  const db = c.env.DB;
  const { alias, into } = await body(c, providerAliasMove);
  const fromId = c.req.param('id');
  if (fromId === into) throw new ApiError(400, 'invalid', 'Pick a different provider.');
  const [from, to] = await Promise.all([
    first(db, 'SELECT * FROM providers WHERE id = ?', fromId),
    first(db, 'SELECT * FROM providers WHERE id = ?', into),
  ]);
  if (!from || !to) throw notFound('Provider');
  const f = toProvider(from);
  const t = toProvider(to);
  const k = nameKey(alias);
  const spelled = f.aliases.find((a) => nameKey(a) === k);
  if (!spelled) throw notFound('Spelling');
  const moving = await aliasEntries(db, f.id, spelled);
  const now = nowIso();
  await db.batch([
    updateStmt(db, 'providers', f.id, {
      aliases_json: JSON.stringify(f.aliases.filter((a) => nameKey(a) !== k)),
    }),
    updateStmt(db, 'providers', t.id, {
      aliases_json: JSON.stringify(withAlias(t.name, t.aliases, spelled)),
    }),
    ...moving.map((e) =>
      db
        .prepare('UPDATE entries SET provider_id = ?, updated_at = ? WHERE id = ?')
        .bind(t.id, now, e.id),
    ),
  ]);
  if (moving.length)
    await refreshDocs(
      db,
      moving.map((e) => e.document_id),
    );
  return c.json({ moved: moving.length });
});

// Providers aren't deleted: extraction would only recreate them. Merge or rename instead.

// ---------- categories ----------

admin.post('/categories', async (c) => {
  const input = await body(c, categoryInput);
  const db = c.env.DB;
  if (await first(db, 'SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE', input.name))
    throw new ApiError(409, 'exists', 'That category already exists.');
  const max =
    (
      await first<{ m: number }>(
        db,
        "SELECT MAX(sort_order) AS m FROM categories WHERE name != 'Other'",
      )
    )?.m ?? 0;
  const id = newId();
  await insertStmt(db, 'categories', {
    id,
    name: input.name,
    sort_order: input.sort_order ?? max + 1,
  }).run();
  return c.json({ id, name: input.name, sort_order: input.sort_order ?? max + 1 }, 201);
});

/** "Other" is the AI's fallback, so it always exists, under that name. */
const OTHER_CATEGORY = 'cat-other';
function keepOther(id: string) {
  if (id === OTHER_CATEGORY)
    throw new ApiError(409, 'permanent', 'Other is always kept: the AI uses it as a fallback.');
}

admin.patch('/categories/:id', async (c) => {
  keepOther(c.req.param('id'));
  const input = await body(c, categoryPatch);
  const db = c.env.DB;
  const id = c.req.param('id');
  if (!(await first(db, 'SELECT 1 FROM categories WHERE id = ?', id))) throw notFound('Category');
  if (
    input.name !== undefined &&
    (await first(
      db,
      'SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE AND id != ?',
      input.name,
      id,
    ))
  )
    throw new ApiError(409, 'exists', 'That category already exists.');
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.sort_order !== undefined) fields.sort_order = input.sort_order;
  if (Object.keys(fields).length)
    await updateStmt(db, 'categories', id, fields, { touch: false }).run();
  return c.json({ ok: true });
});

/** Settings → Categories: every category with how many entries use it. */
admin.get('/categories', async (c) => {
  const db = c.env.DB;
  const [categories, counts] = await Promise.all([
    loadCategories(db),
    all<{ id: string; n: number }>(
      db,
      'SELECT category_id AS id, COUNT(*) AS n FROM entries WHERE category_id IS NOT NULL GROUP BY category_id',
    ),
  ]);
  const used = new Map(counts.map((r) => [r.id, Number(r.n)]));
  const list: CategoryUsage[] = categories.map((x) => ({
    ...x,
    entries: used.get(x.id) ?? 0,
    permanent: x.id === OTHER_CATEGORY,
  }));
  return c.json({ categories: list });
});

/** Moves a category's entries to another category, then deletes it. */
admin.post('/categories/:id/merge', async (c) => {
  const db = c.env.DB;
  const { into } = await body(c, categoryMerge);
  const fromId = c.req.param('id');
  keepOther(fromId);
  if (fromId === into) throw new ApiError(400, 'invalid', 'Pick a different category.');
  const [from, to] = await Promise.all([
    first(db, 'SELECT 1 FROM categories WHERE id = ?', fromId),
    first(db, 'SELECT 1 FROM categories WHERE id = ?', into),
  ]);
  if (!from || !to) throw notFound('Category');
  const [moved] = await db.batch([
    db
      .prepare('UPDATE entries SET category_id = ?, updated_at = ? WHERE category_id = ?')
      .bind(into, nowIso(), fromId),
    db.prepare('DELETE FROM categories WHERE id = ?').bind(fromId),
  ]);
  return c.json({ ok: true, moved: moved?.meta.changes ?? 0 });
});

/** Only an unused category can be deleted; a used one is merged into another instead. */
admin.delete('/categories/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  keepOther(id);
  const n =
    (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM entries WHERE category_id = ?', id))
      ?.n ?? 0;
  if (n > 0)
    throw new ApiError(
      409,
      'in_use',
      `${n} entr${n === 1 ? 'y uses' : 'ies use'} this category. Merge it into another instead.`,
    );
  await db.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// ---------- backup ----------

export async function exportAll(db: D1Database): Promise<HsaExport> {
  const tables: HsaExport['tables'] = {};
  for (const t of TABLE_ORDER) {
    let rows = await all<ExportRow>(db, `SELECT * FROM ${t}`);
    if (t === 'settings') rows = rows.filter((r) => !PRIVATE_SETTINGS.includes(String(r.key)));
    tables[t] = rows;
  }
  const files = (tables.documents ?? []).flatMap((d) =>
    [d.file_key, d.eml_key].filter((k): k is string => typeof k === 'string' && !!k),
  );
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    tables,
    files: [...new Set(files)],
  };
}

/** Replaces all data with the export's rows in one atomic batch. */
export async function importAll(
  db: D1Database,
  data: HsaExport,
  { replace }: { replace: boolean },
) {
  const stmts: D1PreparedStatement[] = [db.prepare('PRAGMA defer_foreign_keys = ON')];
  if (replace) {
    for (const t of [...TABLE_ORDER].reverse()) {
      stmts.push(
        t === 'settings'
          ? db
              .prepare(
                `DELETE FROM settings WHERE key NOT IN (${PRIVATE_SETTINGS.map(() => '?').join(',')})`,
              )
              .bind(...PRIVATE_SETTINGS)
          : db.prepare(`DELETE FROM ${t}`),
      );
    }
  }
  for (const t of TABLE_ORDER) {
    for (const row of data.tables[t] ?? []) {
      if (t === 'settings' && PRIVATE_SETTINGS.includes(String(row.key))) continue;
      const { cols, vals } = rowValues(t, row);
      if (!cols.length) continue;
      stmts.push(
        db
          .prepare(
            `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          )
          .bind(...vals),
      );
    }
  }
  await db.batch(stmts);
}

admin.get('/export', async (c) => {
  const data = await exportAll(c.env.DB);
  const stamp = data.exported_at.slice(0, 10);
  return c.json(data, 200, {
    'Content-Disposition': `attachment; filename="hsa-locker-backup-${stamp}.json"`,
    'Cache-Control': 'no-store',
  });
});

admin.post('/import', async (c) => {
  const raw = await c.req.json().catch(() => null);
  if (!isHsaExport(raw))
    throw new ApiError(400, 'invalid', 'That file is not an HSA Locker backup.');
  if (raw.version > EXPORT_VERSION)
    throw new ApiError(
      400,
      'invalid',
      'That backup is from a newer version of HSA Locker. Update this instance first.',
    );
  try {
    await importAll(c.env.DB, raw, { replace: true });
  } catch (e) {
    throw new ApiError(400, 'invalid', `Could not restore that backup: ${(e as Error).message}`);
  }
  // Which documents' files are missing here (restore them with the documents export).
  const keys = (raw.tables.documents ?? [])
    .filter((d) => d.status !== 'discarded')
    .map((d) => String(d.file_key));
  let missing = 0;
  for (const k of keys.slice(0, 1000)) if (!(await c.env.FILES.head(k))) missing++;
  return c.json({ ok: true, documents: keys.length, missing_files: missing });
});

/**
 * Puts one document's original file back from the documents export (the app reads the ZIP and
 * sends each file with its document id). Only fills in a missing file; never overwrites.
 */
admin.post('/restore-file/:id', async (c) => {
  const row = await first<{ file_key: string; mime: string; sha256: string }>(
    c.env.DB,
    'SELECT file_key, mime, sha256 FROM documents WHERE id = ?',
    c.req.param('id'),
  );
  if (!row) throw notFound('Document');
  if (await c.env.FILES.head(row.file_key)) return c.json({ ok: true, skipped: true });
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const { sha256Hex } = await import('../store');
  if ((await sha256Hex(bytes)) !== row.sha256)
    throw new ApiError(400, 'invalid', 'That file doesn’t match the document it’s for.');
  await c.env.FILES.put(row.file_key, bytes, { httpMetadata: { contentType: row.mime } });
  return c.json({ ok: true });
});

// ---------- sample data ----------

async function isEmpty(db: D1Database): Promise<boolean> {
  const r = await first<{ n: number }>(
    db,
    'SELECT (SELECT COUNT(*) FROM people) + (SELECT COUNT(*) FROM documents) AS n',
  );
  return (r?.n ?? 0) === 0;
}

admin.post('/sample-data', async (c) => {
  if (!(await isEmpty(c.env.DB)))
    throw new ApiError(
      409,
      'not_empty',
      'Sample data can only be loaded into an empty HSA Locker.',
    );
  const data = sample as unknown as HsaExport;
  await importAll(c.env.DB, data, { replace: false });
  // Each sample document gets a short placeholder file so previews work.
  for (const d of data.tables.documents ?? [])
    await c.env.FILES.put(
      String(d.file_key),
      `SAMPLE DOCUMENT (synthetic, not a real receipt)\n${d.filename}\n`,
      { httpMetadata: { contentType: 'text/plain' } },
    );
  return c.json({ ok: true }, 201);
});

// ---------- danger zone ----------

admin.post('/delete-everything', async (c) => {
  await body(c, deleteAllInput);
  const db = c.env.DB;
  // Files first, so nothing is left orphaned if this is interrupted.
  let cursor: string | undefined;
  do {
    const page = await c.env.FILES.list({ cursor, limit: 1000 });
    if (page.objects.length) await c.env.FILES.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await db.batch([
    db.prepare('DELETE FROM entries'),
    db.prepare('DELETE FROM reimbursements'),
    db.prepare('DELETE FROM documents'),
    db.prepare('DELETE FROM inbox_verifications'),
    db.prepare('DELETE FROM inbox_log'),
    db.prepare('DELETE FROM providers'),
    db.prepare('DELETE FROM people'),
    db.prepare("DELETE FROM settings WHERE key NOT IN ('session_salt', 'inbox_token')"),
  ]);
  return c.json({ ok: true });
});

// ---------- AI ----------

/** A synthetic receipt, read with the active provider, so Settings → AI can prove it works. */
const TEST_RECEIPT = `SAMPLE CLINIC (test document, not real)
Patient: Sam Example
Date of service: 03/05/2024
Office visit
Amount paid: $45.00
Visa ending 1234`;

admin.post('/ai/test', async (c) => {
  const { getProvider: provider, ProviderError } = await import('../extract/providers');
  const { systemPrompt, textPrompt } = await import('../extract/prompt');
  const { extractionSchema, parseModelJson, draftsFrom } = await import('@shared/extraction');
  const p = provider(c.env);
  const started = Date.now();
  try {
    const categories = (await loadCategories(c.env.DB)).map((x) => x.name);
    const text =
      p.id === 'fake'
        ? `${TEST_RECEIPT}\nFAKE_EXTRACTION:{"document_type":"Receipt","line_items":[{"amount":"45.00","appointment_date":"2024-03-05"}]}`
        : TEST_RECEIPT;
    const r = await p.complete({
      system: systemPrompt(categories),
      user: textPrompt(text, 'test.txt'),
    });
    const { kind, drafts } = draftsFrom(extractionSchema.parse(parseModelJson(r.text)));
    const d = drafts[0];
    const ok = kind === 'receipt' && d?.amount_cents === 4500 && d?.service_date === '2024-03-05';
    return c.json({
      ok,
      provider: p.id,
      model: r.model,
      ms: Date.now() - started,
      result: d
        ? {
            kind,
            amount_cents: d.amount_cents,
            service_date: d.service_date,
            patient: d.patient_name_raw,
            card_last4: d.card_last4,
          }
        : { kind },
    });
  } catch (e) {
    return c.json({
      ok: false,
      provider: p.id,
      ms: Date.now() - started,
      error: e instanceof ProviderError ? e.message : 'invalid_reply',
    });
  }
});

// ---------- notifications ----------

/** Sends the review reminder right now, to check the setup. */
admin.post('/notify/test', async (c) => {
  await rememberOrigin(c.env.DB, new URL(c.req.url).origin);
  return c.json(await sendReminder(c.env, { test: true }));
});
