// Insights: answers to the questions people ask about their HSA, as a board of panels the owner
// arranges (drag, half/full width, hide), like Ratio's and Nitrogen's. Everything is computed in
// the app from the ledger and the reimbursements, with the money rules in shared/logic. Each
// panel's toggle filters that panel only.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AppState, InsightsPanel } from '@shared/types';
import {
  aging,
  balanceSeries,
  breakdown,
  glance,
  monthLabel,
  periods,
  type BreakdownBy,
  type PeriodUnit,
  type Window,
} from '@shared/logic';
import { PERSON_DOT } from '../components/bits';
import {
  BalanceLines,
  Legend,
  Rank,
  ShareBar,
  StackedColumns,
  Tile,
  type LinePoint,
} from '../components/charts';
import { PanelBoard, type PanelDef } from '../components/Panels';
import { Empty, PageHeader, SlideToggle } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, money, plural } from '../lib/format';
import { keys, useAppState, useLedger, useReimbursements } from '../lib/queries';

/** Today on this device's calendar, YYYY-MM-DD. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "6 years", "8 months", "12 days" since a date. */
function age(date: string, today: string): string {
  const days = Math.max(0, Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000));
  if (days >= 365) return plural(Math.floor(days / 365.25), 'year');
  if (days >= 60) return plural(Math.floor(days / 30.44), 'month');
  return plural(days, 'day');
}

type Range = '1y' | '3y' | 'all';
const RANGES: [Range, string][] = [
  ['1y', '1 year'],
  ['3y', '3 years'],
  ['all', 'All'],
];
const UNITS: [PeriodUnit, string][] = [
  ['month', 'Month'],
  ['quarter', 'Quarter'],
  ['year', 'Year'],
];
const WINDOWS: [Window, string][] = [
  ['this', 'This year'],
  ['last', 'Last year'],
  ['all', 'All time'],
];
// Where the money sits, bottom to top in the stacked bars.
const STATUS_TONES = ['reimbursed', 'outstanding', 'review', 'excluded'];
const STATUS_LEGEND: [string, string][] = [
  ['reimbursed', 'Reimbursed'],
  ['outstanding', 'Reimbursable'],
  ['review', 'In review'],
  ['excluded', 'Not claimable'],
];

