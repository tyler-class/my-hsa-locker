import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { ErrorText, PrimaryButton, TextInput } from '../components/ui';

export function Login() {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/login', { password });
      await qc.invalidateQueries();
      await qc.refetchQueries({ queryKey: ['session'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center px-6 pt-safe pb-safe">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-start gap-3">
          <img src="/favicon.svg" alt="" className="h-12 w-12 rounded-2xl" />
          <h1 className="text-[28px] font-semibold tracking-[-0.025em]">HSA Locker</h1>
          <p className="text-sm text-soft">Enter your household password.</p>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="password" className="text-xs text-soft">
            Password
          </label>
          <TextInput
            id="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <ErrorText>{error}</ErrorText>
        <PrimaryButton type="submit" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </PrimaryButton>
      </form>
    </main>
  );
}

export function SetupNeeded({ message }: { message: string }) {
  return (
    <main className="flex min-h-full items-center justify-center px-6">
      <div className="flex max-w-md flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Almost there</h1>
        <p className="text-sm leading-relaxed text-soft">{message}</p>
      </div>
    </main>
  );
}
