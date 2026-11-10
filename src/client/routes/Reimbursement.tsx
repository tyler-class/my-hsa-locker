import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import type { LedgerEntry, Reimbursement as R } from '@shared/types';
import { namesFor } from '../components/bits';
import { useToast } from '../components/Toast';
import { DangerButton, Empty, ErrorText, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, money, plural, shortDate } from '../lib/format';
import { keys, useAppState } from '../lib/queries';
import { useSave } from '../lib/useSave';

export function Reimbursement() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data: state } = useAppState();
  const q = useQuery({
    queryKey: keys.reimbursement(id),
    queryFn: () => api.get<{ reimbursement: R; entries: LedgerEntry[] }>(`/reimbursements/${id}`),
  });
  const { run, busy, error } = useSave();
  const names = namesFor(state);
  if (q.isError) return <Empty title="Not found">That reimbursement no longer exists.</Empty>;
  if (!q.data) return null;
  const { reimbursement: r, entries } = q.data;
  return (
    <div className="pb-12">
      <PageHeader
        back="/ledger"
        title={money(r.total_cents)}
        sub={`Reimbursed ${formatDate(r.date)} · ${plural(r.entry_count, 'receipt')}${r.note ? ` · ${r.note}` : ''}`}
      />
      <ul className="px-5">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center gap-3 border-b border-line py-3 text-sm">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{names.providerOf(e)}</span>
              <span className="truncate text-xs text-soft">
                {names.personOf(e)} · {shortDate(e.service_date ?? e.payment_date)}
              </span>
            </span>
            <span className="tnum">{money(e.amount_cents)}</span>
          </li>
        ))}
      </ul>
      <div className="px-5 pt-4">
        <DangerButton
          icon="undo"
          disabled={busy}
          onClick={async () => {
            if (!confirm('Undo this reimbursement? Its receipts become reimbursable again.'))
              return;
            if (await run(() => api.del(`/reimbursements/${r.id}`))) {
              toast({ text: 'Reimbursement undone' });
              nav('/ledger');
            }
          }}
        >
          Undo reimbursement
        </DangerButton>
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}
