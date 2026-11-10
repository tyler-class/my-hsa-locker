// Imports an HSA Wizard Google Sheet (and its Drive folder) into HSA Locker.
// See docs/importing-from-hsa-wizard.md.
//
//   npm run import:hsa-wizard -- --csv log.csv --files ./drive-folder --url http://localhost:5173 --dry-run
//   npm run import:hsa-wizard -- --csv log.csv --files ./drive-folder --url https://hsa-locker.you.workers.dev
//
// It talks to the app's API (sign in with the household password), so the same command works
// against `npm run dev` and a deployed copy. Re-running it is safe: files are matched by their
// SHA-256 and a document's entries are only added once.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  draftMapping,
  importReasons,
  planDocuments,
  readLegacyCsv,
  type ImportMapping,
  type LegacyRow,
} from '../src/shared/legacyImport';
import { mimeFromName, nameKey, stripLegacyPrefixes } from '../src/shared/logic';
import type { AppState } from '../src/shared/types';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);

const csvPath = arg('csv');
const filesDir = arg('files');
const baseUrl = (arg('url') ?? 'http://localhost:5173').replace(/\/$/, '');
const mappingPath = arg('mapping') ?? 'hsa-wizard-mapping.local.json';
const family = (arg('family') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const dryRun = flag('dry-run');

if (!csvPath) {
  console.error(
    'Usage: npm run import:hsa-wizard -- --csv <log.csv> [--files <folder>] [--url <app url>] [--family "Lastname"] [--mapping <file>] [--dry-run]',
  );
  process.exit(1);
}

// ---------- read ----------

const rows = readLegacyCsv(readFileSync(csvPath, 'utf8'));
console.log(`Read ${rows.length} rows from ${csvPath}.`);

/** Every file under the folder, by stripped name and by MD5 (the sheet's Content Hash). */
function indexFiles(dir: string | undefined) {
  const byName = new Map<string, string>();
  const byMd5 = new Map<string, string>();
  if (!dir) return { byName, byMd5 };
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        byName.set(stripLegacyPrefixes(name).toLowerCase(), p);
        byMd5.set(createHash('md5').update(readFileSync(p)).digest('hex'), p);
      }
    }
  };
  walk(dir);
  return { byName, byMd5 };
}
const files = indexFiles(filesDir);
if (filesDir) console.log(`Found ${files.byName.size} files under ${filesDir}.`);

// ---------- mapping ----------

let mapping: ImportMapping;
if (existsSync(mappingPath)) {
  mapping = JSON.parse(readFileSync(mappingPath, 'utf8')) as ImportMapping;
  console.log(`Using name mapping from ${mappingPath}.`);
} else {
  mapping = draftMapping(rows, family);
  writeFileSync(mappingPath, JSON.stringify(mapping, null, 2) + '\n');
  console.log(
    `\nWrote a draft name mapping to ${mappingPath}. Check it: each printed name points at the person or provider it should become.\n` +
      (dryRun ? '' : 'Then run this command again.\n'),
  );
  if (!dryRun) process.exit(0);
}

const plan = planDocuments(rows, mapping);
const fileFor = (d: (typeof plan)[number]) =>
  (d.md5 && files.byMd5.get(d.md5)) ||
  (d.file_name && files.byName.get(d.file_name.toLowerCase())) ||
  null;

// ---------- report ----------

const byYear = new Map<
  string,
  { receipts: number; eobLines: number; eobDocs: Set<string>; cents: number }
>();
for (const d of plan)
  for (const r of d.rows) {
    const y = (r.service_date ?? r.payment_date ?? r.processed_at ?? 'undated').slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, { receipts: 0, eobLines: 0, eobDocs: new Set(), cents: 0 });
    const t = byYear.get(y)!;
    if (r.type === 'eob') {
      t.eobLines++;
      t.eobDocs.add(d.key);
    } else {
      t.receipts++;
      t.cents += r.amount_cents ?? 0;
    }
  }
const unmatched = plan.filter((d) => !fileFor(d));
const collapsed = plan.reduce((s, d) => s + d.collapsed, 0);
const unmappedPeople = [
  ...new Set(rows.filter((r) => r.patient && !mapping.people[r.patient]).map((r) => r.patient!)),
];
const badAmounts = rows.filter(
  (r) => r.type === 'receipt' && r.amount_raw && r.amount_cents === null,
);

console.log('\nYear   Receipts   Total        EOB docs  EOB lines');
for (const [y, t] of [...byYear.entries()].sort().reverse())
  console.log(
    `${y.padEnd(6)} ${String(t.receipts).padStart(8)}   ${('$' + (t.cents / 100).toFixed(2)).padStart(11)}  ${String(t.eobDocs.size).padStart(8)}  ${String(t.eobLines).padStart(9)}`,
  );
console.log(`\nDocuments: ${plan.length} (from ${rows.length} rows)`);
console.log(`Identical rows collapsed: ${collapsed}`);
for (const d of plan.filter((x) => x.collapsed))
  console.log(`  ${d.file_name ?? d.key}: ${d.collapsed}`);
console.log(
  `Documents with no matching file: ${unmatched.length}${filesDir ? '' : ' (no --files folder given)'}`,
);
for (const d of unmatched.slice(0, 20)) console.log(`  ${d.file_name ?? d.key}`);
if (unmatched.length > 20) console.log(`  …and ${unmatched.length - 20} more`);
console.log(`Printed patient names missing from the mapping: ${unmappedPeople.length}`);
for (const p of unmappedPeople) console.log(`  ${p}`);
console.log(`Receipt amounts that don't parse: ${badAmounts.length}`);
for (const r of badAmounts.slice(0, 10)) console.log(`  line ${r.line}: "${r.amount_raw}"`);

