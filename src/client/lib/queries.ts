import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type {
  AppState,
  DocumentSummary,
  Entry,
  InboxLogRow,
  InboxVerification,
  LedgerEntry,
  Reimbursement,
} from '@shared/types';
import type { Totals, YearTotals } from '@shared/logic';
import { api } from './api';
import { needsCopy } from './reading';
import { copyOldPhoto } from './readingCopy';

export const keys = {
  state: ['state'] as const,
  summary: ['summary'] as const,
  ledger: ['ledger'] as const,
  review: ['review'] as const,
  doc: (id: string) => ['doc', id] as const,
  inFlight: ['in-flight'] as const,
  inbox: ['inbox'] as const,
  reimbursements: ['reimbursements'] as const,
  reimbursement: (id: string) => ['reimbursement', id] as const,
};

/** Everything that changes when entries or documents change. */
export const DATA_KEYS: QueryKey[] = [
  keys.state,
  keys.summary,
  keys.ledger,
  keys.review,
  ['doc'],
  keys.inFlight,
  keys.reimbursements,
];

/** How often the app checks on documents being read. */
const READING_POLL_MS = 3000;

/** App state. Polls every few seconds only while documents are being read. */
export function useAppState() {
  return useQuery({
    queryKey: keys.state,
    queryFn: () => api.get<AppState>('/state'),
    staleTime: 10_000,
    refetchInterval: (q) => (q.state.data?.counts.in_flight ? READING_POLL_MS : false),
  });
}

/**
 * The documents still being read (pending, processing, or failed with a retry to come), newest
 * first: the Ledger shows each as a placeholder row. Polls while there are any.
 */
export function useInFlightDocs() {
  const { data: state } = useAppState();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: keys.inFlight,
    queryFn: async () => {
      const before = qc.getQueryData<DocumentSummary[]>(keys.inFlight) ?? [];
      const docs = (
        await api.get<{ documents: DocumentSummary[] }>('/documents?status=in_flight&limit=50')
      ).documents;
      // One finished: its entries replace its placeholder straight away.
      const now = new Set(docs.map((d) => d.id));
      if (before.some((d) => !now.has(d.id)))
        for (const k of DATA_KEYS)
          if (k !== keys.inFlight) void qc.invalidateQueries({ queryKey: k });
      return docs;
    },
    refetchInterval: (q) =>
      (q.state.data?.length ?? 0) > 0 || (state?.counts.in_flight ?? 0) > 0
        ? READING_POLL_MS
        : false,
  });
  // A photo being read with no reading copy (sent before the app made them) gets one made from
  // its original here, once per document: reading the full-size original is slow and can fail.
  const docs = q.data;
  useEffect(() => {
    for (const d of docs ?? [])
      if (needsCopy(d))
        void copyOldPhoto(d).then((sent) => {
          if (sent) void qc.invalidateQueries({ queryKey: keys.inFlight });
        });
  }, [docs, qc]);
  return q;
}

/**
 * When a document finishes being read (the in-flight count drops), refreshes everything else so
 * its entries show up wherever you are, with no reload. Mounted once, in Layout.
 */
export function useRefreshWhenRead(inFlight: number | undefined) {
  const qc = useQueryClient();
  const last = useRef(inFlight);
  useEffect(() => {
    const before = last.current;
    last.current = inFlight;
    if (before === undefined || inFlight === undefined || inFlight >= before) return;
    for (const k of DATA_KEYS) if (k !== keys.state) void qc.invalidateQueries({ queryKey: k });
  }, [inFlight, qc]);
}

export interface SummaryData {
  totals: Totals;
  years: YearTotals[];
  this_year: YearTotals | null;
  recent: LedgerEntry[];
  year_basis: string;
}

export function useSummary() {
  return useQuery({ queryKey: keys.summary, queryFn: () => api.get<SummaryData>('/summary') });
}

export function useLedger() {
  return useQuery({
    queryKey: keys.ledger,
    queryFn: async () => (await api.get<{ entries: LedgerEntry[] }>('/entries')).entries,
  });
}

export function useReview() {
  return useQuery({
    queryKey: keys.review,
    queryFn: () => api.get<{ document_ids: string[]; entries: LedgerEntry[] }>('/review'),
  });
}

export interface DocDetail {
  document: DocumentSummary;
  entries: Entry[];
  inbox: InboxLogRow | null;
}

export function useDocument(id: string | null) {
  return useQuery({
    queryKey: keys.doc(id ?? 'none'),
    queryFn: () => api.get<DocDetail>(`/documents/${id}`),
    enabled: !!id,
    refetchInterval: (q) =>
      q.state.data && ['pending', 'processing', 'failed'].includes(q.state.data.document.status)
        ? 3000
        : false,
  });
}

export interface InboxData {
  address: string | null;
  domain: string | null;
  paused: boolean;
  last_received_at: string | null;
  stats_30d: { accepted: number; rejected: number; total: number };
  log: InboxLogRow[];
  verifications: InboxVerification[];
}

export function useInbox(poll = false) {
  return useQuery({
    queryKey: keys.inbox,
    queryFn: () => api.get<InboxData>('/inbox'),
    refetchInterval: poll ? 5000 : false,
  });
}

export function useReimbursements() {
  return useQuery({
    queryKey: keys.reimbursements,
    queryFn: async () =>
      (await api.get<{ reimbursements: Reimbursement[] }>('/reimbursements')).reimbursements,
  });
}

/** Mutation that refreshes all data afterwards. */
export function useDataMutation<TVars, TResult = unknown>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => Promise.all(DATA_KEYS.map((k) => qc.invalidateQueries({ queryKey: k }))),
  });
}

export function useRefreshData() {
  const qc = useQueryClient();
  return () => Promise.all(DATA_KEYS.map((k) => qc.invalidateQueries({ queryKey: k })));
}
