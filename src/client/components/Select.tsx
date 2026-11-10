// A styled dropdown in place of the browser's <select>. The list opens in a layer above the page
// (so scrolling rows like the Ledger filters can't clip it) and works from the keyboard:
// arrows to move, Enter to choose, Escape to close.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { cx } from './ui';

export interface SelectProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: readonly (readonly [T, string])[];
  /** Accessible name (the visible label lives elsewhere, or there is none). */
  label: string;
  /** pill: a compact filter chip. field: a full-width form control. */
  variant?: 'pill' | 'field';
  className?: string;
  disabled?: boolean;
  /** Shown when value matches no option. */
  placeholder?: string;
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  variant = 'field',
  className,
  disabled,
  placeholder = 'Choose…',
}: SelectProps<T>) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    minWidth: number;
    up: boolean;
  } | null>(null);
  const current = options.find(([v]) => v === value);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const up = below < 240 && r.top > below;
    setPos({
      top: up ? r.top - 6 : r.bottom + 6,
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 200) - 8)),
      minWidth: r.width,
      up,
    });
  };

  const show = () => {
    if (disabled) return;
    setActive(
      Math.max(
        0,
        options.findIndex(([v]) => v === value),
      ),
    );
    place();
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  const choose = (i: number) => {
    const o = options[i];
    if (o) onChange(o[0]);
    close();
  };

  useLayoutEffect(() => {
    if (!open) return;
    list.current?.focus();
    list.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    const onMove = (e: Event) => {
      if (list.current?.contains(e.target as Node)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  const onButtonKey = (e: KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      show();
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') setActive((a) => Math.min(options.length - 1, a + 1));
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(options.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') close(false);
    else {
      // Type a letter to jump to the next option starting with it.
      if (e.key.length === 1) {
        const k = e.key.toLowerCase();
        const n = options.length;
        for (let j = 1; j <= n; j++) {
          const i = (active + j) % n;
          if (options[i]![1].toLowerCase().startsWith(k)) {
            setActive(i);
            break;
          }
        }
      }
      return;
    }
    e.preventDefault();
  };

  useEffect(() => {
    if (open)
      list.current
        ?.querySelector<HTMLElement>(`[data-i="${active}"]`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={`${label}: ${current?.[1] ?? placeholder}`}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onButtonKey}
        className={cx(
          'inline-flex min-w-0 items-center justify-between gap-2.5 border text-left text-ink transition-colors disabled:opacity-50',
          variant === 'pill'
            ? 'flex-none rounded-full py-1.5 pr-3 pl-3.5 text-sm whitespace-nowrap'
            : 'w-full rounded-xl px-3 py-2 text-base',
          open ? 'border-accent' : 'border-line',
          'bg-surface',
          className,
        )}
      >
        <span className={cx('min-w-0 truncate', !current && 'text-faint')}>
          {current?.[1] ?? placeholder}
        </span>
        <Icon
          name="chevDown"
          size={variant === 'pill' ? 14 : 16}
          className={cx('text-faint transition-transform', open && 'rotate-180')}
        />
      </button>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            aria-activedescendant={`${id}-o${active}`}
            onKeyDown={onListKey}
            className="fixed z-50 max-h-72 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-1 shadow-xl focus:outline-none"
            style={{
              left: pos.left,
              minWidth: Math.max(pos.minWidth, 180),
              maxWidth: 'calc(100vw - 16px)',
              ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
            }}
          >
            {options.map(([v, text], i) => {
              const selected = v === value;
              return (
                <li
                  key={v}
                  id={`${id}-o${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={selected}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={cx(
                    'flex cursor-pointer items-center gap-2 rounded-lg py-2 pr-3 pl-2 text-[15px]',
                    i === active ? 'bg-chip' : '',
                    selected ? 'font-medium text-ink' : 'text-soft',
                  )}
                >
                  <Icon
                    name="check"
                    size={15}
                    className={cx('flex-none', selected ? 'text-accent' : 'invisible')}
                  />
                  <span className="min-w-0 truncate">{text}</span>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </>
  );
}
