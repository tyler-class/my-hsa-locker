// Small display pieces shared by Home, Ledger and Review.
import { entryStatus, type EntryStatus } from '@shared/logic';
import { EXCLUDED_LABEL, reviewLabel } from '@shared/lookups';
import type { AppState, Entry } from '@shared/types';
import type { ReactNode } from 'react';
import { cx } from './ui';

const STATUS: Record<EntryStatus, [string, string]> = {
  outstanding: ['Reimbursable', 'bg-accent-tint text-accent'],
  reimbursed: ['Reimbursed', 'bg-chip text-ok'],
  excluded: ['Not claimable', 'bg-chip text-faint'],
  needs_review: ['Needs review', 'bg-warn-tint text-warn'],
  eob: ['EOB', 'bg-chip text-soft'],
};

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium whitespace-nowrap',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusChip({ entry }: { entry: Parameters<typeof entryStatus>[0] }) {
  const s = entryStatus(entry);
  const [label, cls] = STATUS[s];
  return <Chip className={cls}>{label}</Chip>;
}

export function ReasonChips({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {reasons.map((r) => (
        // A long reason shortens with "…" instead of running under the status chip.
        <Chip key={r} className="max-w-full bg-warn-tint text-warn">
          <span className="min-w-0 truncate">{reviewLabel(r)}</span>
        </Chip>
      ))}
    </div>
  );
}

export function excludedText(e: Pick<Entry, 'excluded_reason' | 'excluded_auto'>) {
  if (!e.excluded_reason) return null;
  return `${EXCLUDED_LABEL[e.excluded_reason]}${e.excluded_auto ? ' (card on file)' : ''}`;
}

/** Names for ids, with the printed name as a fallback. */
export function namesFor(state: AppState | undefined) {
  const person = new Map(state?.people.map((p) => [p.id, p.name]) ?? []);
  const provider = new Map(state?.providers.map((p) => [p.id, p.name]) ?? []);
  const category = new Map(state?.categories.map((c) => [c.id, c.name]) ?? []);
  return {
    person,
    provider,
    category,
    personOf: (e: Pick<Entry, 'person_id' | 'patient_name_raw'>) =>
      (e.person_id && person.get(e.person_id)) || e.patient_name_raw || 'Unknown patient',
    providerOf: (e: Pick<Entry, 'provider_id' | 'provider_name_raw'>) =>
      (e.provider_id && provider.get(e.provider_id)) || e.provider_name_raw || 'Unknown provider',
    categoryOf: (e: Pick<Entry, 'category_id'>) =>
      (e.category_id && category.get(e.category_id)) || null,
  };
}

export const PERSON_DOT: Record<string, string> = {
  blue: 'var(--person-blue)',
  violet: 'var(--person-violet)',
  coral: 'var(--person-coral)',
  amber: 'var(--person-amber)',
  green: 'var(--person-green)',
  rose: 'var(--person-rose)',
  teal: 'var(--person-teal)',
  slate: 'var(--person-slate)',
  mist: 'var(--person-mist)',
};

export function Dot({ color }: { color?: string }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 flex-none rounded-full"
      style={{ background: PERSON_DOT[color ?? 'mist'] ?? PERSON_DOT.mist }}
    />
  );
}