export function Insights() {
  const qc = useQueryClient();
  const { data: state } = useAppState();
  const ledger = useLedger();
  const reimb = useReimbursements();
  // One piece of state per panel control: nothing here is shared between panels.
  const [range, setRange] = useState<Range>('3y');
  const [unit, setUnit] = useState<PeriodUnit>('month');
  const [catWin, setCatWin] = useState<Window>('this');
  const [personWin, setPersonWin] = useState<Window>('this');
  const [provWin, setProvWin] = useState<Window>('this');

  if (!state || !ledger.data || !reimb.data) return null;
  const entries = ledger.data;
  const reimbursements = reimb.data;
  const basis = state.settings.year_basis;
  const today = localToday();
  const year = Number(today.slice(0, 4));

  const header = <PageHeader title="Insights" icon="chart" />;
  if (!entries.some((e) => e.type === 'receipt'))
    return (
      <div className="pb-12">
        {header}
        <Empty title="Nothing to chart yet">
          Insights fill in once you have a few receipts: how much you can reimburse, how it built
          up, and where it goes.
        </Empty>
      </div>
    );

  const saveLayout = (insights_layout: InsightsPanel[]) => {
    qc.setQueryData<AppState>(keys.state, (old) =>
      old ? { ...old, settings: { ...old.settings, insights_layout } } : old,
    );
    void api.patch('/settings', { insights_layout }).catch(() => {
      void qc.invalidateQueries({ queryKey: keys.state });
    });
  };

  const g = glance(entries, reimbursements, basis);

  // Balance over time, trimmed to the chosen range (values stay cumulative).
  const series = balanceSeries(entries, reimbursements, basis, today);
  const months = range === '1y' ? 12 : range === '3y' ? 36 : Infinity;
  const shown = series.slice(-Math.min(series.length, months));
  const spanYears = shown.length > 24;
  const points: LinePoint[] = shown.map((p) => ({
    label: spanYears
      ? p.month.endsWith('-01')
        ? p.month.slice(0, 4)
        : ''
      : monthLabel(p.month).replace(/ (\d{2})(\d{2})$/, ' ’$2'),
    a: p.claimable_cents,
    b: p.reimbursed_cents,
    title: `${monthLabel(p.month)}: ${money(p.claimable_cents - p.reimbursed_cents)} reimbursable (${money(p.claimable_cents)} claimable, ${money(p.reimbursed_cents)} reimbursed)`,
  }));

  const per = periods(entries, basis, today, unit);
  const ages = aging(entries, basis, today);
  const AGE_TONES = ['age1', 'age2', 'age3', 'age4', 'age5', 'age0'];

  const names = {
    category: new Map(state.categories.map((c) => [c.id, c.name])),
    person: new Map(state.people.map((p) => [p.id, p])),
    provider: new Map(state.providers.map((p) => [p.id, p.name])),
  };
  const winYear = (w: Window) => (w === 'this' ? year : w === 'last' ? year - 1 : null);
  const ranked = (by: BreakdownBy, w: Window, limit: number) => {
    const rows = breakdown(entries, basis, today, by, w).slice(0, limit);
    const y = winYear(w);
    return {
      max: rows[0]?.cents ?? 0,
      rows: rows.map((r) => {
        const p = by === 'person' && r.id ? names.person.get(r.id) : undefined;
        const label =
          (by === 'category'
            ? r.id && names.category.get(r.id)
            : by === 'person'
              ? p?.name
              : r.id && names.provider.get(r.id)) ||
          (by === 'category'
            ? 'No category'
            : by === 'person'
              ? 'Unknown patient'
              : 'Unknown provider');
        const q = new URLSearchParams();
        if (r.id) q.set(by, r.id);
        if (y) q.set('year', String(y));
        return {
          key: r.id ?? 'none',
          label,
          value: r.cents,
          vl: money(r.cents),
          sub: `${plural(r.count, 'receipt')}${r.reimbursable_cents ? ` · ${money(r.reimbursable_cents)} reimbursable` : ''}`,
          color: p ? (PERSON_DOT[p.color] ?? PERSON_DOT.mist) : undefined,
          to: r.id ? `/ledger?${q}` : undefined,
        };
      }),
    };
  };
  const emptyFor = (w: Window) =>
    `No receipts ${w === 'this' ? `in ${year}` : w === 'last' ? `in ${year - 1}` : 'yet'}.`;
  const cats = ranked('category', catWin, 8);
  const ppl = ranked('person', personWin, 8);
  const provs = ranked('provider', provWin, 8);
  const withdrawals = [...reimbursements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  const maxW = Math.max(0, ...withdrawals.map((r) => r.total_cents));

  const panels: PanelDef[] = [
    {
      id: 'glance',
      title: 'At a glance',
      size: 'full',
      body: (
        <div className="stats">
          <Tile
            label="Reimbursable"
            value={money(g.reimbursable_cents)}
            sub={plural(g.reimbursable_count, 'receipt')}
            to="/ledger?status=outstanding"
            title="Receipts you can withdraw from your HSA tax-free: not reimbursed, not excluded, not waiting for review"
          />
          <Tile
            label="Reimbursed"
            value={money(g.reimbursed_cents)}
            sub={
              g.last_withdrawal
                ? `${plural(g.withdrawals, 'withdrawal')} · last ${formatDate(g.last_withdrawal)}`
                : 'No withdrawals yet'
            }
            to="/ledger?status=reimbursed"
          />
          <Tile
            label="Documented"
            value={money(g.documented_cents)}
            sub={plural(g.documented_count, 'receipt')}
            to="/ledger?type=receipt"
            title="Every receipt on file, whatever its status"
          />
          <Tile
            label="In review"
            value={money(g.review_cents)}
            sub={g.review_count ? plural(g.review_count, 'receipt') : 'Nothing waiting'}
            to="/review"
            title="Not counted as reimbursable until you check it in Review"
          />
          <Tile
            label="Not claimable"
            value={money(g.excluded_cents)}
            sub={g.excluded_count ? plural(g.excluded_count, 'receipt') : 'None'}
            to="/ledger?status=excluded"
            title="Paid with the HSA card, not eligible, or reimbursed another way"
          />
          <Tile
            label="Oldest unreimbursed"
            value={g.oldest_reimbursable ? age(g.oldest_reimbursable, today) : '—'}
            sub={g.oldest_reimbursable ? formatDate(g.oldest_reimbursable) : 'Nothing outstanding'}
            title="How long your oldest reimbursable receipt has been waiting. There's no deadline, as long as you keep the receipt."
          />
        </div>
      ),
    },
    {
      id: 'balance',
      title: 'Reimbursable over time',
      sub: 'Claimable receipts vs. what you’ve withdrawn; the gap is what you can still take out',
      size: 'full',
      actions: <SlideToggle label="Range" value={range} options={RANGES} onChange={setRange} />,
      body: shown.length ? (
        <>
          <BalanceLines data={points} />
          <Legend
            items={[
              ['claimable', 'Claimable receipts'],
              ['reimbursed', 'Reimbursed'],
              ['band', 'Reimbursable'],
            ]}
          />
        </>
      ) : (
        <p className="empty">No claimable receipts yet.</p>
      ),
    },
    {
      id: 'periods',
      title: 'Spending by period',
      sub:
        (unit === 'month'
          ? 'Last 12 months'
          : unit === 'quarter'
            ? 'Last 8 quarters'
            : 'Every year') +
        ', by date of care' +
        (per.undated_count
          ? ` · ${plural(per.undated_count, 'receipt')} with no date not shown`
          : ''),
      size: 'full',
      actions: <SlideToggle label="Period" value={unit} options={UNITS} onChange={setUnit} />,
      body: (
        <>
          <StackedColumns
            tones={STATUS_TONES}
            data={per.rows.map((r) => ({
              label: r.label,
              current: r.current,
              values: [r.reimbursed_cents, r.outstanding_cents, r.review_cents, r.excluded_cents],
              title: `${r.label}${r.current ? ' (so far)' : ''}: ${money(r.reimbursed_cents + r.outstanding_cents + r.review_cents + r.excluded_cents)} spent · ${money(r.reimbursed_cents)} reimbursed · ${money(r.outstanding_cents)} reimbursable · ${money(r.review_cents)} in review · ${money(r.excluded_cents)} not claimable`,
            }))}
          />
          <Legend items={STATUS_LEGEND} />
        </>
      ),
    },
    {
      id: 'aging',
      title: 'Age of reimbursable receipts',
      sub: 'How long ago the care was. There’s no deadline to reimburse yourself.',
      size: 'half',
      body: g.reimbursable_cents ? (
        <>
          <ShareBar
            parts={ages.map((b, i) => ({
              key: b.key,
              value: b.cents,
              tone: b.key === 'undated' ? 'age0' : AGE_TONES[i]!,
              title: `${b.label}: ${money(b.cents)}, ${plural(b.count, 'receipt')}`,
            }))}
          />
          <ul className="rows">
            {ages.map((b, i) => (
              <li key={b.key} className={b.count ? undefined : 'none'}>
                <i className={`tone-${b.key === 'undated' ? 'age0' : AGE_TONES[i]}`} />
                <span className="rl">{b.label}</span>
                <span className="rn">{b.count ? plural(b.count, 'receipt') : ''}</span>
                <span className="rv">{b.count ? money(b.cents) : '—'}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="empty">Nothing reimbursable right now.</p>
      ),
    },
    {
      id: 'withdrawals',
      title: 'Reimbursements',
      sub: 'Money you’ve taken out of your HSA',
      size: 'half',
      body: withdrawals.length ? (
        <Rank
          max={maxW}
          rows={withdrawals.map((r) => ({
            key: r.id,
            label: formatDate(r.date),
            value: r.total_cents,
            vl: money(r.total_cents),
            sub: plural(r.entry_count, 'receipt') + (r.note ? ` · ${r.note}` : ''),
            color: 'var(--ok)',
            to: `/reimbursements/${r.id}`,
          }))}
        />
      ) : (
        <p className="empty">No reimbursements yet. Select receipts in the Ledger to record one.</p>
      ),
    },
    {
      id: 'categories',
      title: 'By category',
      sub: 'Spending on every receipt',
      size: 'half',
      actions: (
        <SlideToggle
          label="Category window"
          value={catWin}
          options={WINDOWS}
          onChange={setCatWin}
        />
      ),
      body: cats.rows.length ? (
        <Rank rows={cats.rows} max={cats.max} />
      ) : (
        <p className="empty">{emptyFor(catWin)}</p>
      ),
    },
    {
      id: 'people',
      title: 'By person',
      sub: 'Spending on every receipt',
      size: 'half',
      actions: (
        <SlideToggle
          label="Person window"
          value={personWin}
          options={WINDOWS}
          onChange={setPersonWin}
        />
      ),
      body: ppl.rows.length ? (
        <Rank rows={ppl.rows} max={ppl.max} />
      ) : (
        <p className="empty">{emptyFor(personWin)}</p>
      ),
    },
    {
      id: 'providers',
      title: 'Top providers',
      sub: 'Spending on every receipt',
      size: 'half',
      actions: (
        <SlideToggle
          label="Provider window"
          value={provWin}
          options={WINDOWS}
          onChange={setProvWin}
        />
      ),
      body: provs.rows.length ? (
        <Rank rows={provs.rows} max={provs.max} />
      ) : (
        <p className="empty">{emptyFor(provWin)}</p>
      ),
    },
  ];

  return (
    <div className="ins pb-12">
      {header}
      <div className="px-5 md:px-0">
        <PanelBoard defs={panels} saved={state.settings.insights_layout} onSave={saveLayout} />
      </div>
    </div>
  );
}
