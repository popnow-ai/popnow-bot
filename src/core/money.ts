import { parseCredits } from "./credits.js";

/**
 * The PopNow API bills in exact USD from its own API balance. Amounts arrive as decimal strings
 * with up to nine decimal places ("0.0405"), so the bot keeps every amount as a whole number of
 * nanodollars (1 USD = 1,000,000,000): sums and comparisons are exact integer arithmetic and no
 * amount is ever parsed into a binary float. A safe integer still covers about $9 million.
 */
export type Usd = number;

export const NANOS_PER_USD = 1_000_000_000;
/** The deprecated credit unit: 1 credit = $0.001. */
export const NANOS_PER_CREDIT = 1_000_000;

const USD_DECIMAL = /^(-?)(\d+)(?:\.(\d{1,9}))?$/;

function parseDecimal(value: unknown, allowNegative: boolean): Usd | undefined {
  if (typeof value !== "string") return undefined;
  const match = USD_DECIMAL.exec(value.trim());
  if (!match) return undefined;
  const [, sign, whole, fraction = ""] = match;
  if (sign && !allowNegative) return undefined;
  const nanos = Number(whole) * NANOS_PER_USD + Number(fraction.padEnd(9, "0"));
  if (!Number.isSafeInteger(nanos)) return undefined;
  return sign && nanos !== 0 ? -nanos : nanos;
}

/** A non-negative USD decimal string such as "0.0405" (up to nine decimals, no exponent). */
export function parseUsd(value: unknown): Usd | undefined {
  return parseDecimal(value, false);
}

/** Like parseUsd, but a balance may be negative (an approved credit line in use). */
export function parseSignedUsd(value: unknown): Usd | undefined {
  return parseDecimal(value, true);
}

/** Converts a deprecated whole-credit amount into USD. */
export function creditsToUsd(value: unknown): Usd | undefined {
  const credits = parseCredits(value);
  if (credits === undefined) return undefined;
  const nanos = credits * NANOS_PER_CREDIT;
  return Number.isSafeInteger(nanos) ? nanos : undefined;
}

/** Same as parseUsd, but throws with a readable message. Used for configuration values. */
export function requireUsd(value: string, label: string): Usd {
  const trimmed = value.trim().replace(/^\$/, "");
  const parsed = parseUsd(trimmed);
  if (parsed === undefined) throw new Error(`${label} must be a US dollar amount such as 5 or 0.25 (got "${value}")`);
  return parsed;
}

/** The first readable USD string among the given fields: the exact amount, then legacy aliases. */
export function firstUsd(...values: unknown[]): Usd | undefined {
  for (const value of values) {
    const parsed = parseUsd(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** "$5.00", "$0.0405", "$1,250.50", "-$1.50". Every significant digit is kept, at least two decimals. */
export function formatUsd(nanos: Usd): string {
  if (!Number.isFinite(nanos) || Math.abs(nanos) >= Number.MAX_SAFE_INTEGER) return "an unknown amount";
  const sign = nanos < 0 ? "-" : "";
  const abs = Math.abs(Math.round(nanos));
  const whole = Math.floor(abs / NANOS_PER_USD);
  const fraction = String(abs % NANOS_PER_USD)
    .padStart(9, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${fraction}`;
}

/** "0.0405": the exact decimal string, for logs and for the API. */
export function usdString(nanos: Usd): string {
  const sign = nanos < 0 ? "-" : "";
  const abs = Math.abs(Math.round(nanos));
  const fraction = String(abs % NANOS_PER_USD).padStart(9, "0").replace(/0+$/, "");
  return `${sign}${Math.floor(abs / NANOS_PER_USD)}${fraction ? `.${fraction}` : ""}`;
}
