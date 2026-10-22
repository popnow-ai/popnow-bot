/**
 * PopNow prices everything in whole credits (1 credit = $0.001). Quotes, holds and final charges
 * all come back as integers, so the bot keeps every amount as an integer number of credits.
 */
export type Credits = number;

/** Reads a non-negative whole number of credits from a number or a digit string. */
export function parseCredits(value: unknown): Credits | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Same as parseCredits, but throws with a readable message. Used for configuration values. */
export function requireCredits(value: string, label: string): Credits {
  const parsed = parseCredits(value);
  if (parsed === undefined) throw new Error(`${label} must be a whole number of credits such as 100 (got "${value}")`);
  return parsed;
}

/** "1 credit", "25 credits". */
export function formatCredits(credits: Credits): string {
  const value = Math.max(0, Math.round(credits));
  return `${value.toLocaleString("en-US")} ${value === 1 ? "credit" : "credits"}`;
}
