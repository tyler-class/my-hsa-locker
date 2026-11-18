import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useToast } from '../components/Toast';
import type { ExcludedReason } from '@shared/types';
import { api, errorMessage } from './api';
import { DATA_KEYS } from './queries';

/** Runs an API call, refreshes data, and tracks busy/error for a form. */
export function useSave() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run<T>(
    fn: () => Promise<T>,
    extraKeys: readonly (readonly unknown[])[] = [],
  ): Promise<T | undefined> {
    setBusy(true);
    setError('');
    try {
      const r = await fn();
      await Promise.all(
        [...DATA_KEYS, ...extraKeys].map((k) => qc.invalidateQueries({ queryKey: k })),
      );
      return r;
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

/**
 * A toast with Undo for a change that can be taken back. Undoing runs `undo`, refreshes the data,
 * and says so if it couldn't.
 */
export function useUndo() {
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(
    (text: string, undo: () => Promise<unknown>) =>
      toast({
        text,
        action: {
          label: 'Undo',
          run: () =>
            void undo()
              .then(() => Promise.all(DATA_KEYS.map((k) => qc.invalidateQueries({ queryKey: k }))))
              .catch((e: unknown) => toast({ text: errorMessage(e) })),
        },
      }),
    [qc, toast],
  );
}

/** Puts entries' not-claimable reasons back as they were before a bulk change (an Undo). */
export async function restoreExclusions(
  before: { id: string; excluded_reason: ExcludedReason | null }[],
) {
  const groups = new Map<ExcludedReason | null, string[]>();
  for (const e of before)
    groups.set(e.excluded_reason, [...(groups.get(e.excluded_reason) ?? []), e.id]);
  for (const [reason, ids] of groups)
    await api.post(
      '/entries/bulk',
      reason ? { ids, action: 'exclude', reason } : { ids, action: 'unexclude' },
    );
}
