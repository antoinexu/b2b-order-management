import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password';
import { hasPermission } from '../src/lib/permissions';
import { computeTotals, formatDocumentNumber, lineTotalCents } from '../src/lib/pricing';

describe('pricing', () => {
  it('computes line totals with discounts in basis points', () => {
    expect(lineTotalCents({ quantity: 10, unitPriceCents: 2450, discountBps: 0 })).toBe(24_500);
    expect(lineTotalCents({ quantity: 10, unitPriceCents: 2450, discountBps: 1000 })).toBe(22_050);
    expect(lineTotalCents({ quantity: 3, unitPriceCents: 333, discountBps: 0 })).toBe(999);
  });

  it('rounds half-cent results to the nearest cent', () => {
    // 1 * 999 * 0.95 = 949.05 -> 949
    expect(lineTotalCents({ quantity: 1, unitPriceCents: 999, discountBps: 500 })).toBe(949);
  });

  it('computes subtotal, tax and total', () => {
    expect(computeTotals([10_000, 5_000], 825)).toEqual({ subtotalCents: 15_000, taxCents: 1238, totalCents: 16_238 });
    expect(computeTotals([], 825)).toEqual({ subtotalCents: 0, taxCents: 0, totalCents: 0 });
  });

  it('formats document numbers', () => {
    expect(formatDocumentNumber('Q', 7)).toBe('Q-000007');
    expect(formatDocumentNumber('SO', 1234567)).toBe('SO-1234567');
  });
});

describe('permissions', () => {
  it('grants admins everything', () => {
    expect(hasPermission('admin', 'users:write')).toBe(true);
    expect(hasPermission('admin', 'orders:status')).toBe(true);
  });

  it('lets managers run operations but not manage users', () => {
    expect(hasPermission('manager', 'products:write')).toBe(true);
    expect(hasPermission('manager', 'orders:status')).toBe(true);
    expect(hasPermission('manager', 'users:read')).toBe(true);
    expect(hasPermission('manager', 'users:write')).toBe(false);
  });

  it('lets sales create quotes and orders but not change pricing or fulfilment', () => {
    expect(hasPermission('sales', 'quotes:write')).toBe(true);
    expect(hasPermission('sales', 'orders:write')).toBe(true);
    expect(hasPermission('sales', 'products:write')).toBe(false);
    expect(hasPermission('sales', 'orders:status')).toBe(false);
    expect(hasPermission('sales', 'customers:delete')).toBe(false);
  });

  it('keeps viewers read-only', () => {
    expect(hasPermission('viewer', 'orders:read')).toBe(true);
    expect(hasPermission('viewer', 'customers:write')).toBe(false);
    expect(hasPermission('viewer', 'users:read')).toBe(false);
  });
});

describe('password hashing', () => {
  it('verifies the correct password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('anything', 'malformed')).toBe(false);
  });
});
