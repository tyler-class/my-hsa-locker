import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { LedgerEntry } from '@shared/types';
import { namesFor, StatusChip } from '../components/bits';
import { EntrySheet } from '../components/EntrySheet';
import { Icon } from '../components/Icon';
import { UploadSheet } from '../components/UploadSheet';
import { Empty, PageHeader, PrimaryButton, SectionLabel } from '../components/ui';
import { money, plural, shortDate } from '../lib/format';
import { useAppState, useSummary } from '../lib/queries';
import { Onboarding } from './Onboarding';

function Stat({
  label,
  value,
  sub,
  to,
}: {
  label: string;
  value: string;
  sub?: string;
  to?: string;
}) {
  const body = (
    <>
      <span className="text-xs text-soft">{label}</span>
      <span className="text-[26px] leading-tight font-semibold tracking-tight tnum">{value}</span>
      {sub && <span className="text-xs text-faint">{sub}</span>}
    </>
  );
  const cls = 'flex flex-col gap-1 rounded-2xl border border-line bg-surface px-4 py-3.5';
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Home() {
  const nav = useNavigate();
  const { data: state } = useAppState();
  const summary = useSummary();
  const [upload, setUpload] = useState(false);
  const [open, setOpen] = useState<LedgerEntry | null>(null);
  if (!state) return null;
  if (!state.settings.onboarded) return <Onboarding />;
  const s = summary.data;
  const names = namesFor(state);
  const year = new Date().getFullYear();
  const review = state.counts.review_documents;

  return (
    <div className="pb-12">
      <PageHeader
        title="HSA Locker"
        icon="home"
        action={
          <PrimaryButton icon="upload" onClick={() => setUpload(true)}>
            Upload
          </PrimaryButton>
        }
      />

      {review > 0 && (
        <Link
          to="/review"
          className="mx-5 mt-2 flex items-center gap-3 rounded-xl bg-warn-tint px-4 py-3 text-sm text-warn"
        >
          <Icon name="search" size={18} />
          <span className="flex-1 font-medium">
            {plural(review, 'document')} need{review === 1 ? 's' : ''} review
            {s && s.totals.pending_review_cents > 0
              ? ` · ${money(s.totals.pending_review_cents)} waiting`
              : ''}
          </span>
          <Icon name="chevRight" size={16} />
        </Link>
      )}

      {!state.settings.inbox_address && (
        <Link
          to="/settings/inbox"
          className="mx-5 mt-2 flex items-center gap-3 rounded-xl bg-chip px-4 py-3 text-sm text-soft"
        >
          <Icon name="inbox" size={18} className="text-accent" />
          <span className="flex-1">Forward receipts by email: set up your inbox.</span>
          <Icon name="chevRight" size={16} />
        </Link>
      )}

      <div className="grid grid-cols-1 gap-3 px-5 pt-4 sm:grid-cols-3">
        <Stat
          label="Reimbursable"
          value={money(s?.totals.outstanding_cents ?? 0)}
          sub="Ready to withdraw from your HSA"
          to="/ledger?status=outstanding"
        />
        <Stat
          label="Reimbursed (all time)"
          value={money(s?.totals.reimbursed_cents ?? 0)}
          to="/ledger?status=reimbursed"
        />
        <Stat
          label={`Documented in ${year}`}
          value={money(s?.this_year?.documented_cents ?? 0)}
          sub={s?.this_year ? plural(s.this_year.receipt_count, 'receipt') : undefined}
          to={`/ledger?year=${year}`}
        />
      </div>

      <SectionLabel icon="cal">Years</SectionLabel>
      {s && s.years.length > 0 ? (
        <div className="px-5 pt-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-soft">
                <th className="px-3 py-2 font-normal">Year</th>
                <th className="px-3 py-2 text-right font-normal">Documented</th>
                <th className="px-3 hidden py-2 text-right font-normal sm:table-cell">
                  Reimbursed
                </th>
                <th className="px-3 py-2 text-right font-normal">Reimbursable</th>
                <th className="px-3 hidden py-2 text-right font-normal md:table-cell">Receipts</th>
                <th className="px-3 hidden py-2 text-right font-normal md:table-cell">EOBs</th>
              </tr>
            </thead>
            <tbody>
              {s.years.map((y) => (
                <tr
                  key={y.year ?? 'undated'}
                  className="group cursor-pointer border-t border-line"
                  onClick={() => nav(`/ledger?year=${y.year ?? 'undated'}`)}
                >
                  <td className="px-3 transition-colors group-hover:bg-chip first:rounded-l-xl last:rounded-r-xl py-2.5 font-medium">
                    <Link to={`/ledger?year=${y.year ?? 'undated'}`}>{y.year ?? 'No date'}</Link>
                  </td>
                  <td className="px-3 transition-colors group-hover:bg-chip first:rounded-l-xl last:rounded-r-xl py-2.5 text-right tnum">
                    {money(y.documented_cents)}
                  </td>
                  <td className="px-3 transition-colors group-hover:bg-chip first:rounded-l-xl last:rounded-r-xl hidden py-2.5 text-right tnum sm:table-cell">
                    {money(y.reimbursed_cents)}
                  </td>
                  <td className="px-3 transition-colors group-hover:bg-chip first:rounded-l-xl last:rounded-r-xl py-2.5 text-right tnum">
                    {money(y.outstanding_cents)}
                    {y.pending_review_cents > 0 && (
                      <span className="block text-[11px] text-warn">
                        +{money(y.pending_review_cents)} in review
                      </span>
                    )}
                  </td>
                  <td className="px-3 transition-colors group-hover:bg-chip first:rounded-l-xl last:rounded-r-xl hidden py-2.5 text-right tnum md:table-cell">
                    {y.receipt_count}
                  </td>
                  <td className="px-3 transition-colors group-hover:bg-chip first:rounded-l-xl last:rounded-r-xl hidden py-2.5 text-right tnum md:table-cell">
                    {y.eob_document_count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="Nothing logged yet"
          action={
            <PrimaryButton icon="upload" onClick={() => setUpload(true)}>
              Upload your first receipt
            </PrimaryButton>
          }
        >
          Upload a receipt or EOB, or forward one by email. HSA Locker reads it for you.
        </Empty>
      )}

      {s && s.recent.length > 0 && (
        <>
          <SectionLabel icon="clock">Recently logged</SectionLabel>
          <ul className="px-5 pt-1">
            {s.recent.map((e) => (
              <li key={e.id} className="border-b border-line">
                <button
                  onClick={() => setOpen(e)}
                  className="my-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-chip"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15px]">{names.providerOf(e)}</span>
                    <span className="truncate text-xs text-soft">
                      {e.type === 'eob' ? 'EOB · ' : ''}
                      {names.personOf(e)} ·{' '}
                      {shortDate(e.service_date ?? e.payment_date) || 'No date'}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <span className="text-[15px] tnum">
                      {e.type === 'receipt' ? money(e.amount_cents) : ''}
                    </span>
                    <StatusChip entry={e} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <UploadSheet open={upload} onClose={() => setUpload(false)} />
      <EntrySheet entry={open} onClose={() => setOpen(null)} />
    </div>
  );
}
