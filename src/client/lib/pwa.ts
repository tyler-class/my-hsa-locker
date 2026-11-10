// Keeps the installed app (iOS home screen especially) on the latest deploy.
//
// iOS resumes a home-screen app from memory instead of reloading it, so a new deploy is never
// noticed on its own. Two things fix that:
// 1. The page itself (HTML) is fetched network-first in the service worker (vite.config.ts), so
//    any real load gets the newest build when online. Hashed JS/CSS stay cached; they never change.
// 2. Whenever the app comes back to the foreground (and every 30 minutes while open) we ask the
//    browser to check for a new service worker. When one is ready we switch to it and reload,
//    but never while a sheet is open or a field has focus, so nothing being typed is lost.
import { registerSW } from 'virtual:pwa-register';

let reg: ServiceWorkerRegistration | undefined;
let pending = false;
let updateSW: ((reload?: boolean) => Promise<void>) | undefined;

/** A sheet or menu is open, or someone is typing: reloading now could lose their work. */
function busy(): boolean {
  if (document.querySelector('[role="dialog"], [role="listbox"], [role="menu"]')) return true;
  const el = document.activeElement;
  return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

let applying = false;

/**
 * Switches to the waiting version and reloads into it. vite-plugin-pwa only reloads after an
 * update it saw itself, and one found by our own foreground check can slip past it, so we also
 * tell the waiting worker directly and reload when it takes control. If that somehow doesn't
 * happen, a plain reload still gets the new pages (they're network-first).
 */
function apply() {
  if (applying) return;
  applying = true;
  const waiting = reg?.waiting;
  void updateSW?.(true);
  waiting?.postMessage({ type: 'SKIP_WAITING' });
  setTimeout(() => window.location.reload(), 5000);
}

function applyIfIdle() {
  // A waiting worker counts even if the "needs refresh" event was missed (e.g. it was found by
  // a check made while a sheet was open).
  if (reg?.waiting) pending = true;
  if (pending && !busy()) apply();
}

function check() {
  void reg
    ?.update()
    .then(() => applyIfIdle())
    .catch(() => {
      /* offline: try again next time */
    });
}

export function startPwa() {
  navigator.serviceWorker?.addEventListener('controllerchange', () => {
    if (applying) window.location.reload();
  });
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      pending = true;
      applyIfIdle();
    },
    onRegisteredSW(_url, r) {
      reg = r;
    },
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    check();
    applyIfIdle();
  });
  // Waiting on an open sheet: apply as soon as it closes.
  setInterval(() => applyIfIdle(), 3000);
  setInterval(() => document.visibilityState === 'visible' && check(), 30 * 60 * 1000);
}

/** Running as the installed app (home screen), not in a browser tab. */
export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true;
