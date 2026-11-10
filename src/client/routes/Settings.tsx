import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { exportFilename, extForMime, uniqueNames } from '@shared/logic';
import { AboutButton } from '../components/AboutSheet';
import { Icon } from '../components/Icon';
import { InstallHint } from '../components/InstallHint';
import { isStandalone } from '../lib/pwa';
import { useToast } from '../components/Toast';
import {
  cx,
  ErrorText,
  GhostButton,
  InfoTip,
  IconButton,
  PageHeader,
  PrimaryButton,
  SectionLabel,
  SlideToggle,
  Switch,
  Sheet,
  TextInput,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { deliverFile, useSaveFile } from '../lib/files';
import { useAppState } from '../lib/queries';
import { useSave } from '../lib/useSave';
import { useTheme, type Theme } from '../lib/theme';
import { readStoredZip, ZipWriter } from '../lib/zip';
import { isSourceRepo, runUrl, setupUrl, UPSTREAM, useLatestVersion } from '../lib/updates';
import {
  autoUpdatesInfo,
  howUpdatesWork,
  UPDATE_TEXT,
  updateStatus,
  whatsShared,
  workflowFileUrl,
} from '../kit/updates';

/** What the usage counts count, in words (matches USAGE_TABLES in the worker). */
const USAGE_COUNTED = 'documents, entries and reimbursements';
import { ConnectAISection } from './ConnectAI';
import { NotificationsSection } from './NotificationsSection';
import { buildFlags } from '@shared/kit/build';
import { PeopleEditor } from './SettingsLists';
import { CloudflareButton, DomainFork, NEEDS_DOMAIN } from './InboxSettings';
import { useEmailPath } from '../lib/emailSetup';

function Row({
  icon,
  children,
  onClick,
  to,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  children: React.ReactNode;
  onClick?: () => void;
  to?: string;
}) {
  const cls =
    'flex w-full items-center gap-3 border-b border-line py-3.5 text-left text-base text-ink';
  const inner = (
    <>
      <Icon name={icon} size={18} className="text-accent" />
      <span className="flex-1">{children}</span>
      <Icon name="chevRight" className="text-faint" />
    </>
  );
  if (to)
    return (
      <Link to={to} className={cls}>
        {inner}
      </Link>
    );
  return (
    <button onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

/** A Settings row's text: a count, then what fills the list. */
function CountLine({ n, text }: { n: number; text: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-medium tnum">{n}</span>
      <span className="text-sm text-soft">· {text}</span>
    </span>
  );
}

export function Settings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: state } = useAppState();
  const { run, busy, error } = useSave();
  const [theme, setTheme] = useTheme();
  const [restore, setRestore] = useState<{ file: File; data: unknown } | null>(null);
  const [restoreError, setRestoreError] = useState('');
  const [card, setCard] = useState('');
  const [zipStatus, setZipStatus] = useState('');
  const [danger, setDanger] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [aiTest, setAiTest] = useState<string>('');
  const fileRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const emailPath = useEmailPath();
  const saveFile = useSaveFile();
  if (!state) return null;
  const s = state.settings;

  async function pickFile(f: File | undefined) {
    if (!f) return;
    setRestoreError('');
    try {
      setRestore({ file: f, data: JSON.parse(await f.text()) });
    } catch {
      setRestoreError('That file isn’t an HSA Locker backup.');
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  /** Builds the documents ZIP in the browser: originals with readable names, plus ledger.csv. */
  async function downloadDocuments() {
    setZipStatus('Preparing…');
    try {
      const m = await api.get<{
        documents: {
          id: string;
          mime: string;
          date: string | null;
          person: string | null;
          provider: string | null;
          amount_cents: number | null;
          received_at: string;
        }[];
      }>('/export/manifest');
      const names = uniqueNames(
        m.documents.map(
          (d) =>
            `${d.id.slice(0, 8)}_${exportFilename({ date: d.date, person: d.person, provider: d.provider, amount_cents: d.amount_cents, ext: extForMime(d.mime) })}`,
        ),
      );
      const zip = new ZipWriter();
      const manifest: { name: string; document_id: string }[] = [];
      for (const [i, d] of m.documents.entries()) {
        setZipStatus(`Adding ${i + 1} of ${m.documents.length}…`);
        const res = await fetch(`/api/files/${d.id}?download=1`, { credentials: 'same-origin' });
        if (!res.ok) continue;
        zip.add(
          `documents/${names[i]}`,
          new Uint8Array(await res.arrayBuffer()),
          new Date(d.received_at),
        );
        manifest.push({ name: `documents/${names[i]}`, document_id: d.id });
      }
      const csv = await (
        await fetch('/api/export/ledger.csv', { credentials: 'same-origin' })
      ).text();
      zip.add('ledger.csv', new TextEncoder().encode(csv));
      zip.add('manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
      const name = `hsa-locker-documents-${new Date().toISOString().slice(0, 10)}.zip`;
      const file = new File([zip.finish()], name, { type: 'application/zip' });
      setZipStatus('');
      // Phones: the share sheet (a slow build can need one more tap). Computers: a download.
      if ((await deliverFile(file)) === 'needs-tap')
        toast({
          text: 'Your ZIP is ready.',
          action: { label: 'Share', icon: 'share', run: () => void deliverFile(file) },
        });
    } catch (e) {
      setZipStatus(errorMessage(e));
    }
  }

  /** Puts files back from a documents ZIP (after restoring a JSON backup on a new instance). */
  async function restoreFiles(f: File | undefined) {
    if (!f) return;
    setZipStatus('Reading…');
    try {
      const files = readStoredZip(await f.arrayBuffer());
      const manifest = files.find((x) => x.name === 'manifest.json');
      if (!manifest)
        throw new Error('That ZIP has no manifest.json. Use a documents export from HSA Locker.');
      const list = JSON.parse(new TextDecoder().decode(manifest.data)) as {
        name: string;
        document_id: string;
      }[];
      let n = 0;
      for (const item of list) {
        const file = files.find((x) => x.name === item.name);
        if (!file) continue;
        setZipStatus(`Restoring ${++n} of ${list.length}…`);
        const res = await fetch(`/api/restore-file/${item.document_id}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file.data as BodyInit,
        });
        if (!res.ok && res.status !== 404) throw new Error(`Restore failed (${res.status}).`);
      }
      setZipStatus('');
      toast({ text: `Restored ${n} files` });
    } catch (e) {
      setZipStatus(errorMessage(e));
    }
    if (zipRef.current) zipRef.current.value = '';
  }

  return (
    <div className="pb-12">
      <PageHeader
        title="Settings"
        icon="settings"
        action={<AboutButton variant="header" className="md:hidden" />}
      />

      <SectionLabel icon="palette">Appearance</SectionLabel>
      <div className="px-6 pt-4 pb-2">
        <SlideToggle<Theme>
          label="Appearance"
          value={theme}
          onChange={setTheme}
          options={[
            ['light', 'Light'],
            ['dark', 'Dark'],
            ['system', 'System'],
          ]}
        />
      </div>

      <SectionLabel icon="mailSend">Receipt forwarding address</SectionLabel>
      <div className="px-6 pt-3">
        {s.inbox_address ? (
          <Row icon="mail" to="/settings/inbox">
            <span className="flex flex-col">
              Email inbox {s.inbox_paused ? '(paused)' : ''}
              <span className="truncate font-mono text-xs text-soft">{s.inbox_address}</span>
            </span>
          </Row>
        ) : (
          <>
            <DomainFork path={emailPath} />
            {emailPath.go && (
              <Row icon="mail" to="/settings/inbox">
                Set up a receipt forwarding address
              </Row>
            )}
          </>
        )}
        {state.counts.failed > 0 && (
          <p className="pt-2 text-sm text-warn">
            {state.counts.failed} document{state.counts.failed === 1 ? '' : 's'} couldn’t be read
            yet.{' '}
            <button
              className="text-accent"
              onClick={() => run(() => api.post('/documents/retry-failed'))}
            >
              Retry now
            </button>
          </p>
        )}
      </div>

      <ReminderEmail />

      <SectionLabel icon="users">People</SectionLabel>
      <PeopleEditor state={state} />

      <SectionLabel icon="card">Reimbursing</SectionLabel>
      <div className="flex flex-col gap-3 px-6 pt-4 text-sm">
        <span className="text-ink">HSA cards</span>
        <p className="text-soft">
          Receipts paid with these cards are marked not claimable (“Paid with the HSA card”). Others
          (or with no card printed) stay reimbursable.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {s.hsa_cards.map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 rounded-full bg-chip py-0.5 pr-1 pl-3"
            >
              •••• {c}
              <IconButton
                icon="x"
                label={`Remove card ${c}`}
                className="h-6 w-6"
                onClick={() =>
                  run(() =>
                    api.patch('/settings', { hsa_cards: s.hsa_cards.filter((x) => x !== c) }),
                  )
                }
              />
            </span>
          ))}
        </div>
        <form
          className="flex w-full gap-2 sm:w-1/2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (card.length !== 4) return;
            if (await run(() => api.patch('/settings', { hsa_cards: [...s.hsa_cards, card] })))
              setCard('');
          }}
        >
          <TextInput
            inputMode="numeric"
            maxLength={4}
            placeholder="Last 4 digits"
            value={card}
            onChange={(e) => setCard(e.target.value.replace(/\D/g, ''))}
          />
          <GhostButton type="submit" icon="plus" disabled={card.length !== 4 || busy}>
            Add
          </GhostButton>
        </form>
        <ErrorText>{error}</ErrorText>
      </div>

      <SectionLabel icon="tag">Providers</SectionLabel>
      <div className="px-6 pt-1">
        <Row icon="tag" to="/settings/providers">
          <CountLine n={state.providers.length} text="Added automatically from your receipts" />
        </Row>
      </div>

      <SectionLabel icon="layers">Categories</SectionLabel>
      <div className="px-6 pt-1">
        <Row icon="layers" to="/settings/categories">
          <CountLine n={state.categories.length} text="The AI picks one for each receipt" />
        </Row>
      </div>

      <SectionLabel icon="ai">Reading documents</SectionLabel>
      <div className="flex flex-col gap-3 px-6 pt-4 text-sm">
        <p className="text-ink">
          {state.ai.provider === 'workers-ai' ? 'Workers AI' : state.ai.provider} ·{' '}
          <span className="font-mono text-xs">{state.ai.text_model}</span>
          {state.ai.gateway ? ' · through AI Gateway' : ''}
        </p>
        <p
          className={
            state.ai.third_party ? 'rounded-lg bg-warn-tint px-3 py-2 text-warn' : 'text-soft'
          }
        >
          {state.ai.third_party
            ? `Documents are sent to ${state.ai.provider} to be read. They contain health information. That provider’s terms apply.`
            : 'Documents are read by Workers AI inside your own Cloudflare account. They aren’t sent to any other company.'}
        </p>
        <OwnKeyHelp />
        <p className="text-xs text-faint">HSA Locker makes no HIPAA compliance claims.</p>
        <div className="flex items-center gap-3">
          <PrimaryButton
            tone="secondary"
            disabled={aiTest === 'Testing…'}
            onClick={async () => {
              setAiTest('Testing…');
              try {
                const r = await api.post<{
                  ok: boolean;
                  ms: number;
                  model?: string;
                  error?: string;
                }>('/ai/test');
                setAiTest(
                  r.ok
                    ? `Works: read a sample receipt in ${(r.ms / 1000).toFixed(1)} s.`
                    : `Didn’t work (${r.error ?? 'wrong result'}).`,
                );
              } catch (e) {
                setAiTest(errorMessage(e));
              }
            }}
          >
            Test extraction
          </PrimaryButton>
          <span className="text-soft">{aiTest}</span>
        </div>
      </div>

      <NotificationsSection />

      <ConnectAISection />

      {/* Already installed: nothing to do here, so no section. */}
      {!isStandalone() && (
        <>
          <div id="install" className="scroll-mt-14 md:scroll-mt-0">
            <SectionLabel icon="phone">Install on your phone</SectionLabel>
          </div>
          <div className="px-6 py-4">
            <InstallHint />
          </div>
        </>
      )}

      <SectionLabel icon="archive">Backup</SectionLabel>
      <p className="px-6 pt-4 text-sm text-soft">
        The data backup is one JSON file. The documents export is a ZIP of every original file,
        named by date, person, provider and amount, plus a ledger.csv: an audit packet.
      </p>
      <div className="flex flex-col px-6 pt-1">
        <Row icon="download" onClick={() => void saveFile('/api/export', 'hsa-locker-backup.json')}>
          Download data backup (JSON)
        </Row>
        <Row icon="download" onClick={downloadDocuments}>
          Download all documents (ZIP)
        </Row>
        <Row icon="download" onClick={() => void saveFile('/api/export/ledger.csv', 'ledger.csv')}>
          Download ledger (CSV)
        </Row>
        <Row icon="upload" onClick={() => fileRef.current?.click()}>
          Restore data from backup…
        </Row>
        <Row icon="upload" onClick={() => zipRef.current?.click()}>
          Restore documents from ZIP…
        </Row>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
        <input
          ref={zipRef}
          type="file"
          accept="application/zip,.zip"
          hidden
          onChange={(e) => restoreFiles(e.target.files?.[0])}
        />
        {zipStatus && (
          <p className="pt-2 text-sm text-soft" role="status">
            {zipStatus}
          </p>
        )}
        <ErrorText>{restoreError}</ErrorText>
      </div>

      <UpdatesSection
        setUp={buildFlags().updatesOn || state.kit.updates_set_up}
        onSetUp={() => run(() => api.patch('/settings', { updates_set_up: true }))}
        telemetry={state.kit.telemetry}
        onTelemetry={(telemetry) => run(() => api.patch('/settings', { telemetry }))}
      />

      <SectionLabel icon="user">Account</SectionLabel>
      <div className="px-6 pt-2">
        <button
          className="flex w-full items-center gap-3 border-y border-line py-3.5 text-left text-base text-ink"
          onClick={async () => {
            try {
              await api.post('/logout');
            } finally {
              qc.clear();
              window.location.href = '/';
            }
          }}
        >
          <Icon name="logout" size={18} className="text-accent" />
          <span className="flex-1">Sign out of this device</span>
        </button>
        <div className="hidden pt-2 md:block">
          <AboutButton variant="nav" className="-ml-3.5" />
        </div>
      </div>

      <SectionLabel icon="trash">Danger zone</SectionLabel>
      <div className="px-6 pt-3">
        <GhostButton icon="trash" className="-ml-3 text-danger" onClick={() => setDanger(true)}>
          Delete all data…
        </GhostButton>
      </div>

      <Sheet
        open={!!restore}
        onClose={() => setRestore(null)}
        title="Replace everything?"
        footer={
          <>
            <GhostButton onClick={() => setRestore(null)}>Cancel</GhostButton>
            <PrimaryButton
              tone="danger"
              disabled={busy}
              onClick={async () => {
                if (!restore) return;
                try {
                  const r = await api.post<{ missing_files: number }>('/import', restore.data);
                  await qc.invalidateQueries();
                  setRestore(null);
                  toast({
                    text: r.missing_files
                      ? `Restored. ${r.missing_files} files are missing: restore the documents ZIP next.`
                      : 'Backup restored',
                  });
                } catch (e) {
                  setRestoreError(errorMessage(e));
                  setRestore(null);
                }
              }}
            >
              Restore
            </PrimaryButton>
          </>
        }
      >
        <p className="py-2 text-sm text-soft">
          Everything in this HSA Locker is replaced with the contents of {restore?.file.name}.
          Document files aren’t in this backup; restore them from a documents ZIP afterwards if this
          is a new instance. This can’t be undone.
        </p>
      </Sheet>

      <Sheet
        open={danger}
        onClose={() => setDanger(false)}
        title="Delete all data?"
        footer={
          <>
            <GhostButton onClick={() => setDanger(false)}>Cancel</GhostButton>
            <PrimaryButton
              tone="danger"
              disabled={busy || confirmText !== 'DELETE EVERYTHING'}
              onClick={async () => {
                if (await run(() => api.post('/delete-everything', { confirm: confirmText }))) {
                  setDanger(false);
                  await qc.invalidateQueries();
                  toast({ text: 'Everything was deleted' });
                }
              }}
            >
              Delete everything
            </PrimaryButton>
          </>
        }
      >
        <div className="flex flex-col gap-3 py-2 text-sm text-soft">
          <p>
            Every document, file, entry, reimbursement, person and provider is deleted. Download a
            backup first.
          </p>
          <label className="flex flex-col gap-1.5">
            <span>Type DELETE EVERYTHING to confirm</span>
            <TextInput value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </label>
        </div>
      </Sheet>
    </div>
  );
}

const SECRETS: [string, string][] = [
  ['LLM_PROVIDER', 'anthropic, openai or gemini'],
  ['LLM_API_KEY', 'your API key'],
  ['LLM_MODEL', 'optional: a different model'],
];

/** How to switch to your own model key. Keys are Worker secrets, never stored in the app. */
function OwnKeyHelp() {
  const toast = useToast();
  const copy = (t: string) =>
    void navigator.clipboard
      ?.writeText(t)
      .then(() => toast({ text: 'Copied.' }))
      .catch(() => {});
  return (
    <details className="text-soft">
      <summary className="cursor-pointer text-ink">
        Use your own Anthropic, OpenAI or Gemini key
      </summary>
      <div className="flex flex-col gap-3 pt-3">
        <p>
          Add these as secrets in the{' '}
          <a
            className="text-accent"
            href="https://dash.cloudflare.com/?to=/:account/workers/services/view/hsa-locker/production/settings"
            target="_blank"
            rel="noreferrer"
          >
            Cloudflare dashboard
          </a>{' '}
          (Variables and Secrets → Add → Secret), or run the commands from a copy of the code.
        </p>
        <ul className="flex flex-col">
          {SECRETS.map(([name, what]) => {
            const cmd = `npx wrangler secret put ${name}`;
            return (
              <li key={name} className="flex items-center gap-3 border-b border-line py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-mono text-[13px] text-ink">{name}</span>
                  <span className="text-xs text-faint">{what}</span>
                </span>
                <button
                  type="button"
                  onClick={() => copy(cmd)}
                  title={cmd}
                  className="inline-flex flex-none items-center gap-1.5 text-sm text-accent"
                >
                  <Icon name="copy" size={14} />
                  Copy command
                </button>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-faint">
          Keys are never stored in the app. Remove the secrets to go back to Workers AI.
        </p>
      </div>
    </details>
  );
}

/** Settings → Daily reminder email. It sends from the inbox's domain, so it waits for the inbox. */
function ReminderEmail() {
  const { data: state } = useAppState();
  const { run, busy, error } = useSave();
  const [email, setEmail] = useState(state?.settings.notify_email ?? '');
  const [result, setResult] = useState('');
  if (!state) return null;
  const s = state.settings;
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const ready = !!s.inbox_domain;
  const step = 'flex flex-col gap-2 border-b border-line py-3';
  const num = 'text-ink font-medium';
  return (
    <>
      <SectionLabel icon="mail">Daily reminder email</SectionLabel>
      <div className="flex flex-col gap-2 px-6 pt-4 text-sm">
        {!ready && <p className="text-ink">{NEEDS_DOMAIN}</p>}
        <p className="text-soft">One email on days when something is waiting in Review.</p>
        {!ready && (
          <p className="rounded-xl bg-chip px-3 py-2.5 text-soft">
            Set up a{' '}
            <Link to="/settings/inbox" className="text-accent">
              receipt forwarding address
            </Link>{' '}
            first: the reminder sends from its domain.
          </p>
        )}
        <div
          inert={!ready}
          aria-disabled={!ready}
          className={cx('flex flex-col', !ready && 'opacity-45 select-none')}
        >
          <div className={step}>
            <span className={num}>1. Add the address reminders go to</span>
            <span className="text-soft">
              Under Destination Addresses, add your email and click the link Cloudflare sends.
            </span>
            <CloudflareButton>Open Email Routing</CloudflareButton>
          </div>
          <div className={step}>
            <span className={num}>2. Enter the same address here</span>
            <form
              className="flex w-full gap-2 sm:w-2/3"
              onSubmit={async (e) => {
                e.preventDefault();
                await run(() =>
                  api.patch('/settings', {
                    notify_email: email.trim() || null,
                    ...(email.trim() ? {} : { notify_daily: false }),
                  }),
                );
              }}
            >
              <TextInput
                type="email"
                aria-label="Reminder email address"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <PrimaryButton
                tone="secondary"
                type="submit"
                disabled={
                  busy || (email.trim() !== '' && !valid) || email.trim() === (s.notify_email ?? '')
                }
              >
                Save
              </PrimaryButton>
            </form>
          </div>
          <div className={step}>
            <div className="flex items-center gap-3">
              <span className={`flex-1 ${num}`}>3. Turn on the daily reminder</span>
              <Switch
                label="Daily review reminder"
                on={s.notify_daily}
                disabled={!s.notify_email}
                onChange={(notify_daily) => run(() => api.patch('/settings', { notify_daily }))}
              />
            </div>
            <span className="text-xs text-faint">
              Sent around 8 a.m. Eastern from reminders@{s.inbox_domain ?? 'your inbox domain'}.
            </span>
          </div>
          <div className="flex flex-col gap-1 pt-3">
            <span className={num}>4. Send a test</span>
            <div className="flex items-center gap-3">
              <GhostButton
                icon="mail"
                className="-ml-3 text-accent"
                disabled={busy || !s.notify_email}
                onClick={async () => {
                  setResult('Sending…');
                  const r = await run(() =>
                    api.post<{ sent: boolean; reason?: string }>('/notify/test'),
                  );
                  setResult(
                    r ? (r.sent ? 'Sent. Check your inbox.' : (r.reason ?? 'Not sent.')) : '',
                  );
                }}
              >
                Send a test
              </GhostButton>
              {result && <span className="text-soft">{result}</span>}
            </div>
          </div>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
    </>
  );
}

const LINK_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2.5 text-[15px] font-medium';

/**
 * Updates: is a newer HSA Locker out, and links into this copy's own GitHub repo to add the
 * update workflow (once) or run it. Updates go HSA Locker → their repo → their Cloudflare.
 */
function UpdatesSection({
  setUp,
  onSetUp,
  telemetry,
  onTelemetry,
}: {
  setUp: boolean;
  onSetUp: () => void;
  telemetry: boolean;
  onTelemetry: (on: boolean) => void;
}) {
  const latest = useLatestVersion();
  const repo = __SOURCE_REPO__;
  const isSource = isSourceRepo(repo, UPSTREAM);
  const auto = autoUpdatesInfo('HSA Locker');
  const status = updateStatus('HSA Locker', __APP_VERSION__, latest.data, latest.isError);
  const how = howUpdatesWork('HSA Locker');
  const shared = whatsShared('HSA Locker', USAGE_COUNTED, true);

  return (
    <>
      <SectionLabel
        icon="download"
        trailing={
          !isSource && (
            <InfoTip label={UPDATE_TEXT.howUpdatesWork}>
              <div className="flex flex-col gap-2">
                <p>{how.intro}</p>
                <ol className="flex list-decimal flex-col gap-1 pl-5 marker:text-faint">
                  {how.steps.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ol>
                <p>{how.outro}</p>
              </div>
            </InfoTip>
          )
        }
      >
        {UPDATE_TEXT.heading}
      </SectionLabel>
      <div className="flex flex-col gap-3 px-6 pt-4 pb-2 text-sm text-soft">
        <p className={cx(status.newer && 'text-ink')}>{status.text}</p>
        {setUp && repo && !isSource && (
          <div className="flex items-center gap-1.5 text-ink">
            <Icon name="check" size={16} className="text-accent" />
            {UPDATE_TEXT.autoOn}
            <InfoTip label={UPDATE_TEXT.aboutAutoOn}>
              <div className="flex flex-col gap-2">
                <p>{auto.what}</p>
                <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-faint">
                  {auto.how.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <p>{auto.off}</p>
                <a
                  href={workflowFileUrl(repo, __SOURCE_BRANCH__)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline underline-offset-2"
                >
                  {auto.fileLink}
                </a>
              </div>
            </InfoTip>
          </div>
        )}
        {isSource ? null : !repo ? (
          <p className="text-xs text-faint">{UPDATE_TEXT.byHand}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {setUp ? (
                <a
                  href={runUrl(repo)}
                  target="_blank"
                  rel="noreferrer"
                  className={cx(
                    LINK_BUTTON,
                    status.newer ? 'bg-accent text-accent-ink' : 'bg-chip text-ink',
                  )}
                >
                  <Icon name="reset" size={16} />
                  {UPDATE_TEXT.updateNow}
                </a>
              ) : (
                <a
                  href={setupUrl(repo, __SOURCE_BRANCH__)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={onSetUp}
                  className={cx(LINK_BUTTON, 'bg-accent text-accent-ink')}
                >
                  <Icon name="github" size={16} />
                  {UPDATE_TEXT.setUp}
                </a>
              )}
              <a
                href={`https://github.com/${repo}`}
                target="_blank"
                rel="noreferrer"
                className="px-1 text-[13px] text-soft underline-offset-2 hover:underline"
              >
                {repo}
              </a>
            </div>
            <p className="text-xs text-faint">
              {setUp ? (
                <>
                  {UPDATE_TEXT.updateNowHint}{' '}
                  <a
                    href={workflowFileUrl(repo, __SOURCE_BRANCH__)}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    {UPDATE_TEXT.updateFile}
                  </a>
                </>
              ) : (
                UPDATE_TEXT.setUpHint
              )}
            </p>
          </>
        )}
        <div className="flex items-center gap-3 border-t border-line pt-3">
          <span className="flex flex-1 items-center gap-1.5 text-ink">
            {UPDATE_TEXT.telemetry}
            <InfoTip label={UPDATE_TEXT.whatsShared}>
              <div className="flex flex-col gap-2">
                <p>{shared.intro}</p>
                <ul className="flex list-disc flex-col gap-0.5 pl-5 marker:text-faint">
                  {shared.items.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <p>{shared.outro}</p>
              </div>
            </InfoTip>
          </span>
          <Switch on={telemetry} onChange={onTelemetry} label={UPDATE_TEXT.telemetry} />
        </div>
      </div>
    </>
  );
}
