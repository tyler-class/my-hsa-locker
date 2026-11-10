// Settings → Providers and Settings → Categories: lists that fill themselves, with how many
// receipts use each item, and the few fixes a person might need (rename, merge).
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { CategoryUsage, ProviderSuggestion, ProviderUsage } from '@shared/types';
import { Icon } from '../components/Icon';
import { Select } from '../components/Select';
import {
  DangerButton,
  ErrorText,
  GhostButton,
  PageHeader,
  PrimaryButton,
  SectionLabel,
  Sheet,
  TextInput,
} from '../components/ui';
import { api } from '../lib/api';
import { useSave } from '../lib/useSave';

const PROVIDERS_KEY = ['providers'] as const;
const CATEGORIES_KEY = ['categories'] as const;

function receipts(n: number) {
  return n === 0 ? 'Not used' : `${n} receipt${n === 1 ? '' : 's'}`;
}

/** One item: its name, a detail line, and how many receipts use it. */
function ItemRow({
  name,
  detail,
  count,
  onClick,
}: {
  name: string;
  detail?: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 border-b border-line py-3 text-left"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base text-ink">{name}</span>
        {detail && <span className="truncate text-xs text-faint">{detail}</span>}
      </span>
      <span className={count ? 'text-sm text-soft tnum' : 'text-sm text-faint'}>
        {receipts(count)}
      </span>
      <Icon name="chevRight" className="flex-none text-faint" />
    </button>
  );
}

// ---------- providers ----------

