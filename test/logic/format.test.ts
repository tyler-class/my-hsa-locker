import { describe, expect, it } from 'vitest';
import { ago } from '../../src/client/lib/format';

describe('relative times', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  const before = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it('is compact, with no space', () => {
    expect(ago(before(20), now)).toBe('just now');
    expect(ago(before(5 * 60), now)).toBe('5m ago');
    expect(ago(before(3 * 3600 + 120), now)).toBe('3h ago');
    expect(ago(before(2 * 86400 + 60), now)).toBe('2d ago');
  });

  it('gives the date after a week, and nothing for no time', () => {
    expect(ago(before(9 * 86400), now)).toMatch(/^Jun 6/);
    expect(ago(null, now)).toBe('');
  });
});
