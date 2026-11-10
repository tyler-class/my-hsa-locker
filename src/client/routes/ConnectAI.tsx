import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Icon } from '../components/Icon';
import {
  cx,
  ErrorText,
  GhostButton,
  SectionLabel,
  SlideToggle,
  SubHeading,
} from '../components/ui';
import { assistants, ASSISTANT_INTRO, CONNECTED_TEXT, signInNote } from '../kit/assistants';
import { useToast } from '../components/Toast';
import { EXAMPLE_PROMPTS } from '@shared/examples';

/** Example requests (the same list the MCP server offers), tap to copy. */
function TryAsking() {
  const toast = useToast();
  return (
    <div className="flex flex-col px-6">
      <p className="pb-1 text-xs text-faint">{CONNECTED_TEXT.examplesHint}</p>
      {EXAMPLE_PROMPTS.slice(0, 6).map((e) => (
        <button
          key={e.prompt}
          type="button"
          title="Copy"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(e.prompt)
              .then(() => toast({ text: 'Copied.' }))
              .catch(() => {})
          }
          className="flex items-start gap-3 border-b border-line py-3 text-left text-sm text-ink"
        >
          <span className="flex-1">“{e.prompt}”</span>
          <Icon name="copy" size={15} className="mt-0.5 flex-none text-faint" />
        </button>
      ))}
      <p className="pt-2 text-xs text-faint">Claude also lists ready-made prompts in its + menu.</p>
    </div>
  );
}

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
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
          /* clipboard blocked: the text is selectable */
        }
      }}
    >
      {done ? 'Copied' : label}
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

/** The “Connect an AI assistant” part of Settings (Selfhost Kit layout: src/client/kit/assistants.ts). */
export function ConnectAISection() {
  const url = `${window.location.origin}/mcp`;
  const list = assistants('HSA Locker', 'hsa-locker', url);
  const [open, setOpen] = useState<string | null>(null);
  const [examples, setExamples] = useState(false);
  const shown = list.find((a) => a.id === open);
  return (
    <div>
      <SectionLabel icon="sparkle">Connect an AI assistant</SectionLabel>
      <div className="flex flex-col gap-3 px-6 pt-4 text-sm text-soft">
        <p>{ASSISTANT_INTRO('HSA ledger')} It can’t see the documents themselves.</p>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-soft">{CONNECTED_TEXT.urlLabel('HSA Locker')}</span>
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <Code>{url}</Code>
            </div>
            <Copy text={url} />
          </div>
          <span className="text-xs text-faint">{signInNote('HSA Locker')}</span>
        </div>
      </div>

      <SubHeading>{CONNECTED_TEXT.heading}</SubHeading>
      <Connections />

      <SubHeading>{CONNECTED_TEXT.setUp}</SubHeading>
      <div className="flex flex-col gap-3 px-6 text-sm">
        <SlideToggle
          label="AI assistant"
          value={open}
          allowClear
          onChange={setOpen}
          options={list.map((a) => [a.id, a.name])}
        />
        {shown && (
          <div className="flex flex-col gap-2 text-ink">
            {shown.steps.length > 0 && (
              <ol className="flex list-decimal flex-col gap-1.5 pl-5">
                {shown.steps.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ol>
            )}
            {shown.commandIntro && <p className="text-soft">{shown.commandIntro}</p>}
            {shown.command && (
              <div className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <Code>{shown.command}</Code>
                </div>
                <Copy text={shown.command} />
              </div>
            )}
            {shown.after && <p className="text-soft">{shown.after}</p>}
          </div>
        )}
      </div>

      <button
        type="button"
        aria-expanded={examples}
        onClick={() => setExamples((v) => !v)}
        className="flex w-full items-center gap-1.5 px-6 pt-5 pb-2 text-left text-sm font-semibold text-ink"
      >
        {CONNECTED_TEXT.examples}
        <Icon
          name="chevDown"
          size={14}
          className={cx('text-faint transition-transform', !examples && '-rotate-90')}
        />
      </button>
      {examples && <TryAsking />}
    </div>
  );
}

function Connections() {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({
    queryKey: ['connections'],
    queryFn: () =>
      api.get<{ connections: { id: string; name: string; created_at: string | null }[] }>(
        '/connections',
      ),
  });
  const list = q.data?.connections ?? [];
  return (
    <div className="flex flex-col gap-1 px-6 text-sm">
      {q.isPending && <p className="text-soft">Loading…</p>}
      {!q.isPending && !list.length && <p className="text-soft">{CONNECTED_TEXT.none}</p>}
      {list.map((c) => (
        <div key={c.id} className="flex items-center gap-2 border-b border-line py-2.5 text-ink">
          <Icon name="sparkle" size={16} className="text-soft" />
          <span className="flex-1">{c.name}</span>
          {c.created_at && (
            <span className="text-xs text-faint">
              {new Date(c.created_at).toLocaleDateString()}
            </span>
          )}
        </div>
      ))}
      {list.length > 0 && (
        <GhostButton
          icon="x"
          className="-ml-3 self-start text-danger"
          onClick={async () => {
            if (!confirm) {
              setConfirm(true);
              setTimeout(() => setConfirm(false), 3000);
              return;
            }
            setConfirm(false);
            setError('');
            try {
              await api.post('/connections/revoke-all');
              await qc.invalidateQueries({ queryKey: ['connections'] });
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        >
          {confirm ? CONNECTED_TEXT.confirm : CONNECTED_TEXT.disconnectAll}
        </GhostButton>
      )}
      <ErrorText>{error || (q.error ? errorMessage(q.error) : '')}</ErrorText>
    </div>
  );
}
