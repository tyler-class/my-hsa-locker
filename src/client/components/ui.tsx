import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
} from 'react';
import { useNavigate } from 'react-router';
import { Icon, type IconName } from './Icon';
import { SwipeRow } from './SwipeRow';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

// ---------- buttons ----------
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName };

export function PrimaryButton({
  icon,
  className,
  children,
  tone,
  ...p
}: BtnProps & { tone?: 'danger' | 'secondary' }) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2.5 text-[15px] font-medium disabled:opacity-50',
        tone === 'danger'
          ? 'bg-danger text-white'
          : tone === 'secondary'
            ? 'bg-chip text-ink'
            : 'bg-accent text-accent-ink',
        className,
      )}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}

export function GhostButton({ icon, className, children, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center gap-1.5 px-3 py-2.5 text-[15px] text-soft disabled:opacity-50',
        className,
      )}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}

export function DangerButton({ icon = 'trash', className, children, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center gap-1.5 py-2.5 text-[15px] text-danger disabled:opacity-50',
        className,
      )}
    >
      <Icon name={icon} size={16} />
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  className,
  ...p
}: BtnProps & { icon: IconName; label: string }) {
  return (
    <button
      {...p}
      aria-label={label}
      title={label}
      className={cx('grid h-9 w-9 place-items-center rounded-full text-soft', className)}
    >
      <Icon name={icon} />
    </button>
  );
}

// ---------- form pieces ----------
/** A form row: leading icon, then label + control. */
export function FieldRow({
  icon,
  label,
  htmlFor,
  children,
  hint,
}: {
  icon?: IconName;
  label?: string;
  htmlFor?: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3.5 border-b border-line py-3">
      {icon && <Icon name={icon} className="mt-0.5 text-faint" />}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {label && (
          <label htmlFor={htmlFor} className="text-xs text-soft">
            {label}
          </label>
        )}
        {children}
        {hint && <span className="text-xs text-faint">{hint}</span>}
      </div>
    </div>
  );
}

/** A text field: a softly filled, outlined box so it reads as a place to type. */
export function TextInput(p: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={cx(
        'w-full rounded-xl border border-line bg-surface px-3 py-2 text-base text-ink transition-colors placeholder:text-faint focus:border-accent focus:outline-none',
        p.className,
      )}
    />
  );
}

