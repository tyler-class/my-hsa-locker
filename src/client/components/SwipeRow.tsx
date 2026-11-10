import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { DragActive } from '../lib/dragActive';
import { cx } from './ui';

const REVEAL = 88;
const OPEN_EVENT = 'hsa-locker:row-open';

/**
 * A list row you can swipe left (on touch screens) to reveal a Delete button.
 * Nothing is deleted until that button is tapped. Tapping an open row closes it.
 */
export function SwipeRow({
  id,
  onDelete,
  children,
  className,
  label = 'Delete',
  disabled,
  highlight,
}: {
  id: string;
  onDelete: () => void;
  children: ReactNode;
  className?: string;
  label?: string;
  /** Turns swiping off (e.g. while selecting rows). */
  disabled?: boolean;
  /** Tints the row (e.g. when selected). */
  highlight?: boolean;
}) {
  // Swiping is off while a row is being dragged into a new order.
  const listDrag = useContext(DragActive);
  const off = disabled || listDrag;
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);
  const start = useRef<{ x: number; y: number; swiping: boolean } | null>(null);
  const moved = useRef(false);

  // Only one row shows its Delete button at a time.
  useEffect(() => {
    const onOtherOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) setOpen(false);
    };
    window.addEventListener(OPEN_EVENT, onOtherOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOtherOpen);
  }, [id]);

  const base = open ? -REVEAL : 0;
  const offset = dragging ? Math.min(0, Math.max(-REVEAL - 32, base + dx)) : base;

  return (
    // data-swipe-row: its own sideways swipe, so swiping between tabs leaves it alone.
    <div data-swipe-row className={cx('relative overflow-hidden', className)}>
      {!off && (
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex items-center justify-center bg-danger text-sm font-medium text-white"
          style={{ width: REVEAL }}
          aria-hidden={!open}
          tabIndex={open ? 0 : -1}
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
        >
          {label}
        </button>
      )}
      <div
        className={cx('relative', highlight ? 'my-1 rounded-xl bg-accent-tint' : 'bg-bg')}
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : 'transform .18s ease',
          touchAction: 'pan-y',
        }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' || off) return;
          start.current = { x: e.clientX, y: e.clientY, swiping: false };
          moved.current = false;
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s || off) return;
          const ddx = e.clientX - s.x;
          const ddy = e.clientY - s.y;
          if (!s.swiping && Math.abs(ddx) > 10 && Math.abs(ddx) > Math.abs(ddy)) {
            s.swiping = true;
            setDragging(true);
          }
          if (s.swiping) {
            moved.current = true;
            setDx(ddx);
          }
        }}
        onPointerUp={() => {
          if (start.current?.swiping) {
            const reveal = base + dx < -REVEAL / 2;
            setOpen(reveal);
            if (reveal) window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
          }
          start.current = null;
          setDragging(false);
          setDx(0);
        }}
        onPointerCancel={() => {
          start.current = null;
          setDragging(false);
          setDx(0);
        }}
        // A swipe, or a tap on an open row, shouldn't also trigger the row's own action.
        onClickCapture={(e) => {
          if (moved.current || open) {
            e.preventDefault();
            e.stopPropagation();
            moved.current = false;
            if (open) setOpen(false);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
