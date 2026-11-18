import { describe, expect, it } from 'vitest';
import { formatBps, formatDate, formatMoney, parseMoneyToCents, parsePercentToBps, todayIn } from './format';
import { computeTotals, lineTotalCents, MAX_MONEY_CENTS, MAX_QUANTITY } from './pricing';

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

  it('accepts the database limit and rejects unsafe or oversized input', () => {
    expect(parseMoneyToCents('21474836.47')).toBe(MAX_MONEY_CENTS);
    for (const input of ['21474836.48', '9007199254740993', '9'.repeat(310), 'Infinity', 'NaN']) {
      expect(parseMoneyToCents(input)).toBeNull();
    }
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

  it('rejects invalid quantities and non-finite amounts without throwing', () => {
    for (const quantity of [0, 1.5, MAX_QUANTITY + 1, Infinity, NaN]) expect(lineTotalCents(quantity, 100, 0)).toBeNull();
    for (const price of [Infinity, NaN, MAX_MONEY_CENTS + 1, -1]) expect(lineTotalCents(1, price, 0)).toBeNull();
    expect(lineTotalCents(1, 100, 10_001)).toBeNull();
    expect(computeTotals([Infinity], 0)).toBeNull();
  });

  it('checks discounted line totals, subtotal and tax against the storage limit', () => {
    expect(lineTotalCents(MAX_QUANTITY, 3000, 0)).toBeNull();
    expect(lineTotalCents(MAX_QUANTITY, 3000, 5000)).toBe(1_500_000_000);
    expect(lineTotalCents(1, MAX_MONEY_CENTS, 0)).toBe(MAX_MONEY_CENTS);
    expect(computeTotals([MAX_MONEY_CENTS], 0)?.totalCents).toBe(MAX_MONEY_CENTS);
    expect(computeTotals([1_500_000_000, 1_500_000_000], 0)).toBeNull();
    expect(computeTotals([2_000_000_000], 1000)).toBeNull();
    expect(computeTotals([1], 10_001)).toBeNull();
  });
});

describe('todayIn', () => {
  it("returns the calendar date in the organization's time zone", () => {
    const instant = new Date('2026-03-01T02:30:00Z');
    expect(todayIn('UTC', instant)).toBe('2026-03-01');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-02-28');
    expect(todayIn('Asia/Shanghai', instant)).toBe('2026-03-01');
  });
});
