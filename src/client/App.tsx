import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { startPwa } from './lib/pwa';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { api, ApiError, onUnauthorized } from './lib/api';
import { ToastProvider } from './components/Toast';
import { Login, SetupNeeded } from './routes/Login';
import { Layout } from './routes/Layout';
import { Home } from './routes/Home';
import { Insights } from './routes/Insights';
import { Ledger } from './routes/Ledger';
import { Review } from './routes/Review';
import { Reimbursement } from './routes/Reimbursement';
import { Settings } from './routes/Settings';
import { InboxSettings } from './routes/InboxSettings';
import { CategoriesSettings, ProvidersSettings } from './routes/ListSettings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && [401, 403, 404, 503].includes(e.status)) && n < 2,
      refetchOnWindowFocus: true,
      // Offline-tolerant: keep showing the last data while a refetch fails.
      networkMode: 'offlineFirst',
    },
  },
});

startPwa();

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/ledger', element: <Ledger /> },
      { path: '/review', element: <Review /> },
      { path: '/review/:id', element: <Review /> },
      { path: '/insights', element: <Insights /> },
      { path: '/reimbursements/:id', element: <Reimbursement /> },
      { path: '/settings', element: <Settings /> },
      { path: '/settings/inbox', element: <InboxSettings /> },
      { path: '/settings/providers', element: <ProvidersSettings /> },
      { path: '/settings/categories', element: <CategoriesSettings /> },
      { path: '*', element: <Home /> },
    ],
  },
]);

function Gate() {
  const qc = useQueryClient();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ ok: true }>('/session'),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  useEffect(
    () =>
      onUnauthorized(() => {
        qc.setQueryData(['session'], null);
        qc.invalidateQueries({ queryKey: ['session'] });
      }),
    [qc],
  );
  if (session.isPending) return <div className="h-full bg-bg" />;
  const err = session.error;
  if (err instanceof ApiError && err.status === 503) return <SetupNeeded message={err.message} />;
  if (err instanceof ApiError && err.status === 0) return <RouterProvider router={router} />;
  if (err || !session.data) return <Login />;
  return <RouterProvider router={router} />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </QueryClientProvider>
  );
}