export function Pick({
  on,
  onClick,
  children,
  className,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border-2 px-2.5 py-[3px] text-sm transition-colors',
        on ? 'border-accent bg-accent-tint/40 font-medium text-ink' : 'border-line text-soft',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Switch({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx(
        'relative h-6 w-10 flex-none rounded-full transition-colors disabled:opacity-40',
        on ? 'bg-accent' : 'bg-track',
      )}
    >
      <span
        className={cx(
          'absolute top-[3px] left-[3px] h-[18px] w-[18px] rounded-full bg-white shadow transition-transform',
          on && 'translate-x-4',
        )}
      />
    </button>
  );
}

export function Stepper({
  value,
  onChange,
  min = 0,
}: {
  value: number | null;
  onChange: (v: number) => void;
  min?: number;
}) {
  const v = value ?? 0;
  return (
    <span className="inline-flex items-center gap-3">
      <button
        type="button"
        aria-label="Less"
        onClick={() => onChange(Math.max(min, v - 1))}
        className="grid h-8 w-8 place-items-center rounded-full border border-line text-soft"
      >
        −
      </button>
      <input
        aria-label="Quantity"
        inputMode="numeric"
        value={value ?? ''}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value === '' || Number.isFinite(n))
            onChange(e.target.value === '' ? 0 : Math.max(min, n));
        }}
        className="w-10 bg-transparent text-center font-mono text-base tnum focus:outline-none"
      />
      <button
        type="button"
        aria-label="More"
        onClick={() => onChange(v + 1)}
        className="grid h-8 w-8 place-items-center rounded-full border border-line text-soft"
      >
        +
      </button>
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex min-w-0 gap-0.5 rounded-full bg-chip p-[3px]"
    >
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cx(
            'flex-1 rounded-full px-0.5 py-1.5 text-[13px] whitespace-nowrap',
            value === v
              ? 'bg-seg font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]'
              : 'text-soft',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A person's marker: their emoji, or their initial in a small circle. */
export function PersonDot({
  person,
  size = 15,
}: {
  person?: { name: string; emoji: string | null } | null;
  size?: number;
}) {
  if (person?.emoji) {
    return (
      <span
        aria-hidden="true"
        className="inline-block flex-none leading-none"
        style={{ fontSize: size }}
      >
        {person.emoji}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-grid flex-none place-items-center rounded-full bg-chip font-semibold text-soft"
      style={{ width: size + 3, height: size + 3, fontSize: Math.round(size * 0.6) }}
    >
      {person?.name.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {children}
    </p>
  );
}

// ---------- sheet ----------
export function Sheet(props: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** A line under the title, e.g. a version. */
  sub?: ReactNode;
  /** Show a close (✕) button, for sheets without a footer. */
  closeButton?: boolean;
  /** A large two-pane window on desktop and full height on phones. */
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // Mounting fresh on each open resets drag and expand state.
  return props.open ? <SheetBody {...props} /> : null;
}

function SheetBody({
  onClose,
  title,
  sub,
  closeButton,
  wide,
  children,
  footer,
}: {
  onClose: () => void;
  title: ReactNode;
  sub?: ReactNode;
  closeButton?: boolean;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; t: number } | null>(null);
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Drag the handle/title: down to dismiss, up to expand to full height.
  const dragHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (window.matchMedia('(min-width: 640px)').matches) return;
      drag.current = { y: e.clientY, t: performance.now() };
      setDragging(true);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!drag.current) return;
      const d = e.clientY - drag.current.y;
      // Downward follows the finger; upward resists (rubber band).
      setDy(d > 0 ? d : -Math.sqrt(-d) * 4);
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (!drag.current) return;
      const d = e.clientY - drag.current.y;
      const speed = d / Math.max(1, performance.now() - drag.current.t); // px per ms
      drag.current = null;
      setDragging(false);
      setDy(0);
      if (d > 120 || speed > 0.6) {
        if (expanded && d < 260 && speed <= 0.6) setExpanded(false);
        else onClose();
      } else if (d < -40) {
        setExpanded(true);
      }
    },
    onPointerCancel: () => {
      drag.current = null;
      setDragging(false);
      setDy(0);
    },
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center sm:p-6">
      <div
        className="absolute inset-0 bg-[var(--scrim)]"
        style={{ opacity: dy > 0 ? Math.max(0.2, 1 - dy / 500) : 1 }}
        onClick={onClose}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          'sheet-in relative flex max-h-[92dvh] w-full flex-col rounded-t-[18px] bg-surface pb-safe sm:rounded-[18px] sm:shadow-xl',
          wide ? 'h-[92dvh] max-w-6xl md:h-[88dvh]' : 'max-w-xl',
          expanded && 'h-[92dvh]',
        )}
        style={{
          transform: dy ? `translateY(${dy}px)` : undefined,
          transition: dragging ? 'none' : 'transform .22s ease, height .22s ease',
        }}
      >
        <div className="flex-none cursor-grab touch-none select-none" {...dragHandlers}>
          <div className="mx-auto mt-2.5 mb-2 h-1 w-9 rounded-full bg-line" />
          <h2 id={titleId} className="px-5 pb-1.5 text-lg font-semibold tracking-tight">
            {title}
          </h2>
          {sub && <p className="-mt-1 px-5 pb-1.5 text-sm text-soft">{sub}</p>}
        </div>
        {closeButton && (
          <IconButton
            icon="x"
            label="Close"
            onClick={onClose}
            className="absolute top-4 right-4 h-9 w-9 rounded-full bg-chip"
          />
        )}
        <div
          className={cx(
            'min-h-0 flex-1 px-5 pb-2',
            wide ? 'flex flex-col overflow-hidden' : 'overflow-y-auto overscroll-contain',
          )}
        >
          {children}
        </div>
        {footer && (
          <div className="flex flex-none items-center justify-between gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** A sheet of tappable actions (the trip menu). */
export function ActionList({
  actions,
}: {
  actions: {
    icon: IconName;
    label: string;
    onClick: () => void;
    danger?: boolean;
    hidden?: boolean;
  }[];
}) {
  return (
    <div className="flex flex-col">
      {actions
        .filter((a) => !a.hidden)
        .map((a) => (
          <button
            key={a.label}
            onClick={a.onClick}
            className={cx(
              'flex items-center gap-3.5 border-b border-line py-3.5 text-left text-base',
              a.danger ? 'text-danger' : 'text-ink',
            )}
          >
            <Icon name={a.icon} className={a.danger ? '' : 'text-soft'} />
            {a.label}
          </button>
        ))}
    </div>
  );
}

// ---------- page chrome ----------
export function PageHeader({
  title,
  back,
  action,
  sub,
  icon,
}: {
  title: ReactNode;
  /** The tab's icon, shown before the title on top-level pages. */
  icon?: IconName;
  back?: string | true;
  action?: ReactNode;
  sub?: ReactNode;
}) {
  const nav = useNavigate();
  return (
    <header className="flex flex-col gap-1.5 px-5 pt-4 pb-2">
      {back && (
        <button
          onClick={() => (back === true ? nav(-1) : nav(back))}
          className="-ml-1.5 flex items-center gap-0.5 self-start py-1 text-[15px] text-soft"
        >
          <Icon name="back" size={18} /> Back
        </button>
      )}
      <div className="flex items-center justify-between gap-3">
        <h1 className="flex min-w-0 items-center gap-2.5 text-[28px] leading-tight font-semibold tracking-[-0.025em] text-balance">
          {icon && <Icon name={icon} size={26} className="text-accent" />}
          {title}
        </h1>
        {action}
      </div>
      {sub && <div className="text-sm text-soft">{sub}</div>}
    </header>
  );
}

/**
 * An "i" button with more detail in a popover: shown while a mouse hovers it, or kept open
 * by a tap or click until you tap elsewhere or press Escape.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  // Where the popover starts, relative to the icon, so it stays on screen wherever the icon is.
  const [offset, setOffset] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(352, window.innerWidth - 40);
    const left = Math.max(16, Math.min(r.right - w, window.innerWidth - 16 - w));
    setOffset(left - r.left);
  };
  const id = useId();
  const open = pinned || hover;
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setPinned(false);
      setHover(false);
    };
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div
      ref={ref}
      className="relative flex"
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        place();
        setHover(true);
      }}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          place();
          setPinned((p) => !p);
        }}
        className={cx(
          'grid h-6 w-6 place-items-center rounded-full transition-colors',
          open ? 'text-accent' : 'text-soft hover:text-ink',
        )}
      >
        <Icon name="info" size={16} />
      </button>
      {open && (
        // The top padding bridges the gap, so a mouse can move from the icon into it.
        <div id={id} role="note" className="absolute top-full z-40 pt-2" style={{ left: offset }}>
          <div className="max-h-[55vh] w-[min(22rem,calc(100vw-2.5rem))] overflow-y-auto rounded-2xl border border-line bg-surface p-4 text-left text-sm font-normal text-soft shadow-xl">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

/** A section header pill: tinted, bold, with an optional accent icon and trailing count or action. */
export function SectionLabel({
  children,
  icon,
  trailing,
  sticky,
}: {
  children: ReactNode;
  icon?: IconName;
  trailing?: ReactNode;
  sticky?: boolean;
}) {
  return (
    <div
      className={cx(
        'px-4 pt-6 pb-1',
        sticky &&
          'sticky top-[calc(env(safe-area-inset-top,0px)+48px)] z-10 bg-bg md:top-[env(safe-area-inset-top,0px)]',
      )}
    >
      <div className="flex items-center gap-2 rounded-full bg-accent-tint px-4 py-2">
        {icon && <Icon name={icon} size={15} className="text-accent" />}
        <span className="flex-1 text-[13px] font-semibold text-ink">{children}</span>
        {trailing}
      </div>
    </div>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-8 py-16 text-center">
      <p className="text-base font-medium">{title}</p>
      {children && <p className="max-w-[34ch] text-sm text-soft">{children}</p>}
      {action}
    </div>
  );
}

/** A full-width row link in a list. */
export function ListRow({
  onClick,
  children,
  trailing,
  swipeDelete,
}: {
  onClick: () => void;
  children: ReactNode;
  trailing?: ReactNode;
  /** Enables swipe-left-to-reveal Delete. */
  swipeDelete?: { id: string; onDelete: () => void };
}) {
  const row = (
    <button
      onClick={onClick}
      className={cx(
        'flex items-center gap-3.5 py-3.5 text-left',
        swipeDelete ? 'w-full' : 'mx-6 w-[calc(100%-3rem)] border-b border-line',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</span>
      {trailing ?? <Icon name="chevRight" className="text-faint" />}
    </button>
  );
  if (!swipeDelete) return row;
  return (
    <SwipeRow
      id={swipeDelete.id}
      onDelete={swipeDelete.onDelete}
      className="mx-6 border-b border-line"
    >
      {row}
    </SwipeRow>
  );
}

/** True on wide screens (tablet and desktop). */
export function useIsWide(): boolean {
  const query = '(min-width: 640px)';
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/**
 * A menu opened from a button: a dropdown under the button on wide screens,
 * a bottom sheet on phones.
 */
export function Menu({
  open,
  onClose,
  anchor,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchor: DOMRect | null;
  title: ReactNode;
  children: ReactNode;
}) {
  const wide = useIsWide();
  useEffect(() => {
    if (!open || !wide) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [open, wide, onClose]);
  if (!open) return null;
  if (!wide || !anchor) {
    return (
      <Sheet open={open} onClose={onClose} title={title}>
        {children}
      </Sheet>
    );
  }
  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        role="menu"
        className="absolute w-72 rounded-xl border border-line bg-surface px-4 py-1 shadow-xl"
        // Opens below the button, or above it near the bottom of the screen; aligns to the
        // button's right edge, or its left edge when it sits near the left.
        style={{
          ...(window.innerHeight - anchor.bottom < 320
            ? { bottom: window.innerHeight - anchor.top + 6 }
            : { top: anchor.bottom + 6 }),
          ...(anchor.right < 300
            ? { left: Math.max(8, anchor.left) }
            : { right: Math.max(8, window.innerWidth - anchor.right) }),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="[&>div>button:last-child]:border-b-0">{children}</div>
      </div>
    </div>
  );
}

/** A subheading inside a section: plain bold text, aligned with the section's content. */
export function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="px-6 pt-5 pb-2 text-sm font-semibold text-ink">{children}</h3>;
}

type SlideToggleProps<T extends string> = {
  options: [T, ReactNode][];
  label: string;
  className?: string;
} & (
  | { value: T | null | undefined; onChange: (v: T) => void; allowClear?: false }
  /** Tapping the chosen option again clears it; no thumb shows while nothing is chosen. */
  | { value: T | null | undefined; onChange: (v: T | null) => void; allowClear: true }
);

/**
 * A pill switch with a sliding thumb. Options share the width equally; one whose label
 * needs more room grows to fit it, and when they can't all fit the switch scrolls sideways.
 * The thumb is measured from the chosen option, so it always sits right behind it.
 */
export function SlideToggle<T extends string>(props: SlideToggleProps<T>) {
  const { options, label, className } = props;
  const index = options.findIndex(([v]) => v === props.value);
  const n = options.length;
  const track = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => {
      const b = index >= 0 ? el.querySelectorAll<HTMLElement>(':scope > button')[index] : undefined;
      setThumb((t) =>
        !b
          ? null
          : t && t.left === b.offsetLeft && t.width === b.offsetWidth
            ? t
            : { left: b.offsetLeft, width: b.offsetWidth },
      );
      // Keep the chosen option in view when the switch scrolls.
      if (b && el.scrollWidth > el.clientWidth) {
        if (b.offsetLeft < el.scrollLeft) el.scrollLeft = b.offsetLeft - 4;
        else if (b.offsetLeft + b.offsetWidth > el.scrollLeft + el.clientWidth)
          el.scrollLeft = b.offsetLeft + b.offsetWidth - el.clientWidth + 4;
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of el.querySelectorAll(':scope > button')) ro.observe(c);
    return () => ro.disconnect();
  }, [index, n]);
  const pick = (v: T) => {
    if (props.allowClear) props.onChange(v === props.value ? null : v);
    else props.onChange(v);
  };
  return (
    <div
      ref={track}
      role="tablist"
      aria-label={label}
      className={cx(
        'no-scrollbar relative grid overflow-x-auto rounded-full bg-chip p-1',
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${n}, minmax(max-content, 1fr))` }}
    >
      {thumb && (
        <span
          aria-hidden="true"
          className="absolute inset-y-1 left-0 rounded-full bg-surface shadow-[0_1px_3px_rgba(0,0,0,.12)] transition-[transform,width] duration-200 ease-out"
          style={{ width: thumb.width, transform: `translateX(${thumb.left}px)` }}
        />
      )}
      {options.map(([v, text], i) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={i === index}
          onClick={() => pick(v)}
          className={cx(
            'relative z-10 inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors',
            i === index ? 'font-semibold text-accent' : 'text-soft',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A small rounded info pill (icon + text). */
export function InfoPill({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-[13px] text-soft">
      <Icon name={icon} size={13} className="text-faint" />
      {children}
    </span>
  );
}
