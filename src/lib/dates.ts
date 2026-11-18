/** True if `timeZone` is an IANA zone this runtime understands (e.g. "America/New_York", "UTC"). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Canonical spelling of a valid zone, so "utc" and "UTC" are stored the same way. */
export const canonicalTimeZone = (timeZone: string) => new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar date (YYYY-MM-DD) it currently is in `timeZone`. */
export function todayIn(timeZone: string, now = new Date()): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // en-CA formats dates as YYYY-MM-DD.
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, formatter);
  }
  return formatter.format(now);
}
