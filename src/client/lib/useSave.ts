import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from './api';
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
