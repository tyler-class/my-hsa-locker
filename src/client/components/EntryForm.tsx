import { useState } from 'react';
import { EXCLUDED_REASONS } from '@shared/lookups';
import { matchProvider } from '@shared/logic';
import type { AppState, Entry, ExcludedReason } from '@shared/types';
import { centsInput, parseTypedMoney } from '../lib/format';
import { ErrorText, TextInput } from './ui';
import { Select } from './Select';

export type EntryDraftForm = {
  type: 'receipt' | 'eob';
  service_date: string;
  payment_date: string;
  person_id: string;
  provider_id: string;
  category_id: string;
  description: string;
  amount: string;
  card_last4: string;
  billed: string;
  allowed: string;
  plan_paid: string;
  patient_resp: string;
  notes: string;
  excluded_reason: string;
};

export function formFromEntry(e: Partial<Entry>): EntryDraftForm {
  return {
    type: e.type ?? 'receipt',
    service_date: e.service_date ?? '',
    payment_date: e.payment_date ?? '',
    person_id: e.person_id ?? '',
    provider_id: e.provider_id ?? '',
    category_id: e.category_id ?? '',
    description: e.description ?? '',
    amount: centsInput(e.amount_cents),
    card_last4: e.card_last4 ?? '',
    billed: centsInput(e.billed_cents),
    allowed: centsInput(e.allowed_cents),
    plan_paid: centsInput(e.plan_paid_cents),
    patient_resp: centsInput(e.patient_resp_cents),
    notes: e.notes ?? '',
    excluded_reason: e.excluded_reason ?? '',
  };
}

/** The API body for a form, or an error message. */
export function bodyFromForm(f: EntryDraftForm): {
  body?: Record<string, unknown>;
  error?: string;
} {
  const moneyField = (s: string, label: string) => {
    if (!s.trim()) return { v: null };
    const c = parseTypedMoney(s);
    return c === null ? { err: `${label} isn’t an amount.` } : { v: c };
  };
  const amount = moneyField(f.amount, 'Amount');
  const eob = [
    moneyField(f.billed, 'Billed'),
    moneyField(f.allowed, 'Allowed'),
    moneyField(f.plan_paid, 'Plan paid'),
    moneyField(f.patient_resp, 'Patient responsibility'),
  ];
  const err = [amount, ...eob].find((x) => 'err' in x && x.err);
  if (err && 'err' in err) return { error: err.err };
  if (f.card_last4 && !/^\d{4}$/.test(f.card_last4))
    return { error: 'Card: the last 4 digits only.' };
  return {
    body: {
      type: f.type,
      service_date: f.service_date || null,
      payment_date: f.type === 'eob' ? null : f.payment_date || null,
      person_id: f.person_id || null,
      provider_id: f.provider_id || null,
      category_id: f.category_id || null,
      description: f.description.trim() || null,
      amount_cents: f.type === 'eob' ? null : (amount as { v: number | null }).v,
      card_last4: f.type === 'eob' ? null : f.card_last4 || null,
      billed_cents: f.type === 'eob' ? (eob[0] as { v: number | null }).v : null,
      allowed_cents: f.type === 'eob' ? (eob[1] as { v: number | null }).v : null,
      plan_paid_cents: f.type === 'eob' ? (eob[2] as { v: number | null }).v : null,
      patient_resp_cents: f.type === 'eob' ? (eob[3] as { v: number | null }).v : null,
      notes: f.notes.trim() || null,
      excluded_reason: f.type === 'eob' ? null : (f.excluded_reason as ExcludedReason) || null,
    },
  };
}

function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <label
      className={
        wide ? 'col-span-2 flex min-w-0 flex-col gap-1.5' : 'flex min-w-0 flex-col gap-1.5'
      }
    >
      <span className="text-xs text-soft">{label}</span>
      {children}
    </label>
  );
}

