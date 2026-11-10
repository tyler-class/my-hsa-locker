// Settings → Notifications: this device's own choices (Selfhost Kit layout and words).
import { Fragment, useEffect, useState } from 'react';
import { BADGE_MEANS, MILESTONE_DEFAULT_CENTS, NOTIFY_KINDS } from '@shared/logic';
import {
  disablePush,
  enablePush,
  getState,
  installSteps,
  pushBlocker,
  pushInfo,
  PUSH_TEXT,
  sendTest,
  setPrefs,
  type PushState,
} from '../kit/push';
import { ErrorText, GhostButton, InfoTip, SectionLabel, Switch, TextInput } from '../components/ui';
import { useToast } from '../components/Toast';
import { api, errorMessage } from '../lib/api';
import { useAppState } from '../lib/queries';
import { useSave } from '../lib/useSave';

const KINDS = NOTIFY_KINDS.map((k) => k.id);

/** The kit's ⓘ lines, with HSA Locker's timing in place of "daily ones at 8 a.m.". */
const KIT_INFO = pushInfo({ badge: BADGE_MEANS }).lines.filter((t) => !t.startsWith('Daily ones'));
const INFO = [
  KIT_INFO[0]!,
  'Needs review and Couldn’t read a document come once per document, soon after it’s read. Email inbox problems come once a day per problem. From 9 p.m. to 8 a.m. they wait until 8 a.m. and arrive together.',
  'Reimbursable milestone comes when Reimbursable reaches your amount, and again after it drops below and climbs back. The amount is the same on every device.',
  'Year-end comes on December 1 and the Weekly summary on Sundays, both at 8 a.m.',
  ...KIT_INFO.slice(1),
  'Prefer email? The Daily reminder email above is another option. Use either, both or neither.',
];

export function NotificationsSection() {
  const toast = useToast();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    getState()
      .then((s) => live && setState(s))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, []);

  async function act(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const blocker = state && pushBlocker(state, 'HSA Locker');
  const on = !!state?.on;

  return (
    <>
      <SectionLabel
        icon="bell"
        trailing={
          <InfoTip label={PUSH_TEXT.about}>
            <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-faint">
              {INFO.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </InfoTip>
        }
      >
        {PUSH_TEXT.heading}
      </SectionLabel>
      <div className="flex flex-col gap-3 px-6 pt-4 pb-2 text-sm text-soft">
        {!state ? (
          <p className="h-6" />
        ) : blocker ? (
          <>
            <div className="flex items-center gap-1.5">
              <p className="text-ink">{blocker.text}</p>
              {blocker.install && (
                <InfoTip label={PUSH_TEXT.howToInstall}>
                  <div className="flex flex-col gap-3">
                    {installSteps('HSA Locker').map((g) => (
                      <div key={g.label}>
                        <p className="font-medium text-ink">{g.label}</p>
                        <ol className="mt-1 flex list-decimal flex-col gap-0.5 pl-5 marker:text-faint">
                          {g.steps.map((t) => (
                            <li key={t}>{t}</li>
                          ))}
                        </ol>
                      </div>
                    ))}
                  </div>
                </InfoTip>
              )}
            </div>
            {blocker.install && !state.standalone && (
              <GhostButton
                icon="phone"
                className="-ml-3 self-start text-accent"
                onClick={() =>
                  document
                    .getElementById('install')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              >
                {PUSH_TEXT.installLink}
              </GhostButton>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="flex flex-1 items-center gap-1.5 text-base text-ink">
                {PUSH_TEXT.master}
                {state.standalone && (
                  <InfoTip label={PUSH_TEXT.whyItWorks}>
                    <p>{PUSH_TEXT.installed('HSA Locker')}</p>
                  </InfoTip>
                )}
              </span>
              <Switch
                on={on}
                disabled={busy}
                label={PUSH_TEXT.master}
                // Straight from the tap: the permission prompt needs it.
                onChange={(v) =>
                  act(async () => setState(await (v ? enablePush(KINDS) : disablePush())))
                }
              />
            </div>
            {on &&
              NOTIFY_KINDS.map((k) => (
                <Fragment key={k.id}>
                  <div className="flex items-center gap-3 border-t border-line pt-3">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-ink">{k.label}</span>
                      <span className="text-xs text-faint">{k.description}</span>
                    </span>
                    <Switch
                      on={state.device?.prefs[k.id] !== false}
                      label={k.label}
                      onChange={(v) =>
                        act(async () => {
                          // Show it now; the server agrees or the error says why.
                          setState((s) =>
                            s?.device
                              ? {
                                  ...s,
                                  device: { ...s.device, prefs: { ...s.device.prefs, [k.id]: v } },
                                }
                              : s,
                          );
                          const device = await setPrefs({ [k.id]: v });
                          if (device) setState((s) => s && { ...s, device });
                        })
                      }
                    />
                  </div>
                  {k.id === 'milestone' && state.device?.prefs.milestone !== false && (
                    <MilestoneAmount />
                  )}
                </Fragment>
              ))}
            {on && (
              <div className="border-t border-line pt-2">
                <GhostButton
                  icon="bell"
                  className="-ml-3 text-accent"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await sendTest();
                      toast({ text: PUSH_TEXT.testSent });
                    })
                  }
                >
                  {PUSH_TEXT.test}
                </GhostButton>
              </div>
            )}
          </>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </>
  );
}

/** "Notify me at $500": the Reimbursable milestone's amount (an app setting, shared by devices). */
function MilestoneAmount() {
  const { data: app } = useAppState();
  const { run, busy, error } = useSave();
  const saved = app?.settings.notify_milestone_cents ?? MILESTONE_DEFAULT_CENTS;
  // What's typed, until it's saved (null: show the saved amount).
  const [draft, setDraft] = useState<string | null>(null);
  const save = async () => {
    if (draft === null) return;
    const dollars = Number(draft.replace(/[$,\s]/g, ''));
    if (
      Number.isInteger(dollars) &&
      dollars >= 1 &&
      dollars <= 1_000_000 &&
      dollars * 100 !== saved
    )
      await run(() => api.patch('/settings', { notify_milestone_cents: dollars * 100 }));
    setDraft(null);
  };
  return (
    <div className="-mt-1 flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <span className="text-soft">Notify me at</span>
        <span className="relative w-28">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint">
            $
          </span>
          <TextInput
            inputMode="numeric"
            aria-label="Reimbursable milestone amount in dollars"
            className="py-1.5 pl-6 tnum"
            disabled={busy}
            value={draft ?? String(saved / 100)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </span>
      </label>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
