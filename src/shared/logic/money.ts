// Money is integer cents everywhere. Parsing is strict so a misread number goes to review
// instead of quietly becoming a wrong total.

/**
 * Parses "$1,234.56", "1234.5", "(12.00)", "-12.00", "12,50 USD" style strings into cents.
 * Returns null for anything that isn't clearly one amount.
 */
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  // Currency marks and the spaces next to them go; a space between digits means two numbers.
  s = s
    .replace(/\b(USD|US\$|dollars?)\b/gi, '')
    .replace(/\s*\$\s*/g, '')
    .replace(/^-\s+/, '-')
    .trim();
  if (/\s/.test(s)) return null;
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    // Some statements print credits as "12.00-".
    negative = !negative;
    s = s.slice(0, -1);
  }
  s = s.replace(/^\$/, '');
  // 1,234.56 or 1234.56 or 1234 or .56
  if (/^(\d{1,3}(,\d{3})+|\d+)?(\.\d{1,2})?$/.test(s) && /\d/.test(s)) {
    const [whole = '0', frac = ''] = s.replace(/,/g, '').split('.');
    const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
    return negative ? -cents : cents;
  }
  // European style 1.234,56 or 12,50
  if (/^(\d{1,3}(\.\d{3})+|\d+),\d{2}$/.test(s)) {
    const [whole = '0', frac = '00'] = s.replace(/\./g, '').split(',');
    const cents = Number(whole) * 100 + Number(frac);
    return negative ? -cents : cents;
  }
  return null;
}

/** "$1,234.56" (or the locale's equivalent). */
export function formatCents(cents: number | null | undefined, locale?: string): string {
  if (cents === null || cents === undefined) return '';
  return new Intl.NumberFormat(locale ?? 'en-US', { style: 'currency', currency: 'USD' }).format(
    cents / 100,
  );
}

/** "1234.56", for CSV and file names. */
export function centsToDecimal(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function sumCents(values: (number | null | undefined)[]): number {
  let total = 0;
  for (const v of values) if (typeof v === 'number') total += v;
  return total;
}

/** Every money-looking number in a text, as cents. Used to check an amount really appears. */
export function moneyInText(text: string): Set<number> {
  const found = new Set<number>();
  // Numbers with exactly two decimals (with optional thousands separators), the shape amounts take
  // on receipts and EOBs. Whole numbers are too ambiguous (dates, codes) to count.
  const re = /(?<![\d.,])\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?![\d])/g;
  for (const m of text.matchAll(re)) {
    found.add(Number(m[1]!.replace(/,/g, '')) * 100 + Number(m[2]));
  }
  // "$45" with a dollar sign and no cents.
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?![\d.,])/g)) {
    found.add(Number(m[1]!.replace(/,/g, '')) * 100);
  }
  return found;
}

/** True when the amount (as cents) is printed somewhere in the text. */
export function amountInSource(cents: number, text: string): boolean {
  return moneyInText(text).has(Math.abs(cents));
}
