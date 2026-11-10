import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { matchProvider, normalizePatientName } from '@shared/logic';
import type { AppState, Entry } from '@shared/types';
import { ReasonChips } from '../components/bits';
import { DocPreview } from '../components/DocPreview';
import { bodyFromForm, EntryForm, formFromEntry } from '../components/EntryForm';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import {
  Empty,
  ErrorText,
  GhostButton,
  PageHeader,
  PrimaryButton,
  TextInput,
} from '../components/ui';
import { api } from '../lib/api';
import { formatDate, money, plural } from '../lib/format';
import { useAppState, useDocument, useReview } from '../lib/queries';
import { useSave } from '../lib/useSave';
import { useViewer } from '../lib/viewer';
import { Select } from '../components/Select';

export function Review() {
  const { id } = useParams();
  const nav = useNavigate();
  const review = useReview();
  const { data: state } = useAppState();
  const ids = review.data?.document_ids ?? [];
  const current = id && ids.includes(id) ? id : (ids[0] ?? id ?? null);
  const index = current ? ids.indexOf(current) : -1;
  if (!state) return null;
  if (!review.isPending && !current)
    return (
      <div>
        <PageHeader title="Review" icon="search" />
        <Empty title="All caught up">
          Nothing is waiting for review. Documents that need a look show up here.
        </Empty>
      </div>
    );
  const go = (i: number) => ids[i] && nav(`/review/${ids[i]}`, { replace: true });
  return (
    <div className="pb-12">
      <PageHeader
        title="Review"
        icon="search"
        sub={ids.length ? `${index + 1} of ${plural(ids.length, 'document')}` : undefined}
        action={
          <div className="flex gap-1">
            <GhostButton
              icon="back"
              disabled={index <= 0}
              onClick={() => go(index - 1)}
              aria-label="Previous"
            />
            <GhostButton
              icon="chevRight"
              disabled={index < 0 || index >= ids.length - 1}
              onClick={() => go(index + 1)}
              aria-label="Next"
            />
          </div>
        }
      />
      {current && (
        <ReviewDoc
          key={current}
          id={current}
          state={state}
          onDone={() => go(index + 1 < ids.length ? index + 1 : index - 1)}
        />
      )}
    </div>
  );
}

