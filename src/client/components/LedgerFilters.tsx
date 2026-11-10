// The Ledger's filter bar: a status switch, search, one Filters button (sheet) and sort.
import { useState } from 'react';
import type { LedgerFilter, SortKey, StatusFilter, TypeFilter } from '@shared/logic';
import type { AppState } from '@shared/types';
import { Icon } from './Icon';
import { Select } from './Select';
import { cx, GhostButton, PrimaryButton, Sheet, SlideToggle, TextInput } from './ui';

const STATUS_TABS: [StatusFilter, string][] = [
  ['all', 'All'],
  ['needs_review', 'Needs review'],
  ['outstanding', 'Reimbursable'],
  ['reimbursed', 'Reimbursed'],
  ['excluded', 'Not claimable'],
];

const SORTS: [SortKey, string][] = [
  ['date_desc', 'Newest first'],
  ['date_asc', 'Oldest first'],
  ['amount_desc', 'Largest first'],
  ['amount_asc', 'Smallest first'],
  ['added_desc', 'Recently added'],
];

const TYPES: [TypeFilter, string][] = [
  ['all', 'Receipts and EOBs'],
  ['receipt', 'Receipts'],
  ['eob', 'EOB lines'],
];

export function LedgerFilters({
  filter,
  setFilter,
  state,
  years,
}: {
  filter: LedgerFilter;
  setFilter: (patch: Partial<LedgerFilter>) => void;
  state: AppState;
  years: string[];
}) {
  const [open, setOpen] = useState(false);
  const yearValue = filter.year === null || filter.year === undefined ? '' : String(filter.year);
  const chips: { label: string; clear: Partial<LedgerFilter> }[] = [];
  if (yearValue)
    chips.push({ label: yearValue === 'undated' ? 'No date' : yearValue, clear: { year: null } });
  if (filter.type && filter.type !== 'all')
    chips.push({ label: TYPES.find(([k]) => k === filter.type)![1], clear: { type: 'all' } });
  if (filter.person)
    chips.push({
      label: state.people.find((p) => p.id === filter.person)?.name ?? 'Person',
      clear: { person: null },
    });
  if (filter.category)
    chips.push({
      label: state.categories.find((c) => c.id === filter.category)?.name ?? 'Category',
      clear: { category: null },
    });
  if (filter.provider)
    chips.push({
      label: state.providers.find((p) => p.id === filter.provider)?.name ?? 'Provider',
      clear: { provider: null },
    });

  return (
    <div className="flex flex-col gap-3 px-5 pt-2">
      <SlideToggle
        label="Status"
        value={filter.status ?? 'all'}
        onChange={(status) => setFilter({ status })}
        options={STATUS_TABS}
      />

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Icon
            name="search"
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"
          />
          <TextInput
            type="search"
            aria-label="Search"
            placeholder="Search"
            className="pl-9"
            value={filter.q ?? ''}
            onChange={(e) => setFilter({ q: e.target.value })}
          />
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cx(
            'inline-flex flex-none items-center gap-2 rounded-xl border px-3 py-2 text-[15px]',
            chips.length ? 'border-accent text-accent' : 'border-line bg-surface text-ink',
          )}
        >
          <Icon name="filter" size={16} />
          Filters
          {chips.length > 0 && (
            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[11px] font-semibold text-accent-ink tnum">
              {chips.length}
            </span>
          )}
        </button>
        <div className="hidden w-44 flex-none sm:block">
          <Select<SortKey>
            label="Sort"
            value={filter.sort ?? 'date_desc'}
            onChange={(sort) => setFilter({ sort })}
            options={SORTS}
          />
        </div>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span
              key={c.label}
              className="inline-flex items-center gap-1 rounded-full bg-accent-tint py-0.5 pr-1 pl-3 text-sm text-ink"
            >
              {c.label}
              <button
                type="button"
                aria-label={`Remove ${c.label}`}
                onClick={() => setFilter(c.clear)}
                className="grid h-6 w-6 place-items-center rounded-full text-soft"
              >
                <Icon name="x" size={13} />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="px-2 text-sm text-soft"
            onClick={() =>
              setFilter({ year: null, type: 'all', person: null, category: null, provider: null })
            }
          >
            Clear all
          </button>
        </div>
      )}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Filters"
        footer={
          <>
            <GhostButton
              onClick={() =>
                setFilter({ year: null, type: 'all', person: null, category: null, provider: null })
              }
            >
              Reset
            </GhostButton>
            <PrimaryButton onClick={() => setOpen(false)}>Done</PrimaryButton>
          </>
        }
      >
        <div className="flex flex-col gap-4 py-2">
          <Row label="Year">
            <Select
              label="Year"
              value={yearValue}
              onChange={(y) =>
                setFilter({ year: y === '' ? null : y === 'undated' ? 'undated' : Number(y) })
              }
              options={[
                ['', 'All years'],
                ...years.map((y) => [y, y === 'undated' ? 'No date' : y] as [string, string]),
              ]}
            />
          </Row>
          <Row label="Type">
            <Select<TypeFilter>
              label="Type"
              value={filter.type ?? 'all'}
              onChange={(type) => setFilter({ type })}
              options={TYPES}
            />
          </Row>
          <Row label="Person">
            <Select
              label="Person"
              value={filter.person ?? ''}
              onChange={(person) => setFilter({ person: person || null })}
              options={[
                ['', 'Everyone'],
                ...state.people.map((p) => [p.id, p.name] as [string, string]),
              ]}
            />
          </Row>
          <Row label="Category">
            <Select
              label="Category"
              value={filter.category ?? ''}
              onChange={(category) => setFilter({ category: category || null })}
              options={[
                ['', 'Any category'],
                ...state.categories.map((c) => [c.id, c.name] as [string, string]),
              ]}
            />
          </Row>
          <Row label="Provider">
            <Select
              label="Provider"
              value={filter.provider ?? ''}
              onChange={(provider) => setFilter({ provider: provider || null })}
              options={[
                ['', 'Any provider'],
                ...state.providers.map((p) => [p.id, p.name] as [string, string]),
              ]}
            />
          </Row>
          <Row label="Sort">
            <Select<SortKey>
              label="Sort"
              value={filter.sort ?? 'date_desc'}
              onChange={(sort) => setFilter({ sort })}
              options={SORTS}
            />
          </Row>
        </div>
      </Sheet>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-soft">{label}</span>
      {children}
    </div>
  );
}
