import { useState } from 'react';
import { api } from '../lib/api';
import { useAppState } from '../lib/queries';
import { useSave } from '../lib/useSave';
import { useToast } from './Toast';
import { bodyFromForm, EntryForm, formFromEntry } from './EntryForm';
import { GhostButton, PrimaryButton } from './ui';

/** A receipt or EOB line typed in by hand, with no document (POST /entries). */
export function NewEntryForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { data: state } = useAppState();
  const toast = useToast();
  const [form, setForm] = useState(() => formFromEntry({ type: 'receipt' }));
  const [formError, setFormError] = useState('');
  const { run, busy, error } = useSave();
  if (!state) return null;
  return (
    <div className="flex flex-col gap-4 py-2">
      <EntryForm value={form} onChange={setForm} state={state} error={formError || error} />
      <div className="flex justify-end gap-2">
        <GhostButton onClick={onCancel}>Back</GhostButton>
        <PrimaryButton
          disabled={busy}
          onClick={async () => {
            const { body, error } = bodyFromForm(form);
            if (error) return setFormError(error);
            setFormError('');
            if (await run(() => api.post('/entries', body))) {
              toast({ text: 'Entry added to the Ledger' });
              onDone();
            }
          }}
        >
          Add entry
        </PrimaryButton>
      </div>
    </div>
  );
}
