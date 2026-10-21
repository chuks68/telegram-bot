/**
 * Settlement accounting and proportion formatting for settled markets.
 *
 * Computes each split bucket's share of the market's gross funds (challengers,
 * protocol fees, unallocated dust) using bigint fixed-point arithmetic with
 * two decimal places.
 */

import { formatUsdc } from "../stellar/decode.js";

export interface SettlementPayload {
  totalPaid?: bigint | number | string;
  totalFees?: bigint | number | string;
  owedToChallengers?: bigint | number | string;
  dust?: bigint | number | string;
  [key: string]: unknown;
}

export interface SettlementItem {
  label: string;
  amount: bigint;
  formattedAmount: string;
  percent: string;
}

function toBigInt(val: unknown): bigint {
  if (typeof val === "bigint") return val;
  if (typeof val === "number" && Number.isInteger(val)) return BigInt(val);
  if (typeof val === "string" && /^-?\d+$/.test(val.trim())) return BigInt(val.trim());
  return 0n;
}

/**
 * Compute the percentage of `amount` relative to `gross` using bigint fixed-point
 * arithmetic (two decimals), rounding half-up.
 *
 * Examples:
 * - 160M / 180M -> "88.89%"
 * - 20M / 180M  -> "11.11%"
 * - 0 / 180M    -> "0.00%"
 * - 0 / 0       -> "0.00%" (zero totals render safely without division errors)
 */
export function formatPercentage(amount: bigint, gross: bigint): string {
  if (gross <= 0n || amount <= 0n) {
    return "0.00%";
  }
  // BigInt fixed-point arithmetic with 2 decimal places (hundredths of a percent, scale 10,000):
  const basis = (amount * 10_000n + gross / 2n) / gross;
  const whole = basis / 100n;
  const frac = (basis % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}%`;
}

/**
 * Calculate the gross total and per-bucket proportions for a settled market.
 */
export function settlementBreakdown(payload: SettlementPayload): SettlementItem[] {
  const owed = toBigInt(payload.owedToChallengers);
  const fees = toBigInt(payload.totalFees);
  const dust = toBigInt(payload.dust);
  const sum = owed + fees + dust;
  const paid = payload.totalPaid !== undefined ? toBigInt(payload.totalPaid) : 0n;
  const gross = paid > sum ? paid : sum;

  return [
    {
      label: "Owed to challengers",
      amount: owed,
      formattedAmount: `${formatUsdc(owed)} USDC`,
      percent: formatPercentage(owed, gross),
    },
    {
      label: "Total fees",
      amount: fees,
      formattedAmount: `${formatUsdc(fees)} USDC`,
      percent: formatPercentage(fees, gross),
    },
    {
      label: "Dust",
      amount: dust,
      formattedAmount: `${formatUsdc(dust)} USDC`,
      percent: formatPercentage(dust, gross),
    },
  ];
}

/**
 * Return formatted lines showing labelled amounts and percentage of the gross.
 *
 * Example:
 * [
 *   "Owed to challengers: 16.0000000 USDC (88.89%)",
 *   "Total fees: 2.0000000 USDC (11.11%)",
 *   "Dust: 0.0000000 USDC (0.00%)"
 * ]
 */
export function settlementLines(payload: SettlementPayload): string[] {
  return settlementBreakdown(payload).map(
    (item) => `${item.label}: ${item.formattedAmount} (${item.percent})`,
  );
}
