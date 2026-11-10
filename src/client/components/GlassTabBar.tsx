// Phones: the bottom tabs as a floating "Liquid Glass" capsule (after iOS 26). A lighter glass
// lens sits behind the current tab and springs to a new one. Press anywhere on the bar and drag
// sideways: the lens follows the finger, stretches with speed, and on release snaps to the
// nearest tab and opens it. Tapping a tab works as a plain link. A tab can carry a badge (Review's
// count), pinned to its icon's top right.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';

export type GlassTab = [to: string, label: string, icon: IconName];

/** Sideways movement before a press becomes a drag. */
const DRAG_START = 6;
/** How much the lens grows while held, and the most it stretches sideways with speed. */
const HELD_SCALE = 1.1;
const MAX_STRETCH = 0.15;
/** px/ms of finger speed to stretch per unit; a quick flick (~1.5 px/ms) reaches the max. */
const STRETCH_PER_SPEED = 0.1;

type Drag = {
  id: number;
  startX: number;
  /** Lens centre, in bar coordinates. */
  x: number;
  lastX: number;
  lastT: number;
  /** Smoothed finger speed, px/ms. */
  v: number;
  dragging: boolean;
  held: boolean;
  frame: number;
};

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function GlassTabBar({
  tabs,
  active,
  badges,
}: {
  tabs: GlassTab[];
  active: string;
  /** A badge per tab path, drawn at the icon's top right. */
  badges?: Partial<Record<string, ReactNode>>;
}) {
  const navigate = useNavigate();
  const bar = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  const placed = useRef(false);
  /** The tab under the lens mid-drag, coloured as the current one. */
  const [over, setOver] = useState<number | null>(null);
  const activeIndex = Math.max(
    0,
    tabs.findIndex(([to]) => to === active),
  );

  const links = useCallback(
    () => Array.from(bar.current?.querySelectorAll<HTMLElement>(':scope > a') ?? []),
    [],
  );

  /** Moves the lens. `mode` picks the motion: a spring to rest, or a close follow while dragging. */
  const place = useCallback(
    (centre: number, width: number, sx: number, sy: number, mode: 'spring' | 'follow' | 'jump') => {
      const el = lens.current;
      if (!el) return;
      el.dataset.motion = mode;
      el.style.width = `${width}px`;
      el.style.transform = `translateX(${centre - width / 2}px) scale(${sx}, ${sy})`;
    },
    [],
  );

  /** Puts the lens at rest behind tab `i`; `jump` skips the spring (first paint, resizes). */
  const rest = useCallback(
    (i: number, jump = false) => {
      const a = links()[i];
      if (a) place(a.offsetLeft + a.offsetWidth / 2, a.offsetWidth, 1, 1, jump ? 'jump' : 'spring');
    },
    [links, place],
  );

  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    if (!drag.current?.dragging) rest(activeIndex, !placed.current);
    placed.current = true;
    // Only a real size change re-places it (the observer also fires once on start).
    let width = el.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth === width || drag.current?.dragging) return;
      width = el.offsetWidth;
      rest(activeIndex, true);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeIndex, rest]);

  /** The tab whose centre is nearest `x`, in bar coordinates. */
  const nearest = (x: number) => {
    let best = 0;
    let dist = Infinity;
    links().forEach((a, i) => {
      const d = Math.abs(a.offsetLeft + a.offsetWidth / 2 - x);
      if (d < dist) [best, dist] = [i, d];
    });
    return best;
  };

  /** Draws the dragged lens each frame, letting the speed stretch relax when the finger stops. */
  const tick = () => {
    const d = drag.current;
    const a = links()[0];
    if (!d || !a) return;
    const motion = !reducedMotion();
    const stretch = motion ? Math.min(Math.abs(d.v) * STRETCH_PER_SPEED, MAX_STRETCH) : 0;
    const grow = motion && d.held ? HELD_SCALE : 1;
    place(d.x, a.offsetWidth, grow * (1 + stretch), grow * (1 - stretch / 3), 'follow');
    if (performance.now() - d.lastT > 32) d.v *= 0.82;
    d.frame = requestAnimationFrame(tick);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || e.button !== 0 || !bar.current) return;
    const left = bar.current.getBoundingClientRect().left;
    const x = e.clientX - left;
    const a = links()[activeIndex];
    // Pressing on the lens itself picks it up straight away.
    const onLens = !!a && x >= a.offsetLeft && x <= a.offsetLeft + a.offsetWidth;
    drag.current = {
      id: e.pointerId,
      startX: e.clientX,
      x: a ? a.offsetLeft + a.offsetWidth / 2 : x,
      lastX: e.clientX,
      lastT: performance.now(),
      v: 0,
      dragging: false,
      held: onLens,
      frame: 0,
    };
    if (onLens) drag.current.frame = requestAnimationFrame(tick);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = bar.current;
    if (!d || e.pointerId !== d.id || !el) return;
    if (!d.dragging) {
      if (Math.abs(e.clientX - d.startX) < DRAG_START) return;
      d.dragging = true;
      d.held = true;
      el.setPointerCapture(e.pointerId);
      if (!d.frame) d.frame = requestAnimationFrame(tick);
    }
    const all = links();
    const first = all[0];
    const last = all[all.length - 1];
    if (!first || !last) return;
    const min = first.offsetLeft + first.offsetWidth / 2;
    const max = last.offsetLeft + last.offsetWidth / 2;
    const raw = e.clientX - el.getBoundingClientRect().left;
    // Past the ends the lens gives a little, like a rubber band.
    d.x = raw < min ? min - (min - raw) * 0.2 : raw > max ? max + (raw - max) * 0.2 : raw;
    const now = performance.now();
    const dt = Math.max(now - d.lastT, 1);
    d.v = d.v * 0.6 + ((e.clientX - d.lastX) / dt) * 0.4;
    d.lastX = e.clientX;
    d.lastT = now;
    const i = nearest(d.x);
    setOver((o) => (o === i ? o : i));
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    setOver(null);
    if (!d.dragging) {
      // A tap: let the link handle it. If it was on the lens, settle it back.
      if (d.held) rest(activeIndex);
      return;
    }
    swallowClick.current = true;
    setTimeout(() => (swallowClick.current = false), 400);
    const i = cancelled ? activeIndex : nearest(d.x);
    rest(i);
    if (i !== activeIndex) navigate(tabs[i]![0]);
  };

  // A drag ends in a click on whichever tab it started from; that click must not navigate.
  const onClickCapture = (e: React.MouseEvent) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => () => cancelAnimationFrame(drag.current?.frame ?? 0), []);

  const lit = over ?? activeIndex;
  return (
    <nav className="glass-bar md:hidden" aria-label="Main" data-no-tab-swipe>
      <div
        ref={bar}
        className="relative grid h-full px-1"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onClickCapture={onClickCapture}
      >
        <span ref={lens} aria-hidden="true" className="glass-lens" />
        {tabs.map(([to, label, icon], i) => (
          <NavLink
            key={to}
            to={to}
            draggable={false}
            className={cx(
              'glass-tab relative z-10 flex flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium',
              i === lit ? 'text-accent' : 'text-glass-label',
            )}
            aria-current={active === to ? 'page' : undefined}
          >
            <span className="relative">
              <Icon name={icon} size={23} />
              {badges?.[to] && (
                <span className="absolute -top-1.5 left-[calc(100%-8px)]">{badges[to]}</span>
              )}
            </span>
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
