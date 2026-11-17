import { describe, expect, it } from 'vitest';
import { formatBps, formatDate, formatMoney, parseMoneyToCents, parsePercentToBps } from './format';
import { computeTotals, lineTotalCents } from './pricing';

describe('money parsing and formatting', () => {
  it.each([
    ['24.50', 2450], ['24.5', 2450], ['24', 2400], ['$1,234.56', 123456], ['0', 0], [' 7.05 ', 705],
  ])('parses %j to %i cents', (input, cents) => {
    expect(parseMoneyToCents(input)).toBe(cents);
  });

  it.each(['', 'abc', '1.234', '-5', '1.2.3', '.'])('rejects %j', (input) => {
    expect(parseMoneyToCents(input)).toBeNull();
  });

  it('avoids floating-point drift when parsing', () => {
    // 0.1 + 0.2 style errors: 19.99 * 100 = 1998.9999999999998 in floating point.
    expect(parseMoneyToCents('19.99')).toBe(1999);
  });

  it('formats cents as currency', () => {
    expect(formatMoney(123456)).toBe('$1,234.56');
    expect(formatMoney(5, 'EUR')).toBe('€0.05');
  });
});

describe('percent / basis points', () => {
  it('converts both ways', () => {
    expect(parsePercentToBps('8.25')).toBe(825);
    expect(parsePercentToBps('0')).toBe(0);
    expect(formatBps(825)).toBe('8.25%');
    expect(formatBps(1000)).toBe('10%');
  });

  it.each(['', '-1', '101', 'x'])('rejects %j', (input) => {
    expect(parsePercentToBps(input)).toBeNull();
  });
});

describe('dates', () => {
  it('renders plain dates without timezone shifts', () => {
    expect(formatDate('2026-12-31')).toBe('Dec 31, 2026');
    expect(formatDate(null)).toBe('—');
  });
});

describe('client price preview matches the server', () => {
  // Same cases as the backend's tests/unit.test.ts
  it('computes line totals and rounds half-cents', () => {
    expect(lineTotalCents(10, 2450, 1000)).toBe(22_050);
    expect(lineTotalCents(1, 999, 500)).toBe(949);
  });

  it('computes subtotal, tax and total', () => {
    expect(computeTotals([10_000, 5_000], 825)).toEqual({ subtotalCents: 15_000, taxCents: 1238, totalCents: 16_238 });
  });
});