function ReviewDoc({ id, state, onDone }: { id: string; state: AppState; onDone: () => void }) {
  const doc = useDocument(id);
  const { run, busy, error } = useSave();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const viewer = useViewer();
  if (!doc.data) return null;
  const { document: d, entries } = doc.data;
  const reviewing = entries.filter((e) => e.review_reasons.length);
  const clean = entries.filter((e) => !e.review_reasons.length);

  return (
    <div className="grid gap-5 px-5 pt-2 md:grid-cols-2">
      <div className="flex flex-col gap-2 md:sticky md:top-4 md:self-start">
        <DocPreview doc={d} />
        {d.status !== 'discarded' && (
          <div className="flex items-center gap-4 text-sm">
            <button
              type="button"
              onClick={() => viewer.open('doc', d.id)}
              className="inline-flex items-center gap-1.5 text-accent"
            >
              <Icon name="open" size={15} />
              Open
            </button>
            {d.has_eml && (
              <button
                type="button"
                onClick={() => viewer.open('email', d.id)}
                className="inline-flex items-center gap-1.5 text-accent"
              >
                <Icon name="mail" size={15} />
                Original email
              </button>
            )}
          </div>
        )}
        <p className="text-xs text-faint">
          {d.filename} ·{' '}
          {d.source === 'email'
            ? `emailed ${d.source_meta.from ? `from ${d.source_meta.from}` : ''}`
            : d.source}
          {' · '}
          {formatDate(d.received_at.slice(0, 10))}
          {d.extraction_model ? ` · read by ${d.extraction_model}` : ''}
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {d.review_reasons.length > 0 && (
          <div className="flex flex-col gap-2 rounded-xl bg-warn-tint p-4">
            <ReasonChips reasons={d.review_reasons} />
            <p className="text-sm text-ink">
              {d.review_reasons.includes('scanned_pdf_unsupported')
                ? 'This PDF is a scan with no text to read. Type the receipt in below, or upload photos of its pages instead.'
                : d.review_reasons.includes('not_a_receipt') ||
                    d.review_reasons.includes('body_only_email')
                  ? 'This doesn’t look like a receipt or EOB. Discard it, or add what it shows by hand.'
                  : d.review_reasons.includes('extraction_failed')
                    ? 'Reading this failed several times. Try Reprocess, or type it in.'
                    : 'Check this document.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                tone="secondary"
                className="py-2"
                disabled={busy}
                onClick={() => setAdding(true)}
              >
                Add entry by hand
              </PrimaryButton>
              {entries.length > 0 && (
                <PrimaryButton
                  tone="secondary"
                  className="py-2"
                  disabled={busy}
                  onClick={() => run(() => api.post(`/documents/${id}/approve`))}
                >
                  Looks fine
                </PrimaryButton>
              )}
            </div>
          </div>
        )}

        {reviewing.map((e) => (
          <ReviewEntry key={e.id} entry={e} state={state} />
        ))}
        {adding && <NewEntry docId={id} state={state} onClose={() => setAdding(false)} />}
        {clean.length > 0 && (
          <p className="text-sm text-soft">
            {plural(clean.length, 'other line')} from this document{' '}
            {clean.length === 1 ? 'is' : 'are'} fine.
          </p>
        )}

        <div className="flex flex-wrap gap-x-1 border-t border-line pt-2">
          <GhostButton
            icon="refresh"
            className="-ml-3"
            disabled={busy}
            onClick={async () => {
              await run(() => api.post(`/documents/${id}/reprocess`));
              toast({ text: 'Reading it again' });
            }}
          >
            Reprocess
          </GhostButton>
          <GhostButton
            icon="trash"
            className="text-danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm('Discard this document and its entries? The file is deleted.')) return;
              if (await run(() => api.post(`/documents/${id}/discard`))) {
                toast({ text: 'Discarded' });
                onDone();
              }
            }}
          >
            Discard document
          </GhostButton>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}

function ReviewEntry({ entry, state }: { entry: Entry; state: AppState }) {
  const [form, setForm] = useState(() => formFromEntry(entry));
  const [formError, setFormError] = useState('');
  const { run, busy, error } = useSave();
  const toast = useToast();

  async function approve() {
    const { body, error } = bodyFromForm(form);
    if (error) return setFormError(error);
    setFormError('');
    if (
      await run(async () => {
        await api.patch(`/entries/${entry.id}`, body);
        await api.post(`/entries/${entry.id}/approve`);
        return true;
      })
    )
      toast({ text: 'Approved' });
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          {entry.type === 'eob' ? 'EOB line' : `Receipt ${money(entry.amount_cents)}`}
        </span>
        <ReasonChips reasons={entry.review_reasons} />
      </div>
      {entry.source_quote && (
        <p className="text-xs text-faint">From the document: “{entry.source_quote}”</p>
      )}
      {entry.notes && <p className="text-xs text-soft">{entry.notes}</p>}
      {!entry.person_id && entry.patient_name_raw && (
        <PersonFix raw={entry.patient_name_raw} state={state} />
      )}
      {!entry.provider_id && entry.provider_name_raw && (
        <ProviderFix raw={entry.provider_name_raw} state={state} />
      )}
      {entry.dup_of_entry_id && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-chip px-3 py-2 text-sm">
          <span className="flex-1">
            Looks like a visit that’s already logged from another document.
          </span>
          <PrimaryButton
            tone="secondary"
            className="py-1.5"
            disabled={busy}
            onClick={() => run(() => api.post(`/entries/${entry.id}/merge`))}
          >
            Merge (drop this one)
          </PrimaryButton>
        </div>
      )}
      <EntryForm
        value={form}
        onChange={setForm}
        state={state}
        printed={{ patient: entry.patient_name_raw, provider: entry.provider_name_raw }}
        error={formError || error}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <GhostButton
          icon="trash"
          className="mr-auto -ml-3 text-danger"
          disabled={busy}
          onClick={() => confirm('Delete this line?') && run(() => api.del(`/entries/${entry.id}`))}
        >
          Delete line
        </GhostButton>
        <PrimaryButton disabled={busy} icon="check" onClick={approve}>
          {entry.dup_of_entry_id ? 'Keep both & approve' : 'Approve'}
        </PrimaryButton>
      </div>
    </div>
  );
}

