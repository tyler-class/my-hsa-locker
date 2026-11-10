import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
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

export const keys = {
  state: ['state'] as const,
  summary: ['summary'] as const,
  ledger: ['ledger'] as const,
  review: ['review'] as const,
  doc: (id: string) => ['doc', id] as const,
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
  keys.reimbursements,
];

/** App state. Polls every few seconds only while documents are being read. */
export function useAppState() {
  return useQuery({
    queryKey: keys.state,
    queryFn: () => api.get<AppState>('/state'),
    staleTime: 10_000,
    refetchInterval: (q) => (q.state.data?.counts.in_flight ? 3000 : false),
  });
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
