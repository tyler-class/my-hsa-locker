import { formatCents } from '@shared/logic';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mar 5, 2024" from YYYY-MM-DD. */
export function formatDate(d: string | null | undefined): string {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return '';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

/** "Mar 5" for this year, "Mar 5, 2024" otherwise. */
export function shortDate(d: string | null | undefined): string {
  const full = formatDate(d);
  if (!full) return '';
  return d!.slice(0, 4) === String(new Date().getFullYear()) ? full.replace(/, \d{4}$/, '') : full;
}

export function money(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '—' : formatCents(cents, navigator.language);
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 minutes ago", "Mar 5". */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return shortDate(iso.slice(0, 10));
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "$12.34" typed by a person → cents, or null. */
export function parseTypedMoney(s: string): number | null {
  const t = s.replace(/[$,\s]/g, '');
  if (!/^-?\d*(\.\d{0,2})?$/.test(t) || !/\d/.test(t)) return null;
  const [w = '0', f = ''] = t.replace('-', '').split('.');
  const c = Number(w || '0') * 100 + Number((f + '00').slice(0, 2));
  return t.startsWith('-') ? -c : c;
}

export function centsInput(c: number | null | undefined): string {
  return c === null || c === undefined ? '' : (c / 100).toFixed(2);
}
