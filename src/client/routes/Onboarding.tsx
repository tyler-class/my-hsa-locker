import { useState } from 'react';
import { useNavigate } from 'react-router';
import { RELATIONSHIPS } from '@shared/lookups';
import { Dot } from '../components/bits';
import { Icon } from '../components/Icon';
import { UploadSheet } from '../components/UploadSheet';
import { ErrorText, GhostButton, PrimaryButton, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { useAppState } from '../lib/queries';
import { useSave } from '../lib/useSave';
import { Select } from '../components/Select';

/** First run: people → HSA cards (optional) → inbox (skippable) → first upload. */
export function Onboarding() {
  const nav = useNavigate();
  const { data: state } = useAppState();
  const { run, busy, error } = useSave();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [rel, setRel] = useState('Self');
  const [card, setCard] = useState('');
  const [family, setFamily] = useState('');
  const [upload, setUpload] = useState(false);
  if (!state) return null;
  const people = state.people;
  const finish = () => run(() => api.patch('/settings', { onboarded: true }));

  return (
    <div className="flex flex-col gap-8 px-5 pt-10 pb-10">
      <div className="flex flex-col gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-accent-tint text-accent">
          <Icon name="receipt" size={24} />
        </span>
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.025em]">
          Welcome to HSA Locker
        </h1>
        <p className="max-w-[44ch] text-[15px] text-soft">
          Keep every medical receipt in one place and see what your HSA can still pay you back.
        </p>
        <ol className="flex gap-2 text-xs text-soft" aria-label="Steps">
          {['People', 'HSA cards', 'Inbox', 'First receipt'].map((s, i) => (
            <li key={s} className={i === step ? 'font-semibold text-accent' : ''}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>
      </div>

      {step === 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Whose receipts are these?</h2>
          {people.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-2.5 border-b border-line py-2.5 text-base"
            >
              <Dot color={p.color} />
              {p.name}
              <span className="text-sm text-faint">{p.relationship}</span>
            </div>
          ))}
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return;
              await run(() => api.post('/people', { name: name.trim(), relationship: rel }));
              setName('');
              setRel('Child');
            }}
          >
            <TextInput
              className="min-w-0 flex-1"
              aria-label="Name"
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="w-36 flex-none">
              <Select
                label="Relationship"
                value={rel}
                onChange={(v) => setRel(v)}
                options={[...RELATIONSHIPS.map((r) => [r, r] as [string, string])]}
              />
            </div>
            <GhostButton type="submit" icon="plus" disabled={!name.trim() || busy}>
              Add
            </GhostButton>
          </form>
          <label className="flex flex-col gap-1.5 pt-2">
            <span className="text-xs text-soft">
              Family last names (helps match “Lastname, Firstname” on statements)
            </span>
            <TextInput
              placeholder="e.g. Example"
              value={family}
              onChange={(e) => setFamily(e.target.value)}
            />
          </label>
          <ErrorText>{error}</ErrorText>
          <PrimaryButton
            disabled={!people.length || busy}
            onClick={async () => {
              const names = family
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              if (names.length) await run(() => api.patch('/settings', { family_names: names }));
              setStep(1);
            }}
          >
            Next
          </PrimaryButton>
          <div className="flex flex-col gap-1 rounded-xl bg-chip p-4">
            <p className="text-sm font-medium">Just looking around?</p>
            <p className="text-sm text-soft">
              Load a made-up family with two years of receipts. Delete it any time.
            </p>
            <GhostButton
              className="-ml-3 self-start text-accent"
              disabled={busy || people.length > 0}
              onClick={() => run(() => api.post('/sample-data'))}
            >
              Load sample data
            </GhostButton>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Your HSA debit cards (optional)</h2>
          <p className="text-sm text-soft">
            Receipts paid with these cards were already paid from your HSA, so they aren’t counted
            as reimbursable. You can undo this per receipt.
          </p>
          <div className="flex w-full gap-2 sm:w-1/2">
            <TextInput
              inputMode="numeric"
              maxLength={4}
              placeholder="Last 4 digits"
              value={card}
              onChange={(e) => setCard(e.target.value.replace(/\D/g, ''))}
            />
            <GhostButton
              icon="plus"
              disabled={card.length !== 4 || busy}
              onClick={async () => {
                await run(() =>
                  api.patch('/settings', { hsa_cards: [...state.settings.hsa_cards, card] }),
                );
                setCard('');
              }}
            >
              Add
            </GhostButton>
          </div>
          {state.settings.hsa_cards.map((c) => (
            <p key={c} className="text-sm">
              •••• {c}
            </p>
          ))}
          <PrimaryButton onClick={() => setStep(2)}>Next</PrimaryButton>
        </section>
      )}

      {step === 2 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Forward receipts by email (optional)</h2>
          <p className="text-sm text-soft">
            With a domain on Cloudflare you can give HSA Locker its own address and forward receipts
            to it. No domain? Upload works for everything.
          </p>
          <div className="flex gap-2">
            <PrimaryButton
              tone="secondary"
              onClick={async () => {
                await finish();
                nav('/settings/inbox');
              }}
            >
              Set up email now
            </PrimaryButton>
            <PrimaryButton onClick={() => setStep(3)}>Skip for now</PrimaryButton>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Add your first receipt</h2>
          <p className="text-sm text-soft">A PDF or a photo. HSA Locker reads it and logs it.</p>
          <PrimaryButton icon="upload" onClick={() => setUpload(true)}>
            Upload a receipt
          </PrimaryButton>
          <GhostButton className="-ml-3 self-start" onClick={finish}>
            Done
          </GhostButton>
          <UploadSheet open={upload} onClose={() => (setUpload(false), finish())} />
        </section>
      )}
    </div>
  );
}