if (dryRun) {
  console.log('\nDry run: nothing was imported.');
  process.exit(0);
}

// ---------- import ----------

async function password(): Promise<string> {
  if (process.env.HSA_LOCKER_PASSWORD) return process.env.HSA_LOCKER_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pw = await rl.question('Household password: ');
  rl.close();
  return pw;
}

let cookie = '';
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  raw?: { bytes: Uint8Array; headers: Record<string, string> },
): Promise<T> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      Origin: baseUrl,
      Cookie: cookie,
      ...(raw ? raw.headers : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw ? Buffer.from(raw.bytes) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return (text ? JSON.parse(text) : null) as T;
}

await call('POST', '/login', { password: await password() });
let state = await call<AppState>('GET', '/state');

// People: one per canonical name; every printed spelling becomes an alias.
const personId = new Map<string, string>();
for (const canonical of new Set(Object.values(mapping.people).filter(Boolean))) {
  const aliases = Object.entries(mapping.people)
    .filter(([printed, c]) => c === canonical && printed !== canonical)
    .map(([printed]) => printed);
  let p = state.people.find((x) => nameKey(x.name) === nameKey(canonical));
  if (!p) p = await call('POST', '/people', { name: canonical, aliases });
  else if (aliases.some((a) => !p!.aliases.includes(a)))
    p = await call('PATCH', `/people/${p.id}`, {
      aliases: [...new Set([...p.aliases, ...aliases])],
    });
  personId.set(canonical, p!.id);
}
if (family.length) await call('PATCH', '/settings', { family_names: family });

// Providers: canonical names, truncated spellings as aliases.
const providerId = new Map<string, string>();
for (const canonical of new Set(Object.values(mapping.providers).filter(Boolean))) {
  const aliases = Object.entries(mapping.providers)
    .filter(([printed, c]) => c === canonical && printed !== canonical)
    .map(([printed]) => printed);
  let p = state.providers.find((x) => nameKey(x.name) === nameKey(canonical));
  if (!p) p = await call('POST', '/providers', { name: canonical, aliases });
  else if (aliases.some((a) => !p!.aliases.includes(a)))
    p = await call('PATCH', `/providers/${p.id}`, {
      aliases: [...new Set([...p.aliases, ...aliases])],
    });
  providerId.set(canonical, p!.id);
}

// Categories: create any the sheet used that don't exist yet.
for (const name of new Set(rows.map((r) => r.category).filter((c): c is string => !!c)))
  if (!state.categories.some((c) => nameKey(c.name) === nameKey(name)))
    await call('POST', '/categories', { name });
state = await call<AppState>('GET', '/state');
const categoryId = new Map(state.categories.map((c) => [nameKey(c.name), c.id]));

let added = 0;
let skipped = 0;
for (const [i, d] of plan.entries()) {
  const path = fileFor(d);
  const bytes = path
    ? new Uint8Array(readFileSync(path))
    : new TextEncoder().encode(
        `HSA Wizard row without a file (${d.file_name ?? d.key}). Imported ${new Date().toISOString()}.\n`,
      );
  const name = path
    ? basename(path)
    : `${(d.file_name ?? 'missing-file').replace(extname(d.file_name ?? ''), '')}.txt`;
  const mime = path ? (mimeFromName(path) ?? 'application/octet-stream') : 'text/plain';
  const first: LegacyRow = d.rows[0]!;
  const doc = await call<{ id: string; duplicate: boolean }>(
    'POST',
    '/legacy-import/document',
    undefined,
    {
      bytes,
      headers: {
        'Content-Type': mime,
        'X-File-Name': encodeURIComponent(stripLegacyPrefixes(name)),
        'X-Original-Name': encodeURIComponent(d.file_name ?? name),
        ...(d.md5 ? { 'X-Legacy-Md5': d.md5 } : {}),
        ...(first.processed_at ? { 'X-Received-At': first.processed_at } : {}),
      },
    },
  );
  const r = await call<{ added: number; skipped: boolean }>('POST', '/legacy-import/entries', {
    document_id: doc.id,
    kind: d.kind,
    document_reasons: path ? [] : ['legacy_file_missing'],
    entries: d.rows.map((row) => {
      const canonical = row.patient ? mapping.people[row.patient] : undefined;
      const pid = canonical ? (personId.get(canonical) ?? null) : null;
      const prov = row.provider ? (mapping.providers[row.provider] ?? row.provider) : null;
      return {
        type: row.type,
        service_date: row.service_date,
        payment_date: row.payment_date,
        person_id: pid,
        patient_name_raw: row.patient,
        provider_id: prov ? (providerId.get(prov) ?? null) : null,
        provider_name_raw: row.provider,
        description: row.description,
        category_id: row.category ? (categoryId.get(nameKey(row.category)) ?? null) : null,
        amount_cents: row.amount_cents,
        card_last4: row.card_last4,
        notes: row.notes,
        review_reasons: importReasons(row, !!pid),
        processed_at: row.processed_at ? `${row.processed_at}T00:00:00.000Z` : null,
      };
    }),
  });
  if (r.skipped) skipped++;
  else added += r.added;
  process.stdout.write(`\r${i + 1}/${plan.length} documents`);
}
console.log(
  `\nImported ${added} entries. ${skipped} documents were already imported and left as they were.`,
);
