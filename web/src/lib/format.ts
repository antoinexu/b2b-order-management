const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** Formats integer cents as currency, e.g. 123456 -> "$1,234.56". */
export function formatMoney(cents: number, currency = 'USD'): string {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    moneyFormatters.set(currency, formatter);
  }
  return formatter.format(cents / 100);
}

/** Parses a user-entered dollar amount ("1,234.5") into integer cents, or null if invalid. */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export const centsToInput = (cents: number) => (cents / 100).toFixed(2);

/** Basis points to a percent string: 825 -> "8.25%". */
export const formatBps = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** Percent input ("8.25") to basis points (825), or null if invalid / out of range. */
export function parsePercentToBps(input: string): number | null {
  const value = Number(input);
  if (input.trim() === '' || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value * 100);
}

const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
const dateTimeFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** Accepts ISO timestamps or plain dates ("2026-12-31", rendered without timezone shifts). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return dateFormatter.format(date);
}

export const formatDateTime = (value: string) => dateTimeFormatter.format(new Date(value));

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
