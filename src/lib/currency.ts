/**
 * Money is stored as integer hundredths (see pricing.ts), so only currencies whose minor unit is exactly
 * two decimal places can be represented faithfully. JPY (0 decimals) or KWD (3 decimals) would be shown
 * and charged at the wrong amount, so they are not accepted.
 */
const twoDecimalCurrencies = new Set(
  Intl.supportedValuesOf('currency').filter(
    (code) => new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits === 2,
  ),
);

export const isSupportedCurrency = (code: string) => twoDecimalCurrencies.has(code);
