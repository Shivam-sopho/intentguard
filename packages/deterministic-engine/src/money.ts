/**
 * Money primitives. Airwallex expresses amounts in MAJOR units (1000 = $1,000.00).
 * Internally we do all arithmetic on integer minor units (cents) so that
 * 0.1 + 0.2 style float drift can never move a reserve-floor decision.
 */

export type Currency = 'USD' | 'AUD' | 'GBP' | 'EUR' | 'CAD' | 'JPY' | 'HKD' | 'CNY' | 'SGD' | 'NZD' | 'CHF';

/** Currencies with zero decimal places in ISO 4217 (subset Airwallex simulation supports). */
const ZERO_DECIMAL = new Set<Currency>(['JPY']);

export function decimalsFor(currency: Currency): number {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

export class MoneyError extends Error {}

/**
 * Validate an Airwallex major-unit amount: finite, non-negative and with no more
 * precision than the currency allows (USD 120.5 ok, USD 120.555 rejected).
 */
export function assertMajorUnits(amount: unknown, currency: Currency = 'USD'): asserts amount is number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new MoneyError(`Amount must be a finite number in major units, got ${String(amount)}`);
  }
  if (amount < 0) throw new MoneyError(`Amount must be non-negative, got ${amount}`);
  const scale = 10 ** decimalsFor(currency);
  const scaled = amount * scale;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new MoneyError(`${amount} has more than ${decimalsFor(currency)} decimal places for ${currency}`);
  }
  // Guard against accidentally passing minor units (e.g. 100000 meaning $1,000.00).
  if (amount > 1_000_000_000) throw new MoneyError(`Amount ${amount} is implausibly large - minor units passed by mistake?`);
}

export function toMinor(amountMajor: number, currency: Currency = 'USD'): number {
  assertMajorUnits(amountMajor, currency);
  return Math.round(amountMajor * 10 ** decimalsFor(currency));
}

export function toMajor(amountMinor: number, currency: Currency = 'USD'): number {
  if (!Number.isInteger(amountMinor)) throw new MoneyError(`Minor units must be an integer, got ${amountMinor}`);
  return amountMinor / 10 ** decimalsFor(currency);
}

/** Signed variant used by the cash-flow projector (outflows are negative). */
export function signedToMinor(amountMajor: number, currency: Currency = 'USD'): number {
  return amountMajor < 0 ? -toMinor(-amountMajor, currency) : toMinor(amountMajor, currency);
}

/** Canonical fixed-point string used inside hashes: 1000 -> "1000.00". */
export function canonicalAmount(amountMajor: number, currency: Currency = 'USD'): string {
  const minor = toMinor(amountMajor, currency);
  const d = decimalsFor(currency);
  if (d === 0) return String(minor);
  const s = String(minor).padStart(d + 1, '0');
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
}

export function formatMoney(amountMajor: number, currency: Currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: decimalsFor(currency),
  }).format(amountMajor);
}
