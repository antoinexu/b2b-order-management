import { isMoneyCents } from './pricing';

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** Formats integer cents as currency, e.g. 123456 -> "$1,234.56". */
export function formatMoney(cents: number, currency = 'USD'): string {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    // Amounts are stored in hundredths, so always show two decimals, even for legacy data in other currencies.
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    moneyFormatters.set(currency, formatter);
  }
  return formatter.format(cents / 100);
}

/** Parses a user-entered dollar amount ("1,234.5") into integer cents, or null if invalid. */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return isMoneyCents(cents) ? cents : null;
}

/** Currencies whose minor unit is two decimals: the only ones the API accepts, since money is stored in hundredths. */
export const SUPPORTED_CURRENCIES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('currency').filter(
      (code) => new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits === 2,
    );
  } catch {
    return ['USD', 'EUR', 'GBP'];
  }
})();

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

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Current calendar date (YYYY-MM-DD) in an IANA time zone; matches the API's quote-validity rule. */
export function todayIn(timeZone: string, now = new Date()): string {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter.format(now);
}

/** The browser's IANA time zone, or UTC when the runtime can't tell. */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
