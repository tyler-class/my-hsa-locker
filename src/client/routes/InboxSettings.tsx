// Settings → Receipt forwarding address: the setup steps (with the person's own domain filled in),
// live status, forwarding help and verification codes.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { registrableDomain, suggestInboxSubdomain } from '@shared/logic';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import {
  cx,
  ErrorText,
  GhostButton,
  InfoTip,
  PageHeader,
  PrimaryButton,
  SectionLabel,
  SlideToggle,
  Switch,
  TextInput,
} from '../components/ui';
import { api } from '../lib/api';
import { EMAIL_ROUTING_URL, useEmailPath, type EmailPath } from '../lib/emailSetup';
import { ago } from '../lib/format';
import { useAppState, useInbox } from '../lib/queries';
import { useSave } from '../lib/useSave';

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <GhostButton
      icon={done ? 'check' : 'copy'}
      className="py-1 text-accent"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* selectable anyway */
        }
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </GhostButton>
  );
}

function Code({ children }: { children: string }) {
  return (
    <code className="block overflow-x-auto rounded-lg bg-chip px-3 py-2.5 font-mono text-[13px] whitespace-nowrap text-ink select-all">
      {children}
    </code>
  );
}

const OUTCOME: Record<string, string> = {
  received: 'Received',
  accepted: 'Accepted',
  duplicate: 'Already had it',
  rejected: 'Rejected',
  verification: 'Forwarding confirmation',
  ignored: 'Nothing to keep',
  failed: 'Couldn’t read',
};

const REASON: Record<string, string> = {
  unknown_recipient: 'wrong address',
  paused: 'inbox paused',
  too_large: 'too large',
  sender_not_allowed: 'sender not on the allow list',
  daily_cap: 'daily limit reached',
  no_usable_attachments: 'no PDFs or photos',
  empty_message: 'empty',
  too_many_attachments: 'some attachments over the limit',
  store_failed: 'couldn’t store it',
};

/** A subdomain of a registrable domain, e.g. hsa-in.example.com (not example.com itself). */
function isSubdomain(h: string) {
  const reg = registrableDomain(h);
  return !!reg && reg !== h;
}

interface InboxCheck {
  dns: 'ok' | 'missing' | 'other' | 'unknown';
  mx: string[];
  routing: 'ok' | 'waiting' | 'mismatch';
  other_address: string | null;
}

interface DomainCheck {
  domain: string;
  status: 'cloudflare' | 'elsewhere' | 'unknown';
  ns: string[];
}

/** The first line everywhere email is set up. */
export const NEEDS_DOMAIN = 'Needs a domain on your Cloudflare account.';
const SKIP_EMAIL = 'Skip this. Upload and Take photo do the same thing.';

/** Why a domain: shown behind the ⓘ next to the requirement. */
function WhyDomain() {
  return (
    <InfoTip label="Why a domain?">
      <p>
        Mail can only be delivered to a domain you control. The app’s workers.dev address can’t
        receive email, so it needs a domain whose settings (DNS) are on your Cloudflare account.
      </p>
    </InfoTip>
  );
}

/** "Needs a domain on your Cloudflare account." with the why behind an ⓘ. */
function Requirement() {
  return (
    <div className="flex items-center gap-1.5 text-ink">
      {NEEDS_DOMAIN}
      <WhyDomain />
    </div>
  );
}

/** A button-styled link that opens the Cloudflare dashboard in a new tab. */
export function CloudflareButton({ children }: { children: ReactNode }) {
  return (
    <a
      href={EMAIL_ROUTING_URL}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 self-start rounded-full bg-chip px-4 py-2 text-[15px] font-medium text-ink"
    >
      {children}
      <Icon name="open" size={15} className="text-accent" />
    </a>
  );
}

