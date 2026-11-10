// Light / Dark / System, remembered per device. index.html applies the saved choice
// before first paint; this keeps it in sync when it's changed in Settings.
import { useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'hsa-locker-theme';
/** The page background in each mode, for the phone's status bar. */
const COLORS = { light: '#f6f5f0', dark: '#181818' } as const;

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  // System: each theme-color meta goes back to its own media-based colour.
  document.querySelectorAll('meta[name=theme-color]').forEach((m) => {
    const sys = (m.getAttribute('media') ?? '').includes('dark') ? COLORS.dark : COLORS.light;
    m.setAttribute('content', t === 'system' ? sys : COLORS[t]);
  });
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const setTheme = (t: Theme) => {
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* Private mode: still applies for this visit. */
    }
    applyTheme(t);
    setThemeState(t);
  };
  return [theme, setTheme] as const;
}
