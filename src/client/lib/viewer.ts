// The full-screen document and email viewer opens over whatever page you're on, as a history
// entry (#doc=<id> or #email=<id>), so the browser's back gesture closes it as well as its Back
// button. The page underneath (and any sheet open on it) stays as it was.
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router';

export type Viewing = { kind: 'doc' | 'email'; id: string } | null;

export function parseViewing(hash: string): Viewing {
  const m = /^#(doc|email)=([\w-]+)$/.exec(hash);
  return m ? { kind: m[1] as 'doc' | 'email', id: m[2]! } : null;
}

export function useViewer() {
  const nav = useNavigate();
  const loc = useLocation();
  const open = useCallback(
    (kind: 'doc' | 'email', id: string) =>
      nav(
        { pathname: loc.pathname, search: loc.search, hash: `${kind}=${id}` },
        { state: { viewer: true } },
      ),
    [nav, loc.pathname, loc.search],
  );
  const close = useCallback(() => {
    // Opened from in the app: step back. Arrived straight at the link: just drop the hash.
    if ((loc.state as { viewer?: boolean } | null)?.viewer) nav(-1);
    else nav({ pathname: loc.pathname, search: loc.search }, { replace: true });
  }, [nav, loc.pathname, loc.search, loc.state]);
  return { viewing: parseViewing(loc.hash), open, close };
}