/** "Needs a domain on your Cloudflare account", then the fork (unless the app's own domain answers it). */
export function DomainFork({
  path,
  requirement = true,
}: {
  path: EmailPath;
  /** Off where the requirement is already the page's first line. */
  requirement?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      {requirement && <Requirement />}
      {path.host ? (
        <p className="flex items-center gap-2 text-ok">
          <Icon name="check" size={16} /> Your domain {path.host} is on Cloudflare.
        </p>
      ) : (
        <>
          <SlideToggle<'yes' | 'no'>
            label="Do you have a domain on Cloudflare?"
            className="sm:max-w-sm"
            value={path.answer}
            onChange={path.setAnswer}
            options={[
              ['yes', 'I have one'],
              ['no', 'I don’t'],
            ]}
          />
          {path.answer === 'no' && <p className="text-soft">{SKIP_EMAIL}</p>}
        </>
      )}
    </div>
  );
}

/** One setup step: a status mark, a short title, then one sentence and a button. */
function Step({
  n,
  state,
  title,
  info,
  children,
}: {
  n: number;
  state: 'ok' | 'bad' | 'wait';
  title: string;
  info?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 border-b border-line py-4 last:border-b-0">
      <span
        className={cx(
          'mt-px grid h-6 w-6 flex-none place-items-center rounded-full text-xs font-semibold',
          state === 'ok'
            ? 'bg-ok text-white'
            : state === 'bad'
              ? 'bg-warn text-white'
              : 'bg-chip text-soft',
        )}
        aria-label={state === 'ok' ? 'Done' : state === 'bad' ? 'Needs attention' : 'Not yet'}
      >
        {state === 'ok' ? (
          <Icon name="check" size={14} strokeWidth={2.4} />
        ) : state === 'bad' ? (
          '!'
        ) : (
          n
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 text-sm">
        <h3 className="flex items-center gap-1.5 text-[15px] font-semibold text-ink">
          {title}
          {info}
        </h3>
        {children}
      </div>
    </li>
  );
}

/** Waits until the value has stopped changing for a moment (for lookups while typing). */
function useSettled<T>(value: T, ms = 600): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function InboxSettings() {
  const nav = useNavigate();
  const { data: state } = useAppState();
  const path = useEmailPath();
  if (!state) return null;
  const s = state.settings;
  const configured = !!s.inbox_address;
  return (
    <div className="pb-16">
      <PageHeader title="Receipt forwarding address" back="/settings" sub={<Requirement />} />
      {!configured && (
        <div className="px-6 pt-3">
          <DomainFork path={path} requirement={false} />
        </div>
      )}
      {(configured || path.go) && (
        <SetupSteps key={`${s.inbox_local}@${s.inbox_domain ?? ''}`} host={path.host} />
      )}
      <div className="px-6 pt-6">
        <GhostButton className="-ml-3" icon="back" onClick={() => nav('/settings')}>
          Back to Settings
        </GhostButton>
      </div>
    </div>
  );
}

const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** The steps, with the address the person typed (or the suggested one) filled in throughout. */
function SetupSteps({ host }: { host: string | null }) {
  const toast = useToast();
  const { data: state } = useAppState();
  const s = state!.settings;
  const configured = !!s.inbox_address;
  const inbox = useInbox(configured);
  const check = useQuery({
    queryKey: ['inbox-check', s.inbox_address],
    queryFn: () => api.get<InboxCheck>('/inbox/check'),
    enabled: configured,
    refetchInterval: (q) =>
      q.state.data?.routing === 'ok' && q.state.data.dns === 'ok' ? false : 10_000,
  });
  const [sub, setSub] = useState(s.inbox_domain ?? (host ? suggestInboxSubdomain(host) : ''));
  const [name, setName] = useState(s.inbox_local);
  const { run, busy, error } = useSave();
  const subOk = isSubdomain(sub);
  const nameOk = LOCAL_RE.test(name);
  const changed = name !== s.inbox_local || sub !== (s.inbox_domain ?? '');
  const shownSub = subOk ? sub : 'hsa-in.yourdomain.com';
  const apex = registrableDomain(shownSub) ?? 'yourdomain.com';
  // Is the typed domain on Cloudflare? Known already when it's the app's own domain.
  const lookFor = useSettled(subOk ? registrableDomain(sub) : null);
  const ns = useQuery({
    queryKey: ['domain-check', lookFor],
    queryFn: () =>
      api.get<DomainCheck>(`/inbox/domain-check?domain=${encodeURIComponent(lookFor!)}`),
    enabled: !!lookFor && lookFor !== host,
    staleTime: 5 * 60_000,
  });
  const onCf = subOk && apex === host ? 'cloudflare' : lookFor === apex ? ns.data?.status : null;
  const c = check.data;
  const i = inbox.data;
  const lastAccepted = i?.log.find((l) => l.outcome !== 'rejected');

  return (
    <>
      <ol className="flex flex-col px-6 pt-2">
        <Step
          n={1}
          state={configured && !changed ? 'ok' : 'wait'}
          title="Choose the address"
          info={
            <InfoTip label="Why a subdomain?">
              <p>
                A subdomain is a new name in front of your domain, like{' '}
                <span className="font-mono">hsa-in.{apex}</span>. Using one keeps your normal email
                at {apex} working; pointing {apex} itself here would take over its mail.
              </p>
            </InfoTip>
          }
        >
          <TextInput
            aria-label="Email subdomain"
            placeholder="hsa-in.yourdomain.com"
            value={sub}
            onChange={(e) => setSub(e.target.value.trim().toLowerCase())}
          />
          {sub && !subOk ? (
            <p className="text-xs text-warn">
              Add a name in front of your domain, like hsa-in.{registrableDomain(sub) ?? 'it'}.
            </p>
          ) : onCf === 'cloudflare' && apex !== host ? (
            <p className="flex items-center gap-1.5 text-xs text-ok">
              <Icon name="check" size={14} /> {apex} is on Cloudflare.
            </p>
          ) : onCf === 'elsewhere' ? (
            <p className="text-xs text-warn">
              {apex} isn’t on Cloudflare, so mail to it can’t reach HSA Locker.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <TextInput
              aria-label="Address name"
              className="min-w-0 flex-[1_1_11rem] font-mono"
              value={name}
              onChange={(e) => setName(e.target.value.trim().toLowerCase())}
            />
            <span className="min-w-0 font-mono [overflow-wrap:anywhere] text-soft">
              @{shownSub}
            </span>
          </div>
          <p className="text-xs text-faint">
            {name && !nameOk
              ? 'Use letters, numbers, dots, dashes or underscores.'
              : 'Keep it hard to guess: anyone who has it can send you documents.'}
          </p>
          <PrimaryButton
            className="self-start"
            disabled={busy || !nameOk || !subOk || !changed}
            onClick={async () => {
              if (
                s.inbox_domain &&
                !confirm(
                  `Change the address to ${name}@${sub}? The current one stops working, so the Cloudflare routing rule must match.`,
                )
              )
                return;
              await run(
                () => api.patch('/settings', { inbox_domain: sub, inbox_local: name }),
                [['inbox'], ['inbox-check']],
              );
            }}
          >
            Save address
          </PrimaryButton>
          <ErrorText>{error}</ErrorText>
        </Step>

        <Step
          n={2}
          state={
            !configured || changed
              ? 'wait'
              : c?.dns === 'ok'
                ? 'ok'
                : c && c.dns !== 'unknown'
                  ? 'bad'
                  : 'wait'
          }
          title="Add it in Cloudflare"
          info={
            <InfoTip label="If Cloudflare asks about your main domain">
              <p>
                If Cloudflare offers to set up email for {apex} itself, skip it. Only{' '}
                <span className="font-mono">{shownSub}</span> needs it.
              </p>
            </InfoTip>
          }
        >
          <p className="text-soft">
            Pick <strong className="text-ink">{apex}</strong>, open{' '}
            <strong className="text-ink">Settings</strong>, and add{' '}
            <strong className="font-mono text-ink">{shownSub}</strong> under Subdomains.
          </p>
          {configured && !changed && c?.dns === 'missing' && (
            <p className="text-xs text-warn">Not found yet. It can take a few minutes.</p>
          )}
          {configured && !changed && c?.dns === 'other' && (
            <p className="text-xs text-warn">{shownSub} already gets mail somewhere else.</p>
          )}
          <CloudflareButton>Open Email Routing</CloudflareButton>
        </Step>

        <Step
          n={3}
          state={
            !configured || changed
              ? 'wait'
              : c?.routing === 'ok'
                ? 'ok'
                : c?.routing === 'mismatch'
                  ? 'bad'
                  : 'wait'
          }
          title="Send its mail to HSA Locker"
        >
          <p className="text-soft">
            Under <strong className="text-ink">Routing Rules</strong>, create a rule for{' '}
            <strong className="font-mono [overflow-wrap:anywhere] text-ink">
              {name || 'the name'}@{shownSub}
            </strong>{' '}
            that does <strong className="text-ink">Send to a Worker</strong>:{' '}
            <strong className="text-ink">hsa-locker</strong>.
          </p>
          {configured && !changed && c?.routing === 'mismatch' && (
            <p className="text-xs text-warn">
              Mail arrived for {c.other_address}, which doesn’t match this address.
            </p>
          )}
          <CloudflareButton>Open Email Routing</CloudflareButton>
        </Step>
      </ol>

      {s.inbox_address && (
        <>
          <SectionLabel icon="check">Send a test</SectionLabel>
          <div className="flex flex-col gap-3 px-6 pt-4 text-sm">
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <Code>{s.inbox_address}</Code>
              </div>
              <Copy text={s.inbox_address} />
            </div>
            <div className="flex items-center gap-1.5 text-soft">
              Email it a receipt (a PDF or photo) from another account.
              <InfoTip label="Sending from your own domain">
                <p>
                  A mail service that hosts {registrableDomain(s.inbox_domain ?? '') ?? apex} may
                  keep the message internal. In Fastmail, set the domain’s Routing to external.
                </p>
              </InfoTip>
            </div>
            {lastAccepted ? (
              <p className="flex items-center gap-2 text-ok" role="status">
                <Icon name="check" size={16} /> Received {ago(lastAccepted.received_at)}:{' '}
                {lastAccepted.attachment_count} attachment
                {lastAccepted.attachment_count === 1 ? '' : 's'}, {lastAccepted.document_count}{' '}
                document
                {lastAccepted.document_count === 1 ? '' : 's'} logged.
              </p>
            ) : (
              <p className="flex items-center gap-2 text-soft" role="status">
                <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> Waiting for the
                first email…
              </p>
            )}
          </div>

          {i && i.verifications.length > 0 && (
            <>
              <SectionLabel icon="review">Verification waiting</SectionLabel>
              <div className="flex flex-col gap-3 px-6 pt-4">
                {i.verifications.map((v) => (
                  <div
                    key={v.id}
                    className="flex flex-col gap-2 rounded-xl bg-warn-tint p-4 text-sm"
                  >
                    <p className="font-medium text-ink">
                      {v.provider} wants to confirm forwarding to HSA Locker ({ago(v.received_at)}).
                    </p>
                    {v.code && (
                      <div className="flex items-center gap-1">
                        <span className="text-soft">Code:</span>
                        <span className="font-mono text-base text-ink">{v.code}</span>
                        <Copy text={v.code} />
                      </div>
                    )}
                    {v.link && (
                      <a
                        className="self-start text-accent"
                        href={v.link}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open the confirmation link
                      </a>
                    )}
                    <GhostButton
                      className="-ml-3 self-start"
                      onClick={() =>
                        run(() => api.post(`/inbox/verifications/${v.id}/dismiss`), [['inbox']])
                      }
                    >
                      Done, hide this
                    </GhostButton>
                  </div>
                ))}
              </div>
            </>
          )}

          <SectionLabel icon="mail">Sending receipts</SectionLabel>
          <ForwardingHelp address={s.inbox_address} />

          <SectionLabel icon="inbox">Status</SectionLabel>
          <div className="flex flex-col gap-2 px-6 pt-4 text-sm">
            {s.inbox_paused && (
              <p className="text-warn">
                The inbox is paused: all mail is rejected. Turn it back on under Limits.
              </p>
            )}
            {i && (
              <p className="text-soft">
                Last received {i.last_received_at ? ago(i.last_received_at) : 'never'} · last 30
                days: {i.stats_30d.accepted} accepted, {i.stats_30d.rejected} rejected
              </p>
            )}
            <div className="flex flex-wrap gap-x-1">
              <GhostButton
                icon="refresh"
                className="-ml-3"
                disabled={busy}
                onClick={async () => {
                  if (
                    !confirm(
                      'Make a new address? The current one stops working right away, so update your forwarding rules.',
                    )
                  )
                    return;
                  if (await run(() => api.post('/inbox/rotate'), [['inbox']]))
                    toast({ text: 'New address ready' });
                }}
              >
                Rotate address
              </GhostButton>
              <GhostButton
                icon="play"
                disabled={busy}
                onClick={() => run(() => api.post('/documents/process-now'))}
              >
                Process pending now
              </GhostButton>
              <GhostButton
                icon="undo"
                disabled={busy}
                onClick={() => run(() => api.post('/documents/retry-failed'))}
              >
                Retry failed
              </GhostButton>
            </div>
            <Limits />
            <h3 className="pt-5 pb-1 text-sm font-semibold text-ink">Recent mail</h3>
            <ul className="-mx-6 flex flex-col px-6">
              {(i?.log ?? []).slice(0, 20).map((l) => (
                <li
                  key={l.id}
                  className="flex items-baseline gap-3 border-b border-line py-2 text-xs"
                >
                  <span className="w-20 flex-none text-faint">{ago(l.received_at)}</span>
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {l.subject || '(no subject)'}
                    <span className="text-faint"> · {l.from_addr}</span>
                  </span>
                  <span
                    className={cx(
                      'flex-none',
                      l.outcome === 'rejected' || l.outcome === 'failed'
                        ? 'text-danger'
                        : 'text-soft',
                    )}
                  >
                    {OUTCOME[l.outcome] ?? l.outcome}
                    {l.reason && REASON[l.reason] ? ` (${REASON[l.reason]})` : ''}
                    {l.document_count ? ` · ${l.document_count}` : ''}
                  </span>
                </li>
              ))}
              {i && !i.log.length && <li className="py-2 text-xs text-faint">No mail yet.</li>}
            </ul>
          </div>
        </>
      )}
    </>
  );
}

function Limits() {
  const { data: state } = useAppState();
  const { run, error } = useSave();
  const s = state!.settings;
  const [allow, setAllow] = useState(s.inbox_allowlist.join(', '));
  const num = (key: string, label: string, value: number, min: number, max: number) => (
    <label className="flex items-center gap-3 border-b border-line py-2">
      <span className="min-w-0 flex-1 text-soft">{label}</span>
      <span className="w-24 flex-none">
        <TextInput
          type="number"
          min={min}
          max={max}
          className="py-1.5 text-right tnum"
          defaultValue={value}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isInteger(v) && v >= min && v <= max && v !== value)
              run(() => api.patch('/settings', { [key]: v }));
          }}
        />
      </span>
    </label>
  );
  return (
    <details className="pt-2">
      <summary className="cursor-pointer text-sm font-medium text-ink">Limits</summary>
      <div className="flex flex-col pt-2">
        <div className="flex items-center gap-3 border-b border-line py-2.5">
          <span className="min-w-0 flex-1 text-soft">
            Pause the inbox (rejects all mail, for emergencies)
          </span>
          <Switch
            label="Pause the inbox"
            on={s.inbox_paused}
            onChange={(paused) =>
              run(() => api.patch('/settings', { inbox_paused: paused }), [['inbox']])
            }
          />
        </div>
        {num('inbox_min_kb', 'Skip images smaller than (KB)', s.inbox_min_kb, 0, 5000)}
        {num('inbox_max_attachments', 'Attachments per email', s.inbox_max_attachments, 1, 50)}
        {num('inbox_max_mb', 'Largest email (MB)', s.inbox_max_mb, 1, 25)}
        {num('inbox_daily_cap', 'Emails per day', s.inbox_daily_cap, 1, 1000)}
        <label className="flex flex-col gap-1.5 pt-3">
          <span className="text-soft">Only accept mail from (optional)</span>
          <TextInput
            placeholder="you@example.com, @pharmacy.example"
            value={allow}
            onChange={(e) => setAllow(e.target.value)}
            onBlur={() =>
              run(() =>
                api.patch('/settings', {
                  inbox_allowlist: allow
                    .split(',')
                    .map((x) => x.trim().toLowerCase())
                    .filter(Boolean),
                }),
              )
            }
          />
          <span className="text-xs text-faint">
            Forwarded mail keeps the original sender’s address.
          </span>
        </label>
        <ErrorText>{error}</ErrorText>
      </div>
    </details>
  );
}

function ForwardingHelp({ address }: { address: string }) {
  const [tab, setTab] = useState<'gmail' | 'outlook' | 'fastmail' | 'apple'>('gmail');
  const steps: Record<typeof tab, string[]> = {
    gmail: [
      'Settings → See all settings → Forwarding and POP/IMAP → Add a forwarding address. Gmail sends a code to HSA Locker; it shows on this page under “Verification waiting”.',
      'Create a filter that matches only receipts (for example from a pharmacy’s receipt address, with “receipt” in the subject) and choose “Forward it to”.',
    ],
    outlook: [
      'Settings → Mail → Rules → Add new rule. Match only receipts, then “Forward to”.',
      'Some work accounts block forwarding outside the organization.',
    ],
    fastmail: [
      'Settings → Filters & Rules → New rule. Match only receipts, then “Send a copy to”.',
      'Settings → Domains: set Routing to “Always route mail to this domain externally” if the address is on a domain Fastmail hosts.',
    ],
    apple: [
      'iCloud Mail on the web: Settings → Rules → Add a rule. Match only receipts, then forward.',
      'iCloud may ask you to verify the address; the code shows on this page.',
    ],
  };
  return (
    <div className="flex flex-col gap-3 px-6 pt-4 text-sm">
      <p className="text-ink">
        Receipts arrive in your own inbox as usual. Forward the ones you want to{' '}
        <span className="font-mono">{address}</span>.
      </p>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-ink">
        <li>
          <strong>By hand:</strong> forward the email. The receipt can be an attachment or the email
          itself.
        </li>
        <li>
          <strong>With an AI assistant</strong> that can use your email: ask it to find this week’s
          medical receipts and forward them to the address.
        </li>
      </ul>
      <details>
        <summary className="cursor-pointer text-ink">Optional: forward some automatically</summary>
        <div className="flex flex-col gap-3 pt-3">
          <p className="text-soft">
            Only for senders that send nothing but receipts. Never forward all mail from your
            insurer or doctor: statements and messages would end up in Review.
          </p>
          <SlideToggle<typeof tab>
            label="Email provider"
            value={tab}
            onChange={setTab}
            options={[
              ['gmail', 'Gmail'],
              ['outlook', 'Outlook'],
              ['fastmail', 'Fastmail'],
              ['apple', 'iCloud'],
            ]}
          />
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-ink">
            {steps[tab].map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      </details>
    </div>
  );
}
