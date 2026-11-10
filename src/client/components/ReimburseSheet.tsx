import { useState } from 'react';
import type { LedgerEntry } from '@shared/types';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { useSave } from '../lib/useSave';
import { useToast } from './Toast';
import { ErrorText, FieldRow, GhostButton, PrimaryButton, Sheet, TextInput } from './ui';

/** Record an HSA withdrawal that covers the selected receipts. */
export function ReimburseSheet({
  entries,
  onClose,
  onDone,
}: {
  entries: LedgerEntry[] | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const { run, busy, error } = useSave();
  const toast = useToast();
  if (!entries) return null;
  const eligible = entries.filter((e) => e.type === 'receipt' && !e.reimbursement_id);
  const skipped = entries.length - eligible.length;
  const total = eligible.reduce((s, e) => s + (e.amount_cents ?? 0), 0);
  return (
    <Sheet
      open
      onClose={onClose}
      title="Record reimbursement"
      sub={`${eligible.length} receipt${eligible.length === 1 ? '' : 's'}`}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton
            disabled={busy || !eligible.length || !date}
            onClick={async () => {
              const r = await run(() =>
                api.post('/reimbursements', {
                  date,
                  note: note.trim() || null,
                  entry_ids: eligible.map((e) => e.id),
                }),
              );
              if (r) {
                toast({ text: `Recorded ${money(total)} reimbursed` });
                onDone?.();
                onClose();
              }
            }}
          >
            Record {money(total)}
          </PrimaryButton>
        </>
      }
    >
      <div className="flex flex-col pb-2">
        <div className="flex items-baseline justify-between gap-3 py-4">
          <span className="text-sm text-soft">Total to withdraw from your HSA</span>
          <span className="text-2xl font-semibold tnum">{money(total)}</span>
        </div>
        <p className="pb-2 text-xs text-faint">
          Compare this with the amount of the HSA withdrawal.
        </p>
        {skipped > 0 && (
          <p className="pb-2 text-xs text-warn">
            {skipped} selected item{skipped === 1 ? ' is' : 's are'} skipped (EOB lines or already
            reimbursed).
          </p>
        )}
        <FieldRow label="Withdrawal date" htmlFor="rdate">
          <TextInput
            id="rdate"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Note" htmlFor="rnote">
          <TextInput
            id="rnote"
            placeholder="Optional"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </FieldRow>
        <ErrorText>{error}</ErrorText>
      </div>
    </Sheet>
  );
}
