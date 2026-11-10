import { describe, expect, it } from 'vitest';
import {
  amountInSource,
  centsToDecimal,
  dateProblem,
  formatCents,
  moneyInText,
  parseDate,
  parseMoney,
  sumCents,
} from '../../src/shared/logic';

describe('parseMoney', () => {
  it.each([
    ['$1,234.56', 123456],
    ['125.00', 12500],
    ['125', 12500],
    ['125.5', 12550],
    ['.99', 99],
    ['$ 45.00 USD', 4500],
    ['(12.00)', -1200],
    ['-12.00', -1200],
    ['12.00-', -1200],
    ['12,50', 1250],
    ['1.234,56', 123456],
    [42.1, 4210],
  ])('%s → %s', (input, cents) => expect(parseMoney(input)).toBe(cents));

  it.each(['', 'abc', '1.2.3', '12.345', '$', 'N/A', '12 34'])('rejects %s', (input) =>
    expect(parseMoney(input)).toBeNull(),
  );

  it('avoids float drift', () => {
    expect(parseMoney('0.29')).toBe(29);
    expect(sumCents([10, 20, null, 3])).toBe(33);
    expect(centsToDecimal(12345)).toBe('123.45');
    expect(centsToDecimal(-5)).toBe('-0.05');
    expect(formatCents(123456)).toBe('$1,234.56');
  });
});

describe('amount in source', () => {
  const text = `Patient: Sam Example  Visit 03/04/2024  Copay $45   Total paid: 1,234.56
  CPT 97112 NEUROMUSCULAR REEDUCATION 97.12`;
  it('finds printed amounts', () => {
    expect(amountInSource(123456, text)).toBe(true);
    expect(amountInSource(4500, text)).toBe(true);
    expect(amountInSource(9712, text)).toBe(true);
  });
  it('catches numbers the document does not contain', () => {
    expect(amountInSource(12500, text)).toBe(false);
    // A CPT code is not an amount.
    expect(moneyInText(text).has(9711200)).toBe(false);
  });
});

describe('parseDate', () => {
  it.each([
    ['2024-03-05', '2024-03-05'],
    ['2024-03-05T10:00:00Z', '2024-03-05'],
    ['03/05/2024', '2024-03-05'],
    ['3/5/24', '2024-03-05'],
    ['Mar 5, 2024', '2024-03-05'],
    ['March 5th 2024', '2024-03-05'],
    ['Sept 30, 2023', '2023-09-30'],
    ['5 March 2024', '2024-03-05'],
  ])('%s → %s', (input, iso) => expect(parseDate(input)).toBe(iso));

  it.each(['2024-02-30', '13/01/2024', 'yesterday', '', '2024'])('rejects %s', (s) =>
    expect(parseDate(s)).toBeNull(),
  );

  it('flags implausible dates', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    expect(dateProblem('2026-06-02', now)).toBeNull(); // a day of slack
    expect(dateProblem('2026-06-10', now)).toBe('date_in_future');
    expect(dateProblem('1999-12-31', now)).toBe('date_too_old');
    expect(dateProblem('2020-01-01', now)).toBeNull();
  });
});