export function ProvidersSettings() {
  const q = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () =>
      api.get<{ providers: ProviderUsage[]; suggestions: ProviderSuggestion[] }>('/providers'),
  });
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<ProviderUsage | null>(null);
  const providers = q.data?.providers ?? [];
  const f = filter.trim().toLowerCase();
  const shown = f
    ? providers.filter(
        (p) =>
          p.name.toLowerCase().includes(f) || p.aliases.some((a) => a.toLowerCase().includes(f)),
      )
    : providers;
  return (
    <div className="pb-16">
      <PageHeader
        title="Providers"
        back="/settings"
        sub="They’re added from your receipts, so you don’t need to add any."
      />
      {!!q.data?.suggestions.length && (
        <>
          <SectionLabel icon="review">Might be the same</SectionLabel>
          <div className="flex flex-col gap-3 px-6 pt-4">
            {q.data.suggestions.map((sg) => (
              <SuggestionCard key={sg.raw} sg={sg} providers={providers} />
            ))}
          </div>
          <SectionLabel icon="tag">All providers</SectionLabel>
        </>
      )}
      <div className="flex flex-col px-6 pt-3">
        {providers.length > 6 && (
          <label className="relative mb-1 block">
            <Icon
              name="search"
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"
            />
            <TextInput
              type="search"
              aria-label="Filter providers"
              placeholder="Filter providers"
              className="pl-9"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
        )}
        {shown.map((p) => (
          <ItemRow
            key={p.id}
            name={p.name}
            detail={p.aliases.length ? `Also: ${p.aliases.join(', ')}` : undefined}
            count={p.entries}
            onClick={() => setOpen(p)}
          />
        ))}
        {q.data && !shown.length && (
          <p className="py-4 text-sm text-faint">
            {f ? 'No providers match.' : 'None yet. They appear as receipts are read.'}
          </p>
        )}
      </div>
      {open && (
        <ProviderSheet provider={open} providers={providers} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

/** A printed name that may be an existing provider: same one (remember the spelling) or new. */
function SuggestionCard({ sg, providers }: { sg: ProviderSuggestion; providers: ProviderUsage[] }) {
  const { run, busy, error } = useSave();
  const [target, setTarget] = useState(sg.suggested_id ?? '');
  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-chip p-3.5 text-sm">
      <p className="text-ink">
        “{sg.raw}” on {receipts(sg.entries).toLowerCase()} may be one of these.
      </p>
      <Select
        label={`Provider for ${sg.raw}`}
        value={target}
        onChange={(v) => setTarget(v)}
        options={[
          ['', 'Choose a provider…'],
          ...providers.map((p) => [p.id, p.name] as [string, string]),
        ]}
      />
      <div className="flex flex-wrap gap-2">
        <PrimaryButton
          tone="secondary"
          className="bg-surface py-1.5"
          disabled={busy || !target}
          onClick={() =>
            run(() => api.post(`/providers/${target}/alias`, { alias: sg.raw }), [PROVIDERS_KEY])
          }
        >
          Same provider
        </PrimaryButton>
        <GhostButton
          className="py-1.5"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const p = await api.post<{ id: string }>('/providers', { name: sg.raw });
              await api.post(`/providers/${p.id}/alias`, { alias: sg.raw });
            }, [PROVIDERS_KEY])
          }
        >
          It’s a new provider
        </GhostButton>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function ProviderSheet({
  provider,
  providers,
  onClose,
}: {
  provider: ProviderUsage;
  providers: ProviderUsage[];
  onClose: () => void;
}) {
  const [name, setName] = useState(provider.name);
  const [into, setInto] = useState('');
  const { run, busy, error } = useSave();
  const target = providers.find((p) => p.id === into);
  return (
    <Sheet
      open
      onClose={onClose}
      title={provider.name}
      sub={receipts(provider.entries)}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          {target ? (
            <PrimaryButton
              disabled={busy}
              onClick={async () => {
                if (
                  await run(
                    () => api.post(`/providers/${provider.id}/merge`, { into }),
                    [PROVIDERS_KEY],
                  )
                )
                  onClose();
              }}
            >
              Merge
            </PrimaryButton>
          ) : (
            <PrimaryButton
              disabled={busy || !name.trim() || name.trim() === provider.name}
              onClick={async () => {
                if (
                  await run(
                    () => api.patch(`/providers/${provider.id}`, { name: name.trim() }),
                    [PROVIDERS_KEY],
                  )
                )
                  onClose();
              }}
            >
              Rename
            </PrimaryButton>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4 py-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-soft">Name</span>
          <TextInput value={name} disabled={!!target} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="flex flex-col gap-1.5 border-t border-line pt-4">
          <span className="text-xs text-soft">Merge into…</span>
          <Select
            label="Merge into"
            value={into}
            onChange={(v) => setInto(v)}
            options={[
              ['', 'Don’t merge'],
              ...providers
                .filter((p) => p.id !== provider.id)
                .map((p) => [p.id, p.name] as [string, string]),
            ]}
          />
          {target && (
            <p className="text-sm text-soft">
              Its receipts move to <strong className="text-ink">{target.name}</strong>, which keeps
              “{provider.name}” as another spelling.
            </p>
          )}
        </div>
        {provider.aliases.length > 0 && !target && (
          <div className="flex flex-col gap-1 border-t border-line pt-4">
            <span className="text-xs text-soft">Other spellings</span>
            {provider.aliases.map((a) => (
              <SpellingRow
                key={a}
                alias={a}
                count={provider.alias_entries[a] ?? 0}
                provider={provider}
                providers={providers}
                onDone={onClose}
              />
            ))}
          </div>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Sheet>
  );
}

/** Another spelling of a provider: remove it while unused, or move it (and its receipts) to the
 *  provider it really belongs to. */
function SpellingRow({
  alias,
  count,
  provider,
  providers,
  onDone,
}: {
  alias: string;
  count: number;
  provider: ProviderUsage;
  providers: ProviderUsage[];
  onDone: () => void;
}) {
  const { run, busy, error } = useSave();
  const [moving, setMoving] = useState(false);
  const [into, setInto] = useState('');
  const target = providers.find((p) => p.id === into);
  return (
    <div className="flex flex-col gap-2 border-b border-line py-2 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-ink">{alias}</span>
          <span className="text-xs text-faint">{receipts(count)}</span>
        </span>
        {count === 0 ? (
          <GhostButton
            className="py-1 text-danger"
            disabled={busy}
            onClick={async () => {
              if (
                await run(
                  () => api.post(`/providers/${provider.id}/aliases/remove`, { alias }),
                  [PROVIDERS_KEY],
                )
              )
                onDone();
            }}
          >
            Remove
          </GhostButton>
        ) : (
          !moving && (
            <GhostButton className="py-1 text-accent" onClick={() => setMoving(true)}>
              Move to…
            </GhostButton>
          )
        )}
      </div>
      {moving && (
        <div className="flex flex-col gap-2">
          <Select
            label={`Move ${alias} to`}
            value={into}
            onChange={(v) => setInto(v)}
            options={[
              ['', 'Choose the right provider…'],
              ...providers
                .filter((p) => p.id !== provider.id)
                .map((p) => [p.id, p.name] as [string, string]),
            ]}
          />
          {target && (
            <p className="text-sm text-soft">
              Its {receipts(count).toLowerCase()} move to{' '}
              <strong className="text-ink">{target.name}</strong>.
            </p>
          )}
          <div className="flex gap-2">
            <PrimaryButton
              className="py-1.5"
              disabled={busy || !target}
              onClick={async () => {
                if (
                  await run(
                    () => api.post(`/providers/${provider.id}/aliases/move`, { alias, into }),
                    [PROVIDERS_KEY],
                  )
                )
                  onDone();
              }}
            >
              Move
            </PrimaryButton>
            <GhostButton className="py-1.5" onClick={() => setMoving(false)}>
              Cancel
            </GhostButton>
          </div>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

// ---------- categories ----------

export function CategoriesSettings() {
  const q = useQuery({
    queryKey: CATEGORIES_KEY,
    queryFn: () => api.get<{ categories: CategoryUsage[] }>('/categories'),
  });
  const [open, setOpen] = useState<CategoryUsage | null>(null);
  const [draft, setDraft] = useState('');
  const { run, busy, error } = useSave();
  const categories = q.data?.categories ?? [];
  return (
    <div className="pb-16">
      <PageHeader
        title="Categories"
        back="/settings"
        sub="The AI picks one for each receipt, so you don’t need to add any."
      />
      <div className="flex flex-col px-6 pt-3">
        {categories.map((c) => (
          <ItemRow
            key={c.id}
            name={c.name}
            detail={c.permanent ? 'Always kept' : undefined}
            count={c.entries}
            onClick={() => setOpen(c)}
          />
        ))}
        <form
          className="flex gap-2 pt-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            if (await run(() => api.post('/categories', { name: draft.trim() }), [CATEGORIES_KEY]))
              setDraft('');
          }}
        >
          <TextInput
            aria-label="New category"
            placeholder="New category"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <GhostButton type="submit" icon="plus" disabled={busy || !draft.trim()}>
            Add
          </GhostButton>
        </form>
        <ErrorText>{error}</ErrorText>
      </div>
      {open && (
        <CategorySheet category={open} categories={categories} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

function CategorySheet({
  category,
  categories,
  onClose,
}: {
  category: CategoryUsage;
  categories: CategoryUsage[];
  onClose: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [into, setInto] = useState('');
  const { run, busy, error } = useSave();
  const target = categories.find((c) => c.id === into);
  const used = category.entries > 0;
  if (category.permanent)
    return (
      <Sheet
        open
        onClose={onClose}
        title={category.name}
        sub={receipts(category.entries)}
        footer={<PrimaryButton onClick={onClose}>Done</PrimaryButton>}
      >
        <p className="py-2 text-sm text-soft">
          Always kept: the AI uses it when nothing else fits.
        </p>
      </Sheet>
    );
  return (
    <Sheet
      open
      onClose={onClose}
      title={category.name}
      sub={receipts(category.entries)}
      footer={
        <>
          {used ? (
            <GhostButton onClick={onClose}>Cancel</GhostButton>
          ) : (
            <DangerButton
              disabled={busy}
              onClick={async () => {
                if (await run(() => api.del(`/categories/${category.id}`), [CATEGORIES_KEY]))
                  onClose();
              }}
            >
              Delete
            </DangerButton>
          )}
          {target ? (
            <PrimaryButton
              disabled={busy}
              onClick={async () => {
                if (
                  await run(
                    () => api.post(`/categories/${category.id}/merge`, { into }),
                    [CATEGORIES_KEY],
                  )
                )
                  onClose();
              }}
            >
              Merge
            </PrimaryButton>
          ) : (
            <PrimaryButton
              disabled={busy || !name.trim() || name.trim() === category.name}
              onClick={async () => {
                if (
                  await run(
                    () => api.patch(`/categories/${category.id}`, { name: name.trim() }),
                    [CATEGORIES_KEY],
                  )
                )
                  onClose();
              }}
            >
              Rename
            </PrimaryButton>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4 py-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-soft">Name</span>
          <TextInput value={name} disabled={!!target} onChange={(e) => setName(e.target.value)} />
        </label>
        {used && (
          <div className="flex flex-col gap-1.5 border-t border-line pt-4">
            <span className="text-xs text-soft">Merge into…</span>
            <Select
              label="Merge into"
              value={into}
              onChange={(v) => setInto(v)}
              options={[
                ['', 'Don’t merge'],
                ...categories
                  .filter((c) => c.id !== category.id)
                  .map((c) => [c.id, c.name] as [string, string]),
              ]}
            />
            <p className="text-sm text-soft">
              {target ? (
                <>
                  Its {receipts(category.entries).toLowerCase()} move to{' '}
                  <strong className="text-ink">{target.name}</strong>, then {category.name} is
                  deleted.
                </>
              ) : (
                'In use, so it can’t be deleted. Merge it into another instead.'
              )}
            </p>
          </div>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Sheet>
  );
}
