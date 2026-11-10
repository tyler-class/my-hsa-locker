import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void; icon?: IconName };
}

const Ctx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});

export function useToast() {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((t: Omit<Toast, 'id'>) => {
    clearTimeout(timer.current);
    const next = { ...t, id: Date.now() };
    setToast(next);
    timer.current = setTimeout(() => setToast((cur) => (cur?.id === next.id ? null : cur)), 5000);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-clear)+12px)] md:bottom-6 md:left-60 z-50 flex justify-center px-4"
      >
        {toast && (
          <div className="pointer-events-auto flex items-center gap-4 rounded-full bg-ink px-4 py-3 text-sm text-bg shadow-lg">
            <span>{toast.text}</span>
            {toast.action && (
              <button
                className="inline-flex items-center gap-1 font-medium"
                onClick={() => {
                  toast.action!.run();
                  setToast(null);
                }}
              >
                <Icon name={toast.action.icon ?? 'undo'} size={15} />
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
