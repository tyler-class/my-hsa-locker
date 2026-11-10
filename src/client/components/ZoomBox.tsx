import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { cx } from './ui';

/** What part of the content shows, in the content's own (unzoomed) pixels. */
export interface ZoomView {
  scale: number;
  top: number;
  bottom: number;
  /** False while a finger is still moving (or a fling is running). */
  settled: boolean;
}

interface T {
  s: number;
  x: number;
  y: number;
}

const MAX_SCALE = 6;
const TAP_MS = 250;
const TAP_SLOP = 10;
const DOUBLE_MS = 300;

/** The nearest scrolling ancestor, stopping at a dialog (never scroll the page behind a sheet). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
    if (n.getAttribute('role') === 'dialog') return null;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/**
 * Pinch, drag and double-tap zoom inside a box, never the page around it. The content is laid
 * out at the box's width and moved with a CSS transform; touches here never reach the browser
 * (touch-action: none), so the page itself can't zoom. Unzoomed, a vertical drag that runs out of
 * content keeps scrolling whatever the box sits in, so a short preview doesn't trap the finger.
 */
export function ZoomBox({
  children,
  className,
  style,
  align = 'top',
  onView,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Content shorter than the box: at the top (documents) or centred (photos). */
  align?: 'top' | 'center';
  onView?: (v: ZoomView) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const t = useRef<T>({ s: 1, x: 0, y: 0 });
  const [zoomed, setZoomed] = useState(false);
  const onViewRef = useRef(onView);
  useEffect(() => {
    onViewRef.current = onView;
  });
  const anim = useRef(0);
  const lastEmit = useRef(0);

  const clamp = useCallback(
    (n: T): T => {
      const b = box.current;
      const c = inner.current;
      if (!b || !c) return n;
      const s = Math.min(MAX_SCALE, Math.max(1, n.s));
      const cw = b.clientWidth;
      const ch = b.clientHeight;
      const w = c.offsetWidth * s;
      const h = c.offsetHeight * s;
      const x = w <= cw ? (cw - w) / 2 : Math.min(0, Math.max(cw - w, n.x));
      const y =
        h <= ch ? (align === 'center' ? (ch - h) / 2 : 0) : Math.min(0, Math.max(ch - h, n.y));
      return { s, x, y };
    },
    [align],
  );

  const emit = useCallback((settled: boolean) => {
    const b = box.current;
    if (!b || !onViewRef.current) return;
    const now = performance.now();
    if (!settled && now - lastEmit.current < 120) return;
    lastEmit.current = now;
    const { s, y } = t.current;
    onViewRef.current({
      scale: s,
      top: -y / s,
      bottom: (-y + b.clientHeight) / s,
      settled,
    });
  }, []);

  const apply = useCallback(
    (n: T, moving: boolean) => {
      t.current = n;
      const c = inner.current;
      if (!c) return;
      c.style.transform = `translate3d(${n.x}px, ${n.y}px, 0) scale(${n.s})`;
      // A layer only while moving: afterwards the browser redraws it sharp at the new size.
      c.style.willChange = moving ? 'transform' : '';
      if (!moving) setZoomed(n.s > 1.01);
      emit(!moving);
    },
    [emit],
  );

  const stopAnim = () => cancelAnimationFrame(anim.current);

  /** Moves by (dx, dy); unzoomed, vertical movement past the ends scrolls the container. */
  const panBy = useCallback(
    (dx: number, dy: number, chain: boolean): boolean => {
      const cur = t.current;
      const next = clamp({ s: cur.s, x: cur.x + dx, y: cur.y + dy });
      apply(next, true);
      const used = next.y - cur.y;
      const left = dy - used;
      let moved = Math.abs(next.x - cur.x) > 0.1 || Math.abs(used) > 0.1;
      if (chain && cur.s <= 1.01 && Math.abs(left) > 0.1 && box.current) {
        const p = scrollParent(box.current);
        if (p) {
          const before = p.scrollTop;
          p.scrollTop -= left;
          moved ||= p.scrollTop !== before;
        }
      }
      return moved;
    },
    [apply, clamp],
  );

  const animateTo = useCallback(
    (target: T) => {
      stopAnim();
      const from = { ...t.current };
      const to = clamp(target);
      const start = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / 220);
        const e = 1 - Math.pow(1 - k, 3);
        const n = {
          s: from.s + (to.s - from.s) * e,
          x: from.x + (to.x - from.x) * e,
          y: from.y + (to.y - from.y) * e,
        };
        if (k < 1) {
          apply(n, true);
          anim.current = requestAnimationFrame(step);
        } else apply(to, false);
      };
      anim.current = requestAnimationFrame(step);
    },
    [apply, clamp],
  );

  /** Zooms to `s` keeping the point (px, py) in the box still. */
  const zoomAt = useCallback((s: number, px: number, py: number, from: T = t.current): T => {
    const k = s / from.s;
    return { s, x: px - (px - from.x) * k, y: py - (py - from.y) * k };
  }, []);

  // Re-fit when the box or the content changes size (pages arriving, rotation).
  useEffect(() => {
    const b = box.current;
    const c = inner.current;
    if (!b || !c) return;
    let width = b.clientWidth;
    const ro = new ResizeObserver(() => {
      if (b.clientWidth !== width) {
        width = b.clientWidth;
        apply(clamp({ s: 1, x: 0, y: 0 }), false);
      } else apply(clamp(t.current), false);
    });
    ro.observe(b);
    ro.observe(c);
    apply(clamp(t.current), false);
    return () => ro.disconnect();
  }, [apply, clamp]);

  // Gestures.
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const pts = new Map<number, { x: number; y: number; type: string }>();
    let pinch: { d: number; mx: number; my: number; from: T } | null = null;
    let last: { x: number; y: number } | null = null;
    let samples: { t: number; x: number; y: number }[] = [];
    let down: { x: number; y: number; t: number; moved: boolean } | null = null;
    let lastTap: { x: number; y: number; t: number } | null = null;

    const local = (e: { clientX: number; clientY: number }) => {
      const r = b.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const startPinch = () => {
      const [a, c] = [...pts.values()];
      pinch = {
        d: Math.hypot(a!.x - c!.x, a!.y - c!.y) || 1,
        mx: (a!.x + c!.x) / 2,
        my: (a!.y + c!.y) / 2,
        from: { ...t.current },
      };
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if ((e.target as Element | null)?.closest('button')) return;
      stopAnim();
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      const p = local(e);
      pts.set(e.pointerId, { ...p, type: e.pointerType });
      if (pts.size === 2) startPinch();
      else if (pts.size === 1) {
        last = p;
        samples = [{ t: e.timeStamp, ...p }];
        down = { ...p, t: e.timeStamp, moved: false };
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e);
      pts.set(e.pointerId, { ...p, type: e.pointerType });
      if (down && Math.hypot(p.x - down.x, p.y - down.y) > TAP_SLOP) down.moved = true;
      if (pts.size >= 2 && pinch) {
        const [a, c] = [...pts.values()];
        const d = Math.hypot(a!.x - c!.x, a!.y - c!.y);
        const mx = (a!.x + c!.x) / 2;
        const my = (a!.y + c!.y) / 2;
        const s = Math.min(MAX_SCALE, Math.max(1, (pinch.from.s * d) / pinch.d));
        const z = zoomAt(s, pinch.mx, pinch.my, pinch.from);
        apply(clamp({ s, x: z.x + (mx - pinch.mx), y: z.y + (my - pinch.my) }), true);
        if (down) down.moved = true;
      } else if (pts.size === 1 && last) {
        panBy(p.x - last.x, p.y - last.y, e.pointerType !== 'mouse');
        last = p;
        samples.push({ t: e.timeStamp, ...p });
        samples = samples.filter((s) => e.timeStamp - s.t < 100);
      }
    };

    const fling = (vx: number, vy: number, chain: boolean) => {
      let prev = performance.now();
      const step = (now: number) => {
        const dt = Math.min(32, now - prev);
        prev = now;
        vx *= Math.pow(0.995, dt);
        vy *= Math.pow(0.995, dt);
        const moved = panBy(vx * dt, vy * dt, chain);
        if (moved && Math.hypot(vx, vy) > 0.02) anim.current = requestAnimationFrame(step);
        else apply(t.current, false);
      };
      anim.current = requestAnimationFrame(step);
    };

    const tap = (p: { x: number; y: number }, at: number) => {
      if (
        lastTap &&
        at - lastTap.t < DOUBLE_MS &&
        Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30
      ) {
        lastTap = null;
        if (t.current.s > 1.01) animateTo(zoomAt(1, p.x, p.y));
        else animateTo(zoomAt(2.5, p.x, p.y));
      } else lastTap = { ...p, t: at };
    };

    const onUp = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      const type = pts.get(e.pointerId)!.type;
      pts.delete(e.pointerId);
      if (pts.size === 1) {
        // One finger lifted from a pinch: carry on panning from the other without a jump.
        pinch = null;
        last = [...pts.values()][0]!;
        samples = [];
        return;
      }
      if (pts.size > 0) {
        if (pts.size >= 2) startPinch();
        return;
      }
      pinch = null;
      const p = local(e);
      if (down && !down.moved && e.timeStamp - down.t < TAP_MS && e.type === 'pointerup') {
        down = null;
        apply(clamp(t.current), false);
        tap(p, e.timeStamp);
        return;
      }
      down = null;
      const first = samples[0];
      const end = samples[samples.length - 1];
      if (first && end && end.t - first.t > 0 && e.type === 'pointerup') {
        const dt = end.t - first.t;
        fling((end.x - first.x) / dt, (end.y - first.y) / dt, type !== 'mouse');
      } else apply(clamp(t.current), false);
    };

    const onWheel = (e: WheelEvent) => {
      const p = local(e);
      if (e.ctrlKey) {
        // Trackpad pinch (and Ctrl + wheel) on a computer.
        e.preventDefault();
        stopAnim();
        const s = Math.min(MAX_SCALE, Math.max(1, t.current.s * Math.exp(-e.deltaY * 0.01)));
        apply(clamp(zoomAt(s, p.x, p.y)), false);
        return;
      }
      const cur = t.current;
      const next = clamp({ s: cur.s, x: cur.x - e.deltaX, y: cur.y - e.deltaY });
      if (Math.abs(next.x - cur.x) > 0.1 || Math.abs(next.y - cur.y) > 0.1) {
        e.preventDefault();
        apply(next, false);
      }
      // Otherwise the page (or sheet) scrolls as usual.
    };

    // iOS: no native scrolling or page zoom from touches that start here.
    const block = (e: Event) => e.preventDefault();

    b.addEventListener('pointerdown', onDown);
    b.addEventListener('pointermove', onMove);
    b.addEventListener('pointerup', onUp);
    b.addEventListener('pointercancel', onUp);
    b.addEventListener('wheel', onWheel, { passive: false });
    b.addEventListener('touchmove', block, { passive: false });
    b.addEventListener('gesturestart', block);
    b.addEventListener('gesturechange', block);
    return () => {
      stopAnim();
      b.removeEventListener('pointerdown', onDown);
      b.removeEventListener('pointermove', onMove);
      b.removeEventListener('pointerup', onUp);
      b.removeEventListener('pointercancel', onUp);
      b.removeEventListener('wheel', onWheel);
      b.removeEventListener('touchmove', block);
      b.removeEventListener('gesturestart', block);
      b.removeEventListener('gesturechange', block);
    };
  }, [animateTo, apply, clamp, panBy, zoomAt]);

  return (
    <div
      ref={box}
      data-zoombox=""
      data-no-tab-swipe=""
      style={style}
      className={cx(
        'relative cursor-grab touch-none overflow-hidden overscroll-contain select-none [-webkit-touch-callout:none]',
        className,
      )}
    >
      <div ref={inner} className="w-full origin-top-left">
        {children}
      </div>
      {zoomed && (
        <button
          type="button"
          onClick={() => {
            const b = box.current;
            if (b) animateTo(zoomAt(1, b.clientWidth / 2, b.clientHeight / 2));
          }}
          className="absolute right-3 bottom-3 rounded-full bg-ink/80 px-3 py-1.5 text-xs font-medium text-bg shadow"
        >
          Fit
        </button>
      )}
    </div>
  );
}