export function EntryForm({
  value,
  onChange,
  state,
  printed,
  error,
}: {
  value: EntryDraftForm;
  onChange: (v: EntryDraftForm) => void;
  state: AppState;
  /** The names as printed on the document, shown as hints. */
  printed?: { patient?: string | null; provider?: string | null };
  error?: string;
}) {
  const set = <K extends keyof EntryDraftForm>(k: K, v: EntryDraftForm[K]) =>
    onChange({ ...value, [k]: v });
  const [showMore, setShowMore] = useState(false);
  const suggestion =
    !value.provider_id && printed?.provider
      ? matchProvider(printed.provider, state.providers)
      : null;
  const suggested =
    suggestion && suggestion.kind !== 'none'
      ? state.providers.find((p) => p.id === suggestion.id)
      : null;
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
      <Field label="Type">
        <Select<'receipt' | 'eob'>
          label="Type"
          value={value.type}
          onChange={(t) => set('type', t)}
          options={[
            ['receipt', 'Receipt'],
            ['eob', 'EOB line'],
          ]}
        />
      </Field>
      <div />
      <Field label="Service date">
        <TextInput
          type="date"
          value={value.service_date}
          onChange={(e) => set('service_date', e.target.value)}
        />
      </Field>
      {value.type === 'receipt' ? (
        <Field label="Payment date">
          <TextInput
            type="date"
            value={value.payment_date}
            onChange={(e) => set('payment_date', e.target.value)}
          />
        </Field>
      ) : (
        <div />
      )}
      <Field label={printed?.patient ? `Patient (printed “${printed.patient}”)` : 'Patient'} wide>
        <Select
          label="Patient"
          value={value.person_id}
          onChange={(v) => set('person_id', v)}
          options={[
            ['', 'Not set'],
            ...state.people.map((p) => [p.id, p.name] as [string, string]),
          ]}
        />
      </Field>
      <Field
        label={printed?.provider ? `Provider (printed “${printed.provider}”)` : 'Provider'}
        wide
      >
        <Select
          label="Provider"
          value={value.provider_id}
          onChange={(v) => set('provider_id', v)}
          options={[
            ['', 'Not set'],
            ...state.providers.map((p) => [p.id, p.name] as [string, string]),
          ]}
        />
        {suggested && (
          <button
            type="button"
            className="self-start text-sm text-accent"
            onClick={() => set('provider_id', suggested.id)}
          >
            Use “{suggested.name}”?
          </button>
        )}
      </Field>
      {value.type === 'receipt' ? (
        <>
          <Field label="Amount paid">
            <TextInput
              inputMode="decimal"
              placeholder="0.00"
              value={value.amount}
              onChange={(e) => set('amount', e.target.value)}
            />
          </Field>
          <Field label="Card (last 4)">
            <TextInput
              inputMode="numeric"
              maxLength={4}
              placeholder="1234"
              value={value.card_last4}
              onChange={(e) => set('card_last4', e.target.value.replace(/\D/g, ''))}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="Billed">
            <TextInput
              inputMode="decimal"
              value={value.billed}
              onChange={(e) => set('billed', e.target.value)}
            />
          </Field>
          <Field label="Plan paid">
            <TextInput
              inputMode="decimal"
              value={value.plan_paid}
              onChange={(e) => set('plan_paid', e.target.value)}
            />
          </Field>
          {showMore ? (
            <>
              <Field label="Allowed">
                <TextInput
                  inputMode="decimal"
                  value={value.allowed}
                  onChange={(e) => set('allowed', e.target.value)}
                />
              </Field>
              <Field label="Patient responsibility">
                <TextInput
                  inputMode="decimal"
                  value={value.patient_resp}
                  onChange={(e) => set('patient_resp', e.target.value)}
                />
              </Field>
            </>
          ) : (
            <button
              type="button"
              className="col-span-2 self-start text-left text-sm text-accent"
              onClick={() => setShowMore(true)}
            >
              More EOB amounts
            </button>
          )}
          <p className="col-span-2 text-xs text-faint">
            EOB lines are for reference and never count toward reimbursable totals.
          </p>
        </>
      )}
      <Field label="Category">
        <Select
          label="Category"
          value={value.category_id}
          onChange={(v) => set('category_id', v)}
          options={[
            ['', 'None'],
            ...state.categories.map((p) => [p.id, p.name] as [string, string]),
          ]}
        />
      </Field>
      {value.type === 'receipt' ? (
        <Field label="Not claimable">
          <Select
            label="Not claimable"
            value={value.excluded_reason}
            onChange={(v) => set('excluded_reason', v)}
            options={[['', 'No'], ...EXCLUDED_REASONS]}
          />
        </Field>
      ) : (
        <div />
      )}
      <Field label="Description" wide>
        <TextInput value={value.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
      <Field label="Notes" wide>
        <TextInput value={value.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>
      <div className="col-span-2">
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}
