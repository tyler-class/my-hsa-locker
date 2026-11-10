import { useLayoutEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { AboutButton } from '../components/AboutSheet';
import { DocViewer } from '../components/DocViewer';
import { GlassTabBar, type GlassTab } from '../components/GlassTabBar';
import { Icon } from '../components/Icon';
import { cx } from '../components/ui';
import { useNotifications } from '../lib/notifications';
import { useAppState } from '../lib/queries';
import { useTabSwipe } from '../lib/tabSwipe';

const TABS: GlassTab[] = [
  ['/', 'Home', 'home'],
  ['/ledger', 'Ledger', 'receipt'],
  ['/review', 'Review', 'search'],
  ['/insights', 'Insights', 'chart'],
  ['/settings', 'Settings', 'settings'],
];

const TAB_PATHS = TABS.map(([to]) => to);

/** The tab whose main page this is (swiping between tabs works there), or null deeper in. */
function tabRoot(path: string): string | null {
  const p = path.replace(/\/+$/, '') || '/';
  return TAB_PATHS.includes(p) ? p : null;
}

function activeTab(path: string): string {
  for (const p of ['/ledger', '/review', '/insights', '/settings'])
    if (path.startsWith(p)) return p;
  if (path.startsWith('/reimbursements')) return '/ledger';
  return '/';
}

function Badge({ n, className }: { n: number; className?: string }) {
  if (!n) return null;
  return (
    <span
      aria-label={`${n} waiting`}
      className={cx(
        'inline-grid min-w-[18px] place-items-center rounded-full bg-warn px-1.5 text-[11px] leading-[18px] font-semibold text-white tnum',
        className,
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}

export function Layout() {
  const { pathname } = useLocation();
  // Every change of screen, Back included, opens at the top, never at the old scroll position.
  useLayoutEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);
  }, [pathname]);
  const active = activeTab(pathname);
  useTabSwipe(TAB_PATHS, tabRoot(pathname));
  const state = useAppState();
  const review = state.data?.counts.review_documents ?? 0;
  const inFlight = state.data?.counts.in_flight ?? 0;
  useNotifications(state.data?.counts.review_documents);
  return (
    // min-h-lvh: on a page too short to scroll, iOS home-screen apps size the viewport without the
    // safe areas and the fixed tab bar floats above the bottom. Filling the large viewport avoids it.
    <div className="min-h-full min-h-lvh md:pl-60 md:pt-safe">
      {/* Phones: a solid app bar at the top, like Nitrogen's. iOS blurs whatever scrolls under
          the status bar (and a little below it) in installed apps; over a plain bar it's invisible. */}
      <header className="sticky top-0 z-20 mb-2 flex h-[calc(env(safe-area-inset-top,0px)+48px)] items-center justify-center gap-2 border-b border-line bg-bg pt-[env(safe-area-inset-top,0px)] md:hidden">
        <Link to="/" aria-label="HSA Locker home" className="flex h-full items-center gap-2 px-3">
          <img src="/favicon.svg" alt="" className="h-7 w-7 rounded-lg" />
          <span className="text-[17px] font-semibold">HSA Locker</span>
        </Link>
      </header>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-chip px-3 pt-[calc(20px+env(safe-area-inset-top,0px))] pb-5 md:flex">
        <div className="flex items-center gap-2.5 px-3 pb-6">
          <img src="/favicon.svg" alt="" className="h-8 w-8 rounded-lg" />
          <span className="truncate text-[15px] font-semibold">HSA Locker</span>
        </div>
        <nav className="flex flex-col gap-1" aria-label="Main">
          {TABS.map(([to, label, icon]) => (
            <NavLink
              key={to}
              to={to}
              className={cx(
                'flex items-center gap-3 rounded-full px-3.5 py-2.5 text-[15px]',
                active === to
                  ? 'bg-accent-tint font-semibold text-accent'
                  : 'text-soft hover:bg-line/60',
              )}
              aria-current={active === to ? 'page' : undefined}
            >
              <Icon name={icon} />
              <span className="flex-1">{label}</span>
              {to === '/review' && <Badge n={review} />}
            </NavLink>
          ))}
        </nav>
        {inFlight > 0 && (
          <p className="mt-4 flex items-center gap-2 px-3.5 text-xs text-soft" role="status">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            Reading {inFlight} document{inFlight === 1 ? '' : 's'}…
          </p>
        )}
        <div className="mt-auto flex flex-col gap-1">
          <AboutButton variant="nav" />
          <a
            href="https://github.com/tyler-class/HSA-Locker"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 rounded-full px-3.5 py-2 text-xs text-faint hover:bg-line/60"
          >
            <Icon name="github" size={14} />
            HSA Locker on GitHub · v{__APP_VERSION__}
          </a>
        </div>
      </aside>

      <main className="mx-auto w-full max-w-2xl pb-[calc(var(--tabbar-clear)+16px)] md:max-w-4xl md:px-6 md:pt-4 md:pb-10">
        {inFlight > 0 && (
          <p
            className="mx-5 mt-1 flex items-center gap-2 text-xs text-soft md:hidden"
            role="status"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            Reading {inFlight} document{inFlight === 1 ? '' : 's'}…
          </p>
        )}
        <Outlet />
      </main>

      <DocViewer />

      {/* Phones: tabs in a floating glass capsule along the bottom. */}
      <GlassTabBar
        tabs={TABS}
        active={active}
        badges={review ? { '/review': <Badge n={review} className="ring-2 ring-bg" /> } : undefined}
      />
    </div>
  );
}
