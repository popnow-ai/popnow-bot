/**
 * Credits (1 credit = $0.001) are the unit the API used before it switched to exact USD. The API
 * still sends integer credit fields next to the USD ones as a deprecated display projection, and
 * bot settings from version 0.1 were written in credits. The bot reads them only as fallbacks and
 * converts them to USD right away (see money.ts).
 *
 * @deprecated Use the USD amounts in money.ts.
 */
export type Credits = number;

/** Reads a non-negative whole number of credits from a number or a digit string. */
export function parseCredits(value: unknown): Credits | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Same as parseCredits, but throws with a readable message. Used for legacy configuration values. */
export function requireCredits(value: string, label: string): Credits {
  const parsed = parseCredits(value);
  if (parsed === undefined) throw new Error(`${label} must be a whole number of credits such as 100 (got "${value}")`);
  return parsed;
}