/** "Add as new person" / "add as alias to X" for a patient name nobody matches. */
function PersonFix({ raw, state }: { raw: string; state: AppState }) {
  const { run, busy } = useSave();
  const [target, setTarget] = useState('');
  const [name, setName] = useState(() => normalizePatientName(raw, state.settings.family_names));
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-chip px-3 py-2.5 text-sm">
      <span>
        <Icon name="user" size={14} className="mr-1 inline text-accent" />“{raw}” isn’t one of your
        people.
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          className="max-w-[220px] py-1.5"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="New person’s name"
        />
        <PrimaryButton
          tone="secondary"
          className="py-1.5"
          disabled={busy || !name.trim()}
          onClick={() =>
            run(() =>
              api.post('/people/from-name', {
                name: name.trim(),
                aliases: name.trim() === raw.trim() ? [] : [raw],
              }),
            )
          }
        >
          Add as new person
        </PrimaryButton>
      </div>
      {state.people.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-64">
            <Select
              label="Existing person"
              value={target}
              onChange={(v) => setTarget(v)}
              options={[
                ['', 'Choose a person…'],
                ...state.people.map((p) => [p.id, p.name] as [string, string]),
              ]}
            />
          </div>
          <PrimaryButton
            tone="secondary"
            className="py-1.5"
            disabled={busy || !target}
            onClick={() => run(() => api.post(`/people/${target}/alias`, { alias: raw }))}
          >
            Add as their alias
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}

/** A printed provider name that may be an existing provider (truncated or misspelled). */
function ProviderFix({ raw, state }: { raw: string; state: AppState }) {
  const { run, busy } = useSave();
  const m = matchProvider(raw, state.providers);
  const [target, setTarget] = useState(m.kind === 'suggestion' ? m.id : '');
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-chip px-3 py-2.5 text-sm">
      <span className="w-full">“{raw}” may be one of your providers.</span>
      <div className="w-full sm:w-64">
        <Select
          label="Provider"
          value={target}
          onChange={(v) => setTarget(v)}
          options={[
            ['', 'Choose a provider…'],
            ...state.providers.map((p) => [p.id, p.name] as [string, string]),
          ]}
        />
      </div>
      <PrimaryButton
        tone="secondary"
        className="py-1.5"
        disabled={busy || !target}
        onClick={() => run(() => api.post(`/providers/${target}/alias`, { alias: raw }))}
      >
        Same provider: remember this spelling
      </PrimaryButton>
      <PrimaryButton
        tone="secondary"
        className="py-1.5"
        disabled={busy}
        onClick={async () => {
          await run(async () => {
            const p = await api.post<{ id: string }>('/providers', { name: raw });
            await api.post(`/providers/${p.id}/alias`, { alias: raw });
          });
        }}
      >
        It’s a new provider
      </PrimaryButton>
    </div>
  );
}

function NewEntry({
  docId,
  state,
  onClose,
}: {
  docId: string;
  state: AppState;
  onClose: () => void;
}) {
  const [form, setForm] = useState(() => formFromEntry({ type: 'receipt' }));
  const [formError, setFormError] = useState('');
  const { run, busy, error } = useSave();
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-accent bg-surface p-4">
      <span className="text-sm font-semibold">New entry</span>
      <EntryForm value={form} onChange={setForm} state={state} error={formError || error} />
      <div className="flex justify-end gap-2">
        <GhostButton onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton
          disabled={busy}
          onClick={async () => {
            const { body, error } = bodyFromForm(form);
            if (error) return setFormError(error);
            if (await run(() => api.post(`/documents/${docId}/entries`, body))) onClose();
          }}
        >
          Add
        </PrimaryButton>
      </div>
    </div>
  );
}
