// Dates are plain YYYY-MM-DD strings. Parsing accepts the shapes receipts and EOBs use.

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

function valid(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function fullYear(y: number): number {
  if (y >= 100) return y;
  // Two-digit years: 00-69 → 2000s, 70-99 → 1900s.
  return y < 70 ? 2000 + y : 1900 + y;
}

/** Parses "2024-03-05", "03/05/2024", "3/5/24", "Mar 5, 2024", "5 March 2024". US order for slashes. */
export function parseDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim().replace(/\s+/g, ' ');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) return valid(fullYear(Number(m[3])), Number(m[1]), Number(m[2]));
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
    return mon ? valid(Number(m[3]), mon, Number(m[2])) : null;
  }
  m = /^(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase().slice(0, 3)];
    return mon ? valid(Number(m[3]), mon, Number(m[1])) : null;
  }
  return null;
}

export function isIsoDate(s: string | null | undefined): s is string {
  return (
    !!s &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    valid(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8)) !== null
  );
}

/** Today in UTC as YYYY-MM-DD (the Worker has no local time zone). */
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export const EARLIEST_PLAUSIBLE = '2000-01-01';

/** Why a date is implausible, or null if it's fine. A day of slack covers time zones. */
export function dateProblem(
  date: string,
  now = new Date(),
): 'date_in_future' | 'date_too_old' | null {
  if (date < EARLIEST_PLAUSIBLE) return 'date_too_old';
  const tomorrow = todayIso(new Date(now.getTime() + 86_400_000));
  if (date > tomorrow) return 'date_in_future';
  return null;
}

export function yearOf(date: string | null | undefined): number | null {
  return date && isIsoDate(date) ? Number(date.slice(0, 4)) : null;
}
