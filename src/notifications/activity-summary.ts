import { escapeMd } from "./format.js";
import { formatUsdc } from "../stellar/decode.js";

export interface ActivityEvent {
  type: string;
  at: number;
  stake?: bigint;
  amount?: bigint;
  [key: string]: unknown;
}

export interface ActivityWindow {
  from: number;
  to: number;
}

export interface ActivitySummary {
  window: ActivityWindow;
  claimsCreated: number;
  claimsChallenged: number;
  claimsResolved: number;
  squadDeposits: number;
  squadWithdrawals: number;
  other: number;
  totalStake: bigint;
  totalDepositVolume: bigint;
}

const CLAIM_CREATED = "claim_created";
const CLAIM_CHALLENGED = "claim_challenged";
const CLAIM_RESOLVED = "claim_resolved";
const SQUAD_DEPOSIT = "squad_deposit";
const SQUAD_WITHDRAWAL = "squad_withdrawal";

export function buildActivitySummary(
  events: readonly ActivityEvent[],
  window: ActivityWindow,
): ActivitySummary {
  const summary: ActivitySummary = {
    window: { from: window.from, to: window.to },
    claimsCreated: 0,
    claimsChallenged: 0,
    claimsResolved: 0,
    squadDeposits: 0,
    squadWithdrawals: 0,
    other: 0,
    totalStake: 0n,
    totalDepositVolume: 0n,
  };

  for (const event of events) {
    if (event.at < window.from || event.at > window.to) {
      continue;
    }

    switch (event.type) {
      case CLAIM_CREATED:
        summary.claimsCreated += 1;
        if (typeof event.stake === "bigint") {
          summary.totalStake += event.stake;
        }
        break;
      case CLAIM_CHALLENGED:
        summary.claimsChallenged += 1;
        if (typeof event.stake === "bigint") {
          summary.totalStake += event.stake;
        }
        break;
      case CLAIM_RESOLVED:
        summary.claimsResolved += 1;
        if (typeof event.stake === "bigint") {
          summary.totalStake += event.stake;
        }
        break;
      case SQUAD_DEPOSIT:
        summary.squadDeposits += 1;
        if (typeof event.amount === "bigint") {
          summary.totalDepositVolume += event.amount;
        }
        break;
      case SQUAD_WITHDRAWAL:
        summary.squadWithdrawals += 1;
        break;
      default:
        summary.other += 1;
        break;
    }
  }

  return summary;
}

export function activitySummaryMessage(summary: ActivitySummary): string {
  const lines: string[] = [
    `"**Activity summary**"`,
    `Window: ${escapeMd(String(summary.window.from))} — ${escapeMd(String(summary.window.to))}`,
    `- Claims created: ${summary.claimsCreated}`,
    `- Claims challenged: ${summary.claimsChallenged}`,
    `- Claims resolved: ${summary.claimsResolved}`,
    `- Squad deposits: ${summary.squadDeposits}`,
    `- Squad withdrawals: ${summary.squadWithdrawals}`,
    `- Other events: ${summary.other}`,
    `- Total stake: ${escapeMd(formatUsdc(summary.totalStake))}`,
    `- Total deposit volume: ${escapeMd(formatUsdc(summary.totalDepositVolume))}`,
  ];

  return lines.join("\n");
}
