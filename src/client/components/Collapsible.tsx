import { useId, useState, type ReactNode } from 'react';
import { load, save } from '../lib/storage';
import { Icon } from './Icon';
import { cx } from './ui';

/**
 * A section that opens and shuts: the whole header row toggles it, the chevron turns (down when
 * shut, up when open) and the content slides. The open state is remembered on this device.
 */
export function Collapsible({
  id,
  summary,
  children,
  defaultOpen = false,
  className,
  headerClassName,
}: {
  /** Names the remembered state; unique across the app. */
  id: string;
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  headerClassName?: string;
}) {
  const key = `open:${id}`;
  const [open, setOpen] = useState(() => load(key, defaultOpen));
  const bodyId = useId();
  const toggle = () => {
    setOpen(!open);
    save(key, !open);
  };
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
        className={cx('flex w-full items-center gap-2 py-1.5 text-left', headerClassName)}
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <Icon
          name="chevDown"
          size={16}
          className={cx('text-faint transition-transform duration-200', open && 'rotate-180')}
        />
      </button>
      <div
        id={bodyId}
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
