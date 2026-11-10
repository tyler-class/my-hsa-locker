import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { LedgerEntry } from '@shared/types';
import { api } from '../lib/api';
import { formatDate, money } from '../lib/format';
import { useAppState, useDocument } from '../lib/queries';
import { fileUrl, useSaveFile } from '../lib/files';
import { useSave } from '../lib/useSave';
import { useViewer } from '../lib/viewer';
import { ReasonChips, StatusChip } from './bits';
import { DocPreview } from './DocPreview';
import { bodyFromForm, EntryForm, formFromEntry } from './EntryForm';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { ActionList, cx, Menu, PrimaryButton, Sheet, SlideToggle } from './ui';

/**
 * One entry, editable, beside its original document. Desktop: document left, details right,
 * each scrolling on its own. Phone: a Details / Document switch.
 */
export function EntrySheet({ entry, onClose }: { entry: LedgerEntry | null; onClose: () => void }) {
  return entry ? <EntrySheetBody key={entry.id} entry={entry} onClose={onClose} /> : null;
}

function EntrySheetBody({ entry, onClose }: { entry: LedgerEntry; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const { data: state } = useAppState();
  const doc = useDocument(entry.document_id);
  const [form, setForm] = useState(() => formFromEntry(entry));
  const [formError, setFormError] = useState('');
  const [tab, setTab] = useState<'details' | 'document'>('details');
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const { run, busy, error } = useSave();
  const viewer = useViewer();
  const saveFile = useSaveFile();
  if (!state) return null;

  const reimbursed = !!entry.reimbursement_id;
  const inReview = entry.review_reasons.length > 0;

  async function save(approve = false) {
    const { body, error } = bodyFromForm(form);
    if (error) return setFormError(error);
    setFormError('');
    const ok = await run(async () => {
      await api.patch(`/entries/${entry.id}`, body);
      if (approve) await api.post(`/entries/${entry.id}/approve`);
      return true;
    });
    if (ok) onClose();
  }

  async function toggleReimbursed() {
    if (reimbursed) {
      if (await run(() => api.post('/entries/unreimburse', { ids: [entry.id] })))
        toast({ text: 'Marked not reimbursed' });
    } else if (
      await run(() =>
        api.post('/reimbursements', {
          date: new Date().toISOString().slice(0, 10),
          entry_ids: [entry.id],
        }),
      )
    )
      toast({ text: 'Marked reimbursed' });
    onClose();
  }

  const details = (
    <div className="flex flex-col gap-4 pb-4">
      <ReasonChips reasons={entry.review_reasons} />
      {entry.source_quote && (
        <p className="text-xs text-faint">From the document: “{entry.source_quote}”</p>
      )}
      <EntryForm
        value={form}
        onChange={setForm}
        state={state}
        printed={{ patient: entry.patient_name_raw, provider: entry.provider_name_raw }}
        error={formError || error}
      />
      {doc.data?.inbox && (
        <p className="text-xs text-faint">
          Emailed from {doc.data.inbox.from_addr} on{' '}
          {formatDate(doc.data.inbox.received_at.slice(0, 10))}
          {doc.data.inbox.subject ? ` · “${doc.data.inbox.subject}”` : ''}
        </p>
      )}
      {doc.data && (
        <p className="text-xs text-faint">
          {doc.data.document.filename}
          {doc.data.document.extraction_model
            ? ` · read by ${doc.data.document.extraction_model}`
            : ''}
        </p>
      )}
    </div>
  );

  const document = (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-none items-center justify-between gap-2 text-sm">
        <span className="min-w-0 truncate text-soft">
          {doc.data?.document.filename ?? 'Document'}
        </span>
        <button
          type="button"
          onClick={() => viewer.open('doc', entry.document_id)}
          className="inline-flex flex-none items-center gap-1.5 text-accent"
        >
          <Icon name="open" size={15} />
          Open
        </button>
      </div>
      {doc.data ? (
        <DocPreview doc={doc.data.document} className="min-h-0 flex-1" fill />
      ) : (
        <div className="flex-1 rounded-xl border border-line bg-chip" />
      )}
    </div>
  );

  return (
    <Sheet
      open
      wide
      onClose={onClose}
      title={entry.type === 'eob' ? 'EOB line' : `Receipt · ${money(entry.amount_cents)}`}
      sub={
        <span className="flex flex-wrap items-center gap-2">
          <StatusChip entry={entry} />
          {formatDate(entry.service_date ?? entry.payment_date)}
        </span>
      }
      closeButton
      footer={
        <>
          <button
            ref={moreRef}
            type="button"
            onClick={() => setMenu(moreRef.current?.getBoundingClientRect() ?? null)}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-2.5 text-[15px] text-soft hover:bg-chip"
          >
            <Icon name="more" size={18} />
            More
          </button>
          <div className="flex items-center gap-2">
            {entry.type === 'receipt' && (
              <PrimaryButton
                tone="secondary"
                icon={reimbursed ? 'undo' : 'check'}
                disabled={busy}
                onClick={toggleReimbursed}
              >
                <span className="hidden sm:inline">
                  {reimbursed ? 'Mark not reimbursed' : 'Mark reimbursed'}
                </span>
                <span className="sm:hidden">{reimbursed ? 'Undo' : 'Reimburse'}</span>
              </PrimaryButton>
            )}
            <PrimaryButton
              className="whitespace-nowrap"
              disabled={busy}
              onClick={() => save(inReview)}
            >
              {inReview ? (
                <>
                  <span className="hidden sm:inline">Save &amp; approve</span>
                  <span className="sm:hidden">Approve</span>
                </>
              ) : (
                'Save'
              )}
            </PrimaryButton>
          </div>
        </>
      }
    >
      {/* Phone: one pane at a time. */}
      <div className="flex-none pt-1 pb-3 md:hidden">
        <SlideToggle
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            ['details', 'Details'],
            ['document', 'Document'],
          ]}
        />
      </div>
      <div className="flex min-h-0 flex-1 gap-6">
        <section
          aria-label="Document"
          className={cx(
            'min-h-0 flex-1 pb-3 md:block md:w-[55%] md:flex-none',
            tab === 'document' ? 'block' : 'hidden',
          )}
        >
          {document}
        </section>
        <section
          aria-label="Details"
          className={cx(
            'min-h-0 flex-1 overflow-y-auto overscroll-contain md:block md:pr-1',
            tab === 'details' ? 'block' : 'hidden',
          )}
        >
          {details}
        </section>
      </div>

      <Menu open={!!menu} onClose={() => setMenu(null)} anchor={menu} title="More">
        <ActionList
          actions={[
            {
              icon: 'open',
              label: 'Open original',
              onClick: () => {
                setMenu(null);
                viewer.open('doc', entry.document_id);
              },
            },
            {
              icon: 'download',
              label: 'Download original',
              onClick: () => {
                setMenu(null);
                void saveFile(
                  fileUrl(entry.document_id),
                  doc.data?.document.filename ?? 'document',
                );
              },
            },
            {
              icon: 'mail',
              label: 'Original email',
              hidden: !doc.data?.document.has_eml,
              onClick: () => {
                setMenu(null);
                viewer.open('email', entry.document_id);
              },
            },
            {
              icon: 'receipt',
              label: 'View reimbursement',
              hidden: !reimbursed,
              onClick: () => nav(`/reimbursements/${entry.reimbursement_id}`),
            },
            {
              icon: 'refresh',
              label: 'Read the document again',
              hidden: reimbursed,
              onClick: async () => {
                setMenu(null);
                if (
                  !confirm('Read this document again? Its entries are replaced and edits are lost.')
                )
                  return;
                await run(() => api.post(`/documents/${entry.document_id}/reprocess`));
                onClose();
              },
            },
            {
              icon: 'trash',
              label: 'Delete this entry',
              danger: true,
              hidden: reimbursed,
              onClick: async () => {
                setMenu(null);
                if (!confirm('Delete this entry? The document stays.')) return;
                if (await run(() => api.del(`/entries/${entry.id}`))) onClose();
              },
            },
          ]}
        />
      </Menu>
    </Sheet>
  );
}
