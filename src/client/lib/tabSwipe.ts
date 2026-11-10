// Phones: swipe left or right on a tab's main page to go to the next or previous bottom tab.
// Only a clear, quick sideways swipe counts, and never one that starts on something that
// handles its own sideways gestures (swipe-to-delete rows, sideways-scrolling strips, fields)
// or while a sheet or menu is open. A long press followed by a move is a drag, not a swipe.
import { useEffect } from 'react';
import { useNavigate } from 'react-router';

/** Where a swipe never switches tabs. */
const OWN_GESTURES =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], [data-swipe-row], [data-no-tab-swipe]';
/** A phone layout: the bottom tab bar shows below Tailwind's md breakpoint. */
const PHONE = '(max-width: 767px)';
/** Sideways distance, how much more sideways than up/down, and the time limit. */
const MIN_DX = 60;
const RATIO = 1.5;
const MAX_MS = 600;
/** A first move this late means a long press (a drag), not a swipe. */
const LONG_PRESS_MS = 250;

/** Whether the touch starts inside something that scrolls sideways. */
function inSidewaysScroller(el: Element | null): boolean {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n);
    if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1)
      return true;
  }
  return false;
}

/**
 * Swipes between `tabs` (paths in tab-bar order) while `current` is one of them. Pass null on
 * pages below a tab (a trip, an editor) to turn swiping off there.
 */
export function useTabSwipe(tabs: readonly string[], current: string | null) {
  const navigate = useNavigate();
  useEffect(() => {
    if (current === null || !tabs.includes(current)) return;
    const phone = window.matchMedia?.(PHONE);
    let start: { x: number; y: number; t: number; moved: boolean } | null = null;

    const down = (e: TouchEvent) => {
      start = null;
      if (e.touches.length !== 1 || !phone?.matches) return;
      const target = e.target as Element | null;
      if (!target || target.closest(OWN_GESTURES) || inSidewaysScroller(target)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const p = e.touches[0]!;
      start = { x: p.clientX, y: p.clientY, t: Date.now(), moved: false };
    };
    const move = (e: TouchEvent) => {
      if (!start || start.moved) return;
      const p = e.touches[0]!;
      if (Math.hypot(p.clientX - start.x, p.clientY - start.y) < 10) return;
      start.moved = true;
      if (Date.now() - start.t > LONG_PRESS_MS) start = null;
    };
    const up = (e: TouchEvent) => {
      const s = start;
      start = null;
      if (!s) return;
      const p = e.changedTouches[0]!;
      const dx = p.clientX - s.x;
      const dy = p.clientY - s.y;
      if (Date.now() - s.t > MAX_MS || Math.abs(dx) < MIN_DX || Math.abs(dx) < RATIO * Math.abs(dy))
        return;
      if (window.getSelection()?.toString()) return;
      const next = tabs.indexOf(current) + (dx < 0 ? 1 : -1);
      if (next >= 0 && next < tabs.length) navigate(tabs[next]!);
    };
    const cancel = () => (start = null);

    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    document.addEventListener('touchcancel', cancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', cancel);
    };
  }, [tabs, current, navigate]);
}
