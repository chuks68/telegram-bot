/**
 * Amount threshold filtering for notifications.
 *
 * Lets operators hide small deposits and challenges in busy chats.
 * Amounts are parsed as 7-decimal atomic USDC units (Stellar Asset Contract)
 * using integer arithmetic only (no floating point).
 */

import type { DecodedEvent } from "../stellar/decode.js";

/** Error thrown when a threshold string is negative, malformed, or invalid. */
export class InvalidThresholdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidThresholdError";
  }
}

/** Threshold configuration for event filtering. */
export interface AmountThresholds {
  /** Minimum stake for claim_challenged (market). 0 or unset means no filtering. */
  marketChallenge?: bigint;
  /** Minimum amount for deposited (squad). 0 or unset means no filtering. */
  squadDeposit?: bigint;
}

/**
 * Parses a decimal string representing a USDC amount into atomic 7-decimal units (bigint).
 *
 * For example:
 * - "1" -> 10_000_000n
 * - "0.5" -> 5_000_000n
 * - "0.0000001" -> 1n
 *
 * Rejects negative numbers, invalid decimal formatting, or excess decimal precision (> 7 places)
 * with an {@link InvalidThresholdError}.
 * Surrounding whitespace is trimmed.
 */
export function parseUsdcThreshold(text: string): bigint {
  if (typeof text !== "string") {
    throw new InvalidThresholdError(`Threshold must be a string, got ${typeof text}`);
  }

  const trimmed = text.trim();
  if (trimmed === "") {
    throw new InvalidThresholdError("Threshold cannot be empty");
  }

  if (trimmed.startsWith("-")) {
    throw new InvalidThresholdError(`Threshold cannot be negative: "${trimmed}"`);
  }

  if (trimmed.startsWith("+")) {
    throw new InvalidThresholdError(`Threshold cannot have leading '+': "${trimmed}"`);
  }

  // Must match integer or decimal with digits
  // Disallow leading '.' or trailing '.' without digits, disallow multiple '.'
  const parts = trimmed.split(".");
  if (parts.length > 2) {
    throw new InvalidThresholdError(`Malformed threshold: "${trimmed}"`);
  }

  const wholeStr = parts[0] ?? "";
  const fracStr = parts.length === 2 ? (parts[1] ?? "") : "";

  if (!/^\d+$/.test(wholeStr)) {
    throw new InvalidThresholdError(`Malformed integer part in threshold: "${trimmed}"`);
  }

  if (parts.length === 2 && (fracStr.length === 0 || !/^\d+$/.test(fracStr))) {
    throw new InvalidThresholdError(`Malformed fractional part in threshold: "${trimmed}"`);
  }

  if (fracStr.length > 7) {
    throw new InvalidThresholdError(
      `Threshold exceeds maximum USDC precision of 7 decimals: "${trimmed}"`,
    );
  }

  const whole = BigInt(wholeStr);
  const paddedFrac = fracStr.padEnd(7, "0");
  const frac = BigInt(paddedFrac);

  return whole * 10_000_000n + frac;
}

/**
 * Evaluates whether an event meets the configured amount thresholds.
 *
 * Filtering rules:
 * - market `claim_challenged`: passes if stake >= threshold (or threshold <= 0 / unset)
 * - squad `deposited`: passes if amount >= threshold (or threshold <= 0 / unset)
 * - other events: always pass
 */
export function meetsThreshold(
  event: DecodedEvent,
  thresholds?: AmountThresholds,
): boolean {
  if (!thresholds) {
    return true;
  }

  if (event.payload.name === "claim_challenged") {
    const minStake = thresholds.marketChallenge;
    if (minStake === undefined || minStake <= 0n) {
      return true;
    }
    return event.payload.stake >= minStake;
  }

  if (event.payload.name === "deposited") {
    const minAmount = thresholds.squadDeposit;
    if (minAmount === undefined || minAmount <= 0n) {
      return true;
    }
    return event.payload.amount >= minAmount;
  }

  return true;
}
