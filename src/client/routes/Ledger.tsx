import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  entryDate,
  filterFromParams,
  filterLedger,
  filterToParams,
  type LedgerFilter,
} from '@shared/logic';
import { EXCLUDED_REASONS } from '@shared/lookups';
import type { LedgerEntry } from '@shared/types';
import { excludedText, namesFor, ReasonChips, StatusChip } from '../components/bits';
import { EntrySheet } from '../components/EntrySheet';
import { LedgerFilters } from '../components/LedgerFilters';
import { Icon } from '../components/Icon';
import { ReimburseSheet } from '../components/ReimburseSheet';
import { useToast } from '../components/Toast';
import { UploadSheet } from '../components/UploadSheet';
import { ActionList, cx, Empty, PageHeader, PrimaryButton, Sheet } from '../components/ui';
import { api } from '../lib/api';
import { money, plural, shortDate } from '../lib/format';
import { useAppState, useLedger, useReimbursements } from '../lib/queries';
import { useSaveFile } from '../lib/files';
import { useSave } from '../lib/useSave';

export function Ledger() {
  const [params, setParams] = useSearchParams();
  const filter = filterFromParams(params);
  const { data: state } = useAppState();
  const ledger = useLedger();
  const reimbursements = useReimbursements();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<LedgerEntry | null>(null);
  const [reimburse, setReimburse] = useState<LedgerEntry[] | null>(null);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [upload, setUpload] = useState(false);
  const { run } = useSave();
  const toast = useToast();
  const saveFile = useSaveFile();
  const exportCsv = () =>
    void saveFile(`/api/export/ledger.csv?${filterToParams(filter).toString()}`, 'ledger.csv');
  const names = useMemo(() => namesFor(state), [state]);
  const query = params.toString();

  const rows = useMemo(
    () =>
      state && ledger.data
        ? filterLedger(
            ledger.data,
            filterFromParams(new URLSearchParams(query)),
            state.settings.year_basis,
            names,
          )
        : [],
    [ledger.data, state, query, names],
  );
  const years = useMemo(() => {
    if (!state || !ledger.data) return [];
    const set = new Set<string>();
    for (const e of ledger.data)
      set.add(entryDate(e, state.settings.year_basis)?.slice(0, 4) ?? 'undated');
    return [...set].sort().reverse();
  }, [ledger.data, state]);
  if (!state) return null;

  const setFilter = (patch: Partial<LedgerFilter>) => {
    setParams(filterToParams({ ...filter, ...patch }), { replace: true });
    setSelected(new Set());
  };
  const chosen = rows.filter((e) => selected.has(e.id));
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const receiptsTotal = rows
    .filter((e) => e.type === 'receipt')
    .reduce((s, e) => s + (e.amount_cents ?? 0), 0);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="pb-28">
      <PageHeader
        title="Ledger"
        icon="receipt"
        action={
          <PrimaryButton icon="upload" onClick={() => setUpload(true)}>
            Upload
          </PrimaryButton>
        }
        sub={`${plural(rows.length, 'entry', 'entries')} · receipts ${money(receiptsTotal)}`}
      />

      <LedgerFilters filter={filter} setFilter={setFilter} state={state} years={years} />

      {ledger.isPending ? null : rows.length === 0 ? (
        <Empty title="Nothing matches">Try fewer filters, or upload a receipt.</Empty>
      ) : (
        <ul className="px-5 pt-2" aria-label="Entries">
          <li className="border-b border-line">
            <button
              type="button"
              onClick={() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id)))}
              className="flex items-center gap-3.5 px-3 py-2.5 text-sm text-soft"
            >
              <SelectDot on={allOn} />
              {allOn ? 'Deselect all' : 'Select all'}
            </button>
          </li>
          {rows.map((e) => (
            <li key={e.id} className="border-b border-line">
              <div
                className={cx(
                  'flex items-center rounded-xl px-3 transition-colors',
                  selected.has(e.id) ? 'my-1 bg-accent-tint' : 'hover:bg-chip',
                )}
              >
                <button
                  type="button"
                  aria-label={selected.has(e.id) ? 'Deselect' : 'Select'}
                  aria-pressed={selected.has(e.id)}
                  onClick={() => toggle(e.id)}
                  className="flex h-full flex-none items-center py-3 pr-3.5"
                >
                  <SelectDot on={selected.has(e.id)} />
                </button>
                <button
                  onClick={() => setOpen(e)}
                  className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[15px]">
                      {names.providerOf(e)}
                      {e.type === 'eob' && e.description ? (
                        <span className="text-soft"> · {e.description}</span>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-soft">
                      {names.personOf(e)} ·{' '}
                      {shortDate(entryDate(e, state.settings.year_basis)) || 'No date'}
                      {names.categoryOf(e) ? ` · ${names.categoryOf(e)}` : ''}
                      {e.excluded_reason ? ` · ${excludedText(e)}` : ''}
                    </span>
                    {e.review_reasons.length > 0 && <ReasonChips reasons={e.review_reasons} />}
                  </span>
                  <span className="flex flex-none flex-col items-end gap-1">
                    <span className="text-[15px] tnum">
                      {e.type === 'receipt' ? money(e.amount_cents) : ''}
                    </span>
                    <StatusChip entry={e} />
                  </span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(reimbursements.data?.length ?? 0) > 0 && (
        <div className="px-5 pt-8">
          <h2 className="pb-1 text-sm font-semibold">Reimbursements</h2>
          {reimbursements.data!.slice(0, 12).map((r) => (
            <Link
              key={r.id}
              to={`/reimbursements/${r.id}`}
              className="flex items-center gap-3 border-b border-line py-2.5 text-sm"
            >
              <span className="flex-1">
                {shortDate(r.date)}
                {r.note ? <span className="text-soft"> · {r.note}</span> : null}
              </span>
              <span className="text-soft">{plural(r.entry_count, 'receipt')}</span>
              <span className="w-24 text-right tnum">{money(r.total_cents)}</span>
              <Icon name="chevRight" size={14} className="text-faint" />
            </Link>
          ))}
        </div>
      )}

      {/* Sticky action bar for the selection; sits above the phone tab bar. */}
      <div
        className={cx(
          'fixed inset-x-0 z-20 px-4 transition-transform md:left-60',
          'bottom-[calc(var(--tabbar-clear)+12px)] md:bottom-4',
          chosen.length ? 'translate-y-0' : 'pointer-events-none translate-y-[200%]',
        )}
      >
        <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-3 shadow-lg">
          <span className="flex-1 text-sm">
            {chosen.length} selected ·{' '}
            <span className="tnum">
              {money(
                chosen
                  .filter((e) => e.type === 'receipt')
                  .reduce((s, e) => s + (e.amount_cents ?? 0), 0),
              )}
            </span>
          </span>
          <PrimaryButton className="py-2" onClick={() => setReimburse(chosen)}>
            Mark reimbursed
          </PrimaryButton>
          <PrimaryButton tone="secondary" className="py-2" onClick={() => setExcludeOpen(true)}>
            Not claimable…
          </PrimaryButton>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full bg-chip px-4 py-2 text-[15px] font-medium text-ink"
            onClick={exportCsv}
          >
            Export CSV
          </button>
        </div>
      </div>
      {!chosen.length && rows.length > 0 && (
        <div className="px-5 pt-4">
          <button type="button" className="text-sm text-accent" onClick={exportCsv}>
            Export these as CSV
          </button>
        </div>
      )}

      <Sheet open={excludeOpen} onClose={() => setExcludeOpen(false)} title="Mark not claimable">
        <ActionList
          actions={[
            ...EXCLUDED_REASONS.map(([k, label]) => ({
              icon: 'x' as const,
              label,
              onClick: async () => {
                await run(() =>
                  api.post('/entries/bulk', { ids: [...selected], action: 'exclude', reason: k }),
                );
                toast({
                  text: `Marked ${plural(selected.size, 'entry', 'entries')} not claimable`,
                });
                setExcludeOpen(false);
                setSelected(new Set());
              },
            })),
            {
              icon: 'undo' as const,
              label: 'Mark claimable again',
              onClick: async () => {
                await run(() =>
                  api.post('/entries/bulk', { ids: [...selected], action: 'unexclude' }),
                );
                setExcludeOpen(false);
                setSelected(new Set());
              },
            },
          ]}
        />
      </Sheet>
      <ReimburseSheet
        entries={reimburse}
        onClose={() => setReimburse(null)}
        onDone={() => setSelected(new Set())}
      />
      <EntrySheet entry={open} onClose={() => setOpen(null)} />
      <UploadSheet open={upload} onClose={() => setUpload(false)} />
    </div>
  );
}

/** Duffel's selection mark: a round check, filled when selected. */
function SelectDot({ on }: { on: boolean }) {
  return (
    <span
      className={cx(
        'grid h-5 w-5 flex-none place-items-center rounded-full border-[1.5px] transition-colors',
        on ? 'border-accent bg-accent text-accent-ink' : 'border-faint',
      )}
    >
      {on && <Icon name="check" size={14} strokeWidth={2.4} />}
    </span>
  );
}
